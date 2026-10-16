import {
  GraphQLSchema, GraphQLObjectType, GraphQLInterfaceType, GraphQLInputObjectType,
  GraphQLEnumType, GraphQLScalarType, GraphQLString, GraphQLInt, GraphQLFloat,
  GraphQLBoolean, GraphQLList, GraphQLNonNull, valueFromASTUntyped, validateSchema,
  isListType, isNonNullType, isObjectType, isInterfaceType,
} from 'graphql';
import {effectiveModel} from './model.js';
import {evaluateQuery, highlights, facets, autocomplete, visibleRecord} from './query-engine.js';
import {collectFields} from 'graphql/execution/collectFields.js';
import {getArgumentValues} from 'graphql/execution/values.js';

/** CMS interface naming, preserving leading underscore. */
export const interfaceName = name => name.startsWith('_') ? `_I${name.slice(1)}` : `I${name}`;
export function sanitizeName(name) {
  let result = String(name).replace(/[^_0-9A-Za-z]/g, '_');
  if (!/^[_A-Za-z]/.test(result)) result = `_${result}`;
  if (result.startsWith('__')) result = `_${result.replace(/^_+/, '')}`;
  return result || '_Unnamed';
}
const scalar = (name, serialize = value => value) => new GraphQLScalarType({name, serialize, parseValue: value => value, parseLiteral: node => valueFromASTUntyped(node)});
const parseJSONOutput = value => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { /* ordinary JSON string */ } }
  return value;
};
const JSONScalar = scalar('JSON');
const DateTime = scalar('DateTime', value => value instanceof Date ? value.toISOString() : String(value));
const DateScalar = scalar('Date', value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
const primitives = {String: GraphQLString, Int: GraphQLInt, Float: GraphQLFloat, Boolean: GraphQLBoolean, DateTime, Date: DateScalar, JSON: JSONScalar};
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const INVALID = Symbol('invalidOutput');

/** Match the declared output type before graphql-js serialization can fail. */
function coerceOutput(value, type) {
  if (isNonNullType(type)) return coerceOutput(value, type.ofType);
  if (value == null) return null;
  if (isListType(type)) {
    return (Array.isArray(value) ? value : [value]).map(item => coerceOutput(item, type.ofType)).filter(item => item !== INVALID);
  }
  if (isObjectType(type) || isInterfaceType(type)) return typeof value === 'object' && !Array.isArray(value) ? value : INVALID;
  if (type === GraphQLInt || type === GraphQLFloat) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return INVALID;
    const number = Number(value);
    if (!Number.isFinite(number) || (type === GraphQLInt && (!Number.isInteger(number) || number < -2147483648 || number > 2147483647))) return INVALID;
    return number;
  }
  if (type === GraphQLBoolean) return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : INVALID;
  if (type === GraphQLString) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (type === JSONScalar) return parseJSONOutput(value);
  try { return type.serialize(value); } catch { return INVALID; }
}

/** Build a valid schema or retain the last valid one. This boundary never throws. */
export function buildSchema(model, store, {previous, logger = console, onMutation = () => {}} = {}) {
  try {
    const schema = constructSchema(effectiveModel(model), store, onMutation);
    const errors = validateSchema(schema);
    if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
    return schema;
  } catch (error) {
    logger.error(`Schema rebuild rejected: ${error.message}`);
    return previous ?? constructSchema(effectiveModel(), store, onMutation);
  }
}

function constructSchema(model, store, onMutation) {
  const used = new Set(Object.keys(primitives));
  function name(preferred) {
    const base = sanitizeName(preferred);
    let candidate = base; let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate); return candidate;
  }
  const enumType = (preferred, values) => new GraphQLEnumType({name: name(preferred), values: Object.fromEntries(values.map(v => [v, {value: v}]))});
  const OrderBy = enumType('OrderBy', ['ASC', 'DESC']);
  const Ranking = enumType('Ranking', ['RELEVANCE', 'SEMANTIC', 'BOOST_ONLY', 'DOC']);
  const OrderType = enumType('OrderType', ['COUNT', 'VALUE']);
  const DateUnit = enumType('DateUnit', ['MINUTE', 'HOUR', 'DAY']);
  const SynonymSlot = enumType('SynonymSlot', ['ONE', 'TWO']);
  const Variation = enumType('Variation', ['ALL', 'SOME', 'NONE']);
  const FactorModifier = enumType('FactorModifier', ['NONE', 'LOG', 'LOG1P', 'LOG2P', 'LN', 'LN1P', 'LN2P', 'SQUARE', 'SQRT', 'RECIPROCAL']);
  const languages = [...new Set(['ALL', 'NEUTRAL', 'en', ...list(model.languages).map(sanitizeName)])];
  const Locales = enumType('Locales', languages);
  const input = (preferred, fields) => new GraphQLInputObjectType({name: name(preferred), fields});
  const HighlightInput = input('HighlightInput', {enabled: {type: GraphQLBoolean}, startToken: {type: GraphQLString}, endToken: {type: GraphQLString}});
  const FactorInput = input('FactorInput', {value: {type: GraphQLFloat}, modifier: {type: FactorModifier}});
  const DecayInput = input('DecayInput', {origin: {type: DateTime}, scale: {type: GraphQLInt}, rate: {type: GraphQLFloat}});
  const RangeInput = input('RangeInput', {from: {type: GraphQLFloat}, to: {type: GraphQLFloat}});
  const VariationInput = input('VariationInput', {include: {type: Variation}, value: {type: new GraphQLList(GraphQLString)}, includeOriginal: {type: GraphQLBoolean}});
  const PinnedInput = input('PinnedInput', {phrase: {type: GraphQLString}, collections: {type: new GraphQLList(GraphQLString)}});
  const commonFilter = {exist: {type: GraphQLBoolean}, boost: {type: GraphQLInt}};
  function filter(preferred, type, string = false, number = false) {
    return input(preferred, {
      eq: {type}, notEq: {type}, in: {type: new GraphQLList(type)}, notIn: {type: new GraphQLList(type)}, ...commonFilter,
      ...(string ? Object.fromEntries(['like', 'contains', 'startsWith', 'endsWith', 'match', 'phrase', 'wildcard', 'fuzzy'].map(k => [k, {type: GraphQLString}])) : {}),
      ...(string ? {synonyms: {type: new GraphQLList(SynonymSlot)}} : {}),
      ...(number ? {...Object.fromEntries(['gt', 'gte', 'lt', 'lte'].map(k => [k, {type}])), factor: {type: FactorInput}, decay: {type: DecayInput}} : {}),
    });
  }
  const StringFilter = filter('StringFilterInput', GraphQLString, true);
  const leafFilters = {
    String: StringFilter, Int: filter('IntFilterInput', GraphQLInt, false, true), Float: filter('FloatFilterInput', GraphQLFloat, false, true),
    Boolean: filter('BooleanFilterInput', GraphQLBoolean), DateTime: filter('DateFilterInput', DateTime, false, true), Date: filter('DateOnlyFilterInput', DateScalar, false, true),
    JSON: filter('JSONFilterInput', JSONScalar),
  };
  const SearchableStringFilter = input('SearchableStringFilterInput', {
    match: {type: GraphQLString}, phrase: {type: GraphQLString}, wildcard: {type: GraphQLString}, fuzzy: {type: GraphQLString}, boost: {type: GraphQLInt}, synonyms: {type: new GraphQLList(SynonymSlot)},
  });
  const Facet = new GraphQLObjectType({name: name('Facet'), fields: {name: {type: GraphQLString}, count: {type: GraphQLInt}}});
  const facetArgs = {filters: {type: new GraphQLList(GraphQLString)}, limit: {type: GraphQLInt, defaultValue: 5}, orderType: {type: OrderType}, orderBy: {type: OrderBy}, ranges: {type: new GraphQLList(RangeInput)}, unit: {type: DateUnit}, value: {type: GraphQLInt}};

  // Canonical definitions and aliases are separate from allocated GraphQL names.
  const defs = new Map(); const aliases = new Map(); const canonicalNames = new Set();
  for (const [kind, entries] of [['content', model.contentTypes], ['property', model.propertyTypes]]) {
    for (const [raw, definition] of Object.entries(entries ?? {})) {
      const clean = sanitizeName(raw);
      if (canonicalNames.has(clean) || Object.hasOwn(primitives, raw)) continue;
      canonicalNames.add(clean);
      const def = {...definition, raw, clean, kind, graphName: name(definition.abstract ? interfaceName(clean) : clean)};
      defs.set(raw, def); aliases.set(raw, raw);
      if (definition.abstract) aliases.set(interfaceName(raw), raw);
    }
  }
  function bases(def) {
    return [...new Set([...list(def.contentType), ...list(def.base), ...(def.kind === 'content' ? ['Data'] : [])])].map(b => aliases.get(b) ?? b).filter(b => defs.has(b) && b !== def.raw);
  }
  function ancestors(key, seen = new Set()) {
    if (seen.has(key)) return [];
    seen.add(key);
    return [...new Set(bases(defs.get(key)).flatMap(b => [b, ...ancestors(b, seen)]))].filter(b => b !== key);
  }
  function properties(key, seen = new Set()) {
    if (seen.has(key)) return {};
    seen.add(key);
    const def = defs.get(key);
    const all = Object.assign({}, ...bases(def).map(b => properties(b, new Set(seen))), def.properties ?? {});
    if (def.kind === 'content') {
      all._metadata = {type: 'IContentMetadata'};
      all._itemMetadata ??= {type: '_ItemMetadata'};
      Object.assign(all, {_id: {type: 'String'}, _modified: {type: 'DateTime'}, _score: {type: 'Float'}, _track: {type: 'String'}, _deleted: {type: 'Boolean'}});
    }
    const result = {};
    for (const [raw, property] of Object.entries(all)) {
      const clean = sanitizeName(raw);
      if (!Object.hasOwn(result, clean)) result[clean] = {raw, ...(typeof property === 'string' ? {type: property} : property)};
    }
    return result;
  }
  function descriptor(raw) {
    const type = String(raw ?? 'JSON').replaceAll('!', '').trim();
    if (type.startsWith('[') && type.endsWith(']')) return {list: true, ...descriptor(type.slice(1, -1))};
    return {key: aliases.get(type), scalar: Object.hasOwn(primitives, type) ? type : undefined};
  }
  const outputs = new Map(); const fallback = new Map(); const inputs = new Map(); const aggregates = new Map();
  function declaredOutputType(raw) {
    const text = String(raw ?? 'JSON').replaceAll('!', '').trim();
    if (text.startsWith('[') && text.endsWith(']')) return new GraphQLList(declaredOutputType(text.slice(1, -1)));
    const d = descriptor(text);
    return d.key ? output(d.key) : primitives[d.scalar] ?? JSONScalar;
  }
  function resolvedOutput(value, type, object, context, field) {
    const sources = context.outputSources ??= new WeakMap();
    const parent = sources.get(object) ?? {id: object?._id ?? '(embedded)', path: ''};
    const path = parent.path ? `${parent.path}.${field}` : field;
    let result;
    try { result = coerceOutput(value, type); } catch { result = INVALID; }
    // Warn once per document/field, including successful shape repairs.
    if (value != null && (result === INVALID || JSON.stringify(value) !== JSON.stringify(result))) {
      const warnings = store.outputWarnings ??= new Set();
      const warningKey = JSON.stringify([context.slot ?? 'live', parent.id, path]);
      if (!warnings.has(warningKey)) {
        warnings.add(warningKey);
        (store.logger.warn ?? store.logger.error).call(store.logger, `Output coercion: document ${parent.id}, field ${path}`);
      }
    }
    const remember = child => {
      if (Array.isArray(child)) child.forEach(remember);
      else if (child && typeof child === 'object') sources.set(child, child._id ? {id: child._id, path: ''} : {id: parent.id, path});
    };
    if (result === INVALID) return null;
    remember(result);
    return result;
  }
  function output(key) {
    if (outputs.has(key)) return outputs.get(key);
    const def = defs.get(key);
    const interfaces = () => ancestors(key).filter(b => defs.get(b).abstract).map(output);
    const fields = () => {
      const result = {};
      for (const [field, prop] of Object.entries(properties(key))) {
        const type = declaredOutputType(prop.type);
        result[field] = {type, resolve: (object, args, context) => {
          if (field === '_track') return null;
          const value = object?.[prop.raw];
          if (!prop.ref) {
            return resolvedOutput(value, type, object, context, prop.raw);
          }
          const resolveReference = id => {
            if (typeof id !== 'string') return null;
            const docs = store.slot(context.slot).docs;
            const record = Object.hasOwn(docs, id) ? docs[id] : null;
            return record && visibleRecord(record, context, store) ? record.normalized : null;
          };
          return resolvedOutput(Array.isArray(value) ? value.map(resolveReference) : resolveReference(value), type, object, context, prop.raw);
        }};
      }
      if (def.kind === 'content') result._fulltext = {type: new GraphQLList(GraphQLString), args: {highlight: {type: HighlightInput}}, resolve: (doc, args) => highlights(doc, args.highlight ?? {})};
      if (!Object.keys(result).length) result._empty = {type: JSONScalar, resolve: () => null};
      return result;
    };
    let type;
    if (def.abstract) {
      type = new GraphQLInterfaceType({name: def.graphName, fields, interfaces, resolveType: (object, context, info) => {
        const raw = aliases.get(object.__typename);
        const candidate = raw && outputs.get(raw);
        if (candidate instanceof GraphQLObjectType && info.schema.isSubType(type, candidate)) return candidate.name;
        if (key === 'ContentMetadata' && !object.__typename) return output('InstanceMetadata').name;
        return fallback.get(key).name;
      }});
      outputs.set(key, type);
      // Every interface has a fallback, including interfaces without implementers.
      fallback.set(key, new GraphQLObjectType({name: name(`_${def.clean.replace(/^_/, '')}Generic`), fields, interfaces: () => [type, ...interfaces()]}));
    } else {
      type = new GraphQLObjectType({name: def.graphName, fields, interfaces}); outputs.set(key, type);
    }
    return type;
  }
  for (const key of defs.keys()) output(key);

  function where(key) {
    const cacheKey = `where:${key}`;
    if (inputs.has(cacheKey)) return inputs.get(cacheKey);
    const type = input(`${defs.get(key).clean}WhereInput`, () => {
      const fields = {_and: {type: new GraphQLList(type)}, _or: {type: new GraphQLList(type)}, _not: {type: new GraphQLList(type)}};
      for (const [field, prop] of Object.entries(properties(key))) {
        if (prop.index === false || prop.raw === '_track') continue;
        const d = descriptor(prop.type);
        fields[field] = {type: d.key ? where(d.key) : leafFilters[d.scalar] ?? leafFilters.JSON};
      }
      if (defs.get(key).kind === 'content') fields._fulltext = {type: SearchableStringFilter};
      return fields;
    });
    inputs.set(cacheKey, type); return type;
  }
  function order(key) {
    const cacheKey = `order:${key}`;
    if (inputs.has(cacheKey)) return inputs.get(cacheKey);
    const type = input(`${defs.get(key).clean}OrderByInput`, () => {
      const fields = {_ranking: {type: Ranking}, _semanticWeight: {type: GraphQLFloat}, _minimumScore: {type: GraphQLFloat}};
      for (const [field, prop] of Object.entries(properties(key))) {
        const d = descriptor(prop.type);
        fields[field] = {type: d.key ? order(d.key) : OrderBy};
      }
      return fields;
    });
    inputs.set(cacheKey, type); return type;
  }
  function aggregation(key, mode) {
    const cacheKey = `${mode}:${key}`;
    if (aggregates.has(cacheKey)) return aggregates.get(cacheKey);
    const type = new GraphQLObjectType({name: name(`${defs.get(key).clean}${mode === 'facet' ? 'Facet' : 'Autocomplete'}`), fields: () => {
      const fields = {};
      for (const [field, prop] of Object.entries(properties(key))) {
        const d = descriptor(prop.type);
        if (d.key) fields[field] = {type: aggregation(d.key, mode), extensions: {raw: prop.raw}, resolve: parent => ({result: parent.result, path: parent.path ? `${parent.path}.${prop.raw}` : prop.raw})};
        else if (mode === 'facet' ? d.scalar && d.scalar !== 'JSON' : d.scalar === 'String') {
          fields[field] = {
            type: new GraphQLList(mode === 'facet' ? Facet : GraphQLString),
            args: mode === 'facet' ? facetArgs : {value: {type: new GraphQLNonNull(GraphQLString)}, limit: {type: GraphQLInt, defaultValue: 10}},
            extensions: {raw: prop.raw},
            resolve: (parent, args) => (mode === 'facet' ? facets : autocomplete)(parent.result, parent.path ? `${parent.path}.${prop.raw}` : prop.raw, args),
          };
        }
      }
      if (!Object.keys(fields).length) fields._empty = {type: new GraphQLList(GraphQLString), resolve: () => []};
      return fields;
    }});
    aggregates.set(cacheKey, type); return type;
  }
  const queryFields = {};
  for (const [key, def] of defs) if (def.kind === 'content') {
    const type = output(key);
    const rootOutput = new GraphQLObjectType({name: name(`${def.clean}Output`), fields: {
      items: {type: new GraphQLList(type)}, item: {type}, total: {type: GraphQLInt, args: {all: {type: GraphQLBoolean}}}, cursor: {type: GraphQLString},
      facets: {type: aggregation(key, 'facet'), resolve: result => ({result, path: ''})},
      autocomplete: {type: aggregation(key, 'autocomplete'), resolve: result => ({result, path: ''})},
    }});
    queryFields[def.clean] = {type: rootOutput, args: {
      where: {type: where(key)}, locale: {type: new GraphQLList(Locales)}, variation: {type: VariationInput}, limit: {type: GraphQLInt, defaultValue: 20}, skip: {type: GraphQLInt, defaultValue: 0}, cursor: {type: GraphQLString}, orderBy: {type: order(key)}, ids: {type: new GraphQLList(GraphQLString)}, pinned: {type: PinnedInput}, track: {type: GraphQLString},
    }, resolve: (_, args, context, info) => {
      // graphql-js coerces input objects in schema order. Recover the wire order
      // for orderBy, whose field position has semantic meaning in this protocol.
      const node = info.fieldNodes[0].arguments?.find(a => a.name.value === 'orderBy');
      if (node) {
        const variables = {...info.variableValues, ...context.variables};
        for (const definition of info.operation.variableDefinitions ?? []) {
          if (definition.defaultValue && !Object.hasOwn(context.variables ?? {}, definition.variable.name.value)) variables[definition.variable.name.value] = valueFromASTUntyped(definition.defaultValue);
        }
        args = {...args, orderBy: valueFromASTUntyped(node.value, variables)};
      }
      const facetFilters = [];
      // Use GraphQL's field collection/coercion so aliases, fragments, variables,
      // and @skip/@include have the same meaning as actual facet execution.
      function collectFacetFilters(parentType, selectionSets, path = '') {
        const grouped = new Map();
        for (const selectionSet of selectionSets) {
          const fields = collectFields(info.schema, info.fragments, info.variableValues, parentType, selectionSet);
          for (const [responseName, nodes] of fields) grouped.set(responseName, [...(grouped.get(responseName) ?? []), ...nodes]);
        }
        for (const nodes of grouped.values()) {
          const fieldName = nodes[0].name.value;
          const field = parentType.getFields()[fieldName];
          if (!field || fieldName === '__typename') continue;
          const raw = field.extensions.raw ?? fieldName;
          const next = path ? `${path}.${raw}` : raw;
          if (field.args.some(a => a.name === 'filters')) {
            const facetArgs = getArgumentValues(field, nodes[0], info.variableValues);
            if (facetArgs.filters?.length) facetFilters.push({path: next, values: facetArgs.filters, ranges: facetArgs.ranges});
          } else if (field.type instanceof GraphQLObjectType) {
            collectFacetFilters(field.type, nodes.filter(n => n.selectionSet).map(n => n.selectionSet), next);
          }
        }
      }
      for (const rootNode of info.fieldNodes) {
        const selected = collectFields(info.schema, info.fragments, info.variableValues, rootOutput, rootNode.selectionSet);
        for (const nodes of selected.values()) if (nodes[0].name.value === 'facets') {
          collectFacetFilters(aggregation(key, 'facet'), nodes.map(n => n.selectionSet));
        }
      }
      return evaluateQuery(store, key, {...args, facetFilters}, context);
    }};
  }
  const mutationFields = {};
  for (const mutation of ['deployNewAccountVersion', 'useNewAccountVersion', 'useOldAccountVersion', 'abandonSlot']) mutationFields[mutation] = {
    type: GraphQLString, ...(mutation !== 'abandonSlot' ? {args: {languages: {type: new GraphQLList(GraphQLString)}}} : {}),
    resolve: (_, args, context) => {
      if (context.auth !== 'basic') throw new Error('Basic authentication is required for mutations');
      const result = store.mutate(mutation); onMutation(); return result;
    },
  };
  return new GraphQLSchema({query: new GraphQLObjectType({name: name('Query'), fields: queryFields}), mutation: new GraphQLObjectType({name: name('Mutation'), fields: mutationFields}), types: [...outputs.values(), ...fallback.values()]});
}
