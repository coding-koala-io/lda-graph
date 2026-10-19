import {candidatesFor} from './indexes.js';
import {comparable, fulltextValues, valuesAt, stripHtml} from './normalize.js';
import {isAdditionalSourceDocument} from './content-sources.js';

export const QUERY_INFO = Symbol('queryInfo');
const list = value => Array.isArray(value) ? value : [value];
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const tokens = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
// String equality is case-insensitive: CMS content query variables
// use "published" for stored "Published".
const equal = (a, b) => {
  const left = comparable(a); const right = comparable(b);
  return typeof left === 'string' && typeof right === 'string' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const present = v => v != null && (!Array.isArray(v) || v.length > 0);
const numeric = v => typeof v === 'number' ? v : (typeof v === 'string' ? (/^\d{4}-\d\d-\d\d/.test(v) ? Date.parse(v) : Number(v)) : NaN);
const skipped = (record, path) => record.skipped.some(p => p === path || path.startsWith(`${p}.`));

function tokenScore(value, query) {
  const haystack = tokens(stripHtml(value));
  return tokens(query).filter(t => haystack.some(h => h.startsWith(t))).length;
}

/** Damerau-Levenshtein distance, including adjacent transpositions. */
export function editDistance(left, right) {
  const a = [...left]; const b = [...right];
  const table = Array.from({length: a.length + 2}, () => Array(b.length + 2).fill(0));
  const maximum = a.length + b.length;
  table[0][0] = maximum;
  for (let i = 0; i <= a.length; i++) { table[i + 1][0] = maximum; table[i + 1][1] = i; }
  for (let j = 0; j <= b.length; j++) { table[0][j + 1] = maximum; table[1][j + 1] = j; }
  const last = new Map();
  for (let i = 1; i <= a.length; i++) {
    let matched = 0;
    for (let j = 1; j <= b.length; j++) {
      const previousRow = last.get(b[j - 1]) ?? 0; const previousColumn = matched;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      if (!cost) matched = j;
      table[i + 1][j + 1] = Math.min(table[i][j] + cost, table[i + 1][j] + 1, table[i][j + 1] + 1,
        table[previousRow][previousColumn] + (i - previousRow - 1) + 1 + (j - previousColumn - 1));
    }
    last.set(a[i - 1], i);
  }
  return table[a.length + 1][b.length + 1];
}

function searchScore(value, query, op) {
  const haystack = tokens(stripHtml(value));
  if (op === 'wildcard') {
    const patterns = String(query).toLowerCase().match(/[\p{L}\p{N}_*?]+/gu) ?? [];
    return patterns.filter(pattern => {
      const regex = new RegExp(`^${escapeRegex(pattern).replaceAll('\\*', '.*').replaceAll('\\?', '.')}$`, 'u');
      return haystack.some(token => regex.test(token));
    }).length;
  }
  const needles = tokens(query);
  if (op === 'phrase') {
    return needles.length && haystack.some((_, i) => needles.every((token, j) => haystack[i + j] === token)) ? needles.length : 0;
  }
  return needles.filter(token => haystack.some(word => {
    const limit = [...token].length > 5 ? 2 : 1;
    return Math.abs([...token].length - [...word].length) <= limit && editDistance(token, word) <= limit;
  })).length;
}

/** Evaluate a scalar filter and return its match plus relevance contribution. */
export function matchFilter(value, filter) {
  if (!filter) return {match: true, score: 0};
  if (Array.isArray(value)) {
    if (filter.exist != null && !Object.entries(filter).some(([k, v]) => k !== 'exist' && !['boost', 'synonyms'].includes(k) && v != null)) return {match: present(value) === filter.exist, score: 0};
    const results = value.map(v => matchFilter(v, filter));
    return {match: results.some(r => r.match), score: Math.max(0, ...results.filter(r => r.match).map(r => r.score))};
  }
  let score = 0;
  for (const [op, expected] of Object.entries(filter)) {
    if (expected == null || ['boost', 'synonyms', 'factor', 'decay'].includes(op)) continue;
    const text = String(value ?? '').toLowerCase();
    const needle = String(expected).toLowerCase();
    let ok;
    switch (op) {
      case 'eq': ok = equal(value, expected); break;
      case 'notEq': ok = !equal(value, expected); break;
      case 'in': ok = list(expected).some(v => equal(value, v)); break;
      case 'notIn': ok = !list(expected).some(v => equal(value, v)); break;
      case 'exist': ok = present(value) === expected; break;
      case 'contains': ok = value != null && text.includes(needle); break;
      case 'startsWith': ok = value != null && text.startsWith(needle); break;
      case 'endsWith': ok = value != null && text.endsWith(needle); break;
      case 'like': ok = value != null && new RegExp(`^${escapeRegex(expected).replaceAll('%', '.*').replaceAll('_', '.')}$`, 'isu').test(String(value)); break;
      case 'wildcard': case 'phrase': case 'fuzzy': { const count = searchScore(value, expected, op); ok = value != null && count > 0; score += count; break; }
      case 'match': { const count = tokenScore(value, expected); ok = count > 0; score += count; break; }
      case 'gt': ok = value != null && numeric(value) > numeric(expected); break;
      case 'gte': ok = value != null && numeric(value) >= numeric(expected); break;
      case 'lt': ok = value != null && numeric(value) < numeric(expected); break;
      case 'lte': ok = value != null && numeric(value) <= numeric(expected); break;
      default: ok = true;
    }
    if (!ok) return {match: false, score: 0};
  }
  if (filter.factor && value != null) {
    let n = Number(value) * (filter.factor.value ?? 1);
    const modifiers = {LOG: Math.log10, LOG1P: v => Math.log10(v + 1), LOG2P: v => Math.log10(v + 2), LN: Math.log, LN1P: Math.log1p, LN2P: v => Math.log(v + 2), SQUARE: v => v * v, SQRT: Math.sqrt, RECIPROCAL: v => 1 / v};
    if (modifiers[filter.factor.modifier]) n = modifiers[filter.factor.modifier](n);
    score += Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  if (filter.decay && value != null) {
    const origin = numeric(filter.decay.origin ?? new Date().toISOString());
    const distance = Math.abs(numeric(value) - origin) / (typeof value === 'string' ? 86400000 : 1);
    const n = Math.pow(filter.decay.rate ?? 0.5, distance / Math.max(1, filter.decay.scale ?? 1000));
    score += Number.isFinite(n) ? n : 0;
  }
  return {match: true, score: score * (filter.boost ?? 1)};
}

const leafOps = new Set(['eq', 'notEq', 'in', 'notIn', 'exist', 'contains', 'startsWith', 'endsWith', 'like', 'match', 'phrase', 'wildcard', 'gt', 'gte', 'lt', 'lte', 'boost', 'synonyms', 'fuzzy', 'factor', 'decay']);

function meaningful(clause) {
  if (clause == null) return false;
  if (Array.isArray(clause)) return clause.length === 0 || clause.some(meaningful);
  if (typeof clause !== 'object') return true;
  return Object.entries(clause).some(([key, value]) => {
    if (value == null || ['boost', 'synonyms'].includes(key) || (key === 'fuzzy' && typeof value === 'boolean')) return false;
    return leafOps.has(key) || meaningful(value);
  });
}

/** Recursive where clauses retain array element boundaries for nested object predicates. */
export function matchWhere(value, where, record, path = '') {
  if (where == null) return {match: true, score: 0};
  if (Array.isArray(value)) {
    const results = value.map(v => matchWhere(v, where, record, path));
    return {match: results.some(r => r.match), score: Math.max(0, ...results.filter(r => r.match).map(r => r.score))};
  }
  let score = 0;
  for (const [key, clause] of Object.entries(where)) {
    if (!meaningful(clause)) continue;
    let result;
    if (['_and', '_or', '_not'].includes(key)) {
      const results = list(clause).filter(meaningful).map(v => matchWhere(value, v, record, path));
      result = {match: key === '_and' ? results.every(r => r.match) : key === '_or' ? results.some(r => r.match) : results.every(r => !r.match), score: key === '_not' ? 0 : results.filter(r => r.match).reduce((sum, r) => sum + r.score, 0)};
    } else if (key === '_fulltext') {
      const texts = fulltextValues(record);
      const results = texts.map(text => matchFilter(text, clause));
      result = {match: results.some(r => r.match), score: results.filter(r => r.match).reduce((sum, r) => sum + r.score, 0)};
    } else {
      const next = path ? `${path}.${key}` : key;
      if (skipped(record, next)) return {match: false, score: 0};
      const child = value?.[key];
      result = Object.keys(clause).some(k => leafOps.has(k)) ? matchFilter(child, clause) : matchWhere(child, clause, record, next);
    }
    if (!result.match) return {match: false, score: 0};
    score += result.score;
  }
  return {match: true, score};
}


// The all-field cache exceeded the measured heap budget. Retain only full-text
// token arrays, sharing common token strings through a bounded vocabulary.
const TOKEN_CACHE = Symbol('tokens');
const vocabulary = new Map();
function sharedTokens(text) {
  return tokens(text).map(word => {
    const found = vocabulary.get(word);
    if (found !== undefined) return found;
    if (vocabulary.size < 8192) vocabulary.set(word, word);
    return word;
  });
}
export function recordCache(record) {
  if (!record[TOKEN_CACHE]) Object.defineProperty(record, TOKEN_CACHE, {value: {}});
  return record[TOKEN_CACHE];
}
export function cachedFulltextTokens(record) {
  const cache = recordCache(record);
  return cache.fulltext ??= fulltextValues(record).map(text => sharedTokens(stripHtml(text)));
}
export function cachedFulltext(record) {
  const words = cachedFulltextTokens(record);
  return fulltextValues(record).map((text, i) => ({text, words: words[i]}));
}
function fieldWords(record, path, value, raw = false) {
  return tokens(raw ? value : stripHtml(value));
}
function compileSearch(expected, op) {
  const needles = tokens(expected);
  const patterns = op === 'wildcard' ? (String(expected).toLowerCase().match(/[\p{L}\p{N}_*?]+/gu) ?? []).map(pattern => new RegExp(`^${escapeRegex(pattern).replaceAll('\\*', '.*').replaceAll('\\?', '.')}$`, 'u')) : [];
  return words => {
    if (op === 'match') return needles.filter(t => words.some(h => h.startsWith(t))).length;
    if (op === 'wildcard') return patterns.filter(regex => words.some(word => regex.test(word))).length;
    if (op === 'phrase') return needles.length && words.some((_, i) => needles.every((t, j) => words[i + j] === t)) ? needles.length : 0;
    const unique = [...new Set(words)];
    return needles.filter(t => unique.some(word => {
      const limit = [...t].length > 5 ? 2 : 1;
      return Math.abs([...t].length - [...word].length) <= limit && editDistance(t, word) <= limit;
    })).length;
  };
}

/** Compile operator choices and query tokens once, retaining scalar/array semantics. */
export function compileFilter(filter) {
  if (!filter) return () => ({match: true, score: 0});
  const tests = Object.entries(filter).filter(([op, v]) => v != null && !['boost', 'synonyms', 'factor', 'decay'].includes(op)).map(([op, expected]) => {
    if (['match', 'phrase', 'wildcard', 'fuzzy'].includes(op)) {
      const score = compileSearch(expected, op);
      return (value, words) => { const count = score(words()); return {match: (op === 'match' || value != null) && count > 0, score: count}; };
    }
    // The scalar evaluator preserves coercion, date, null, and unknown-op behavior.
    const predicate = {
      eq: v => equal(v, expected), notEq: v => !equal(v, expected),
      in: v => list(expected).some(e => equal(v, e)), notIn: v => !list(expected).some(e => equal(v, e)),
      exist: v => present(v) === expected,
      contains: v => v != null && String(v).toLowerCase().includes(String(expected).toLowerCase()),
      startsWith: v => v != null && String(v).toLowerCase().startsWith(String(expected).toLowerCase()),
      endsWith: v => v != null && String(v).toLowerCase().endsWith(String(expected).toLowerCase()),
      gt: v => v != null && numeric(v) > numeric(expected), gte: v => v != null && numeric(v) >= numeric(expected),
      lt: v => v != null && numeric(v) < numeric(expected), lte: v => v != null && numeric(v) <= numeric(expected),
    }[op];
    if (op === 'like') {
      const regex = new RegExp(`^${escapeRegex(expected).replaceAll('%', '.*').replaceAll('_', '.')}$`, 'isu');
      return v => ({match: v != null && regex.test(String(v)), score: 0});
    }
    return v => ({match: predicate ? predicate(v) : true, score: 0});
  });
  const existOnly = filter.exist != null && !Object.entries(filter).some(([k, v]) => k !== 'exist' && !['boost', 'synonyms'].includes(k) && v != null);
  const modifiers = {LOG: Math.log10, LOG1P: v => Math.log10(v + 1), LOG2P: v => Math.log10(v + 2), LN: Math.log, LN1P: Math.log1p, LN2P: v => Math.log(v + 2), SQUARE: v => v * v, SQRT: Math.sqrt, RECIPROCAL: v => 1 / v};
  const modifier = modifiers[filter.factor?.modifier];
  const factorValue = filter.factor?.value ?? 1;
  const origin = filter.decay?.origin != null ? numeric(filter.decay.origin) : null;
  const scale = Math.max(1, filter.decay?.scale ?? 1000);
  const rate = filter.decay?.rate ?? 0.5;
  const extraScores = [];
  if (filter.factor) extraScores.push(value => {
    let n = Number(value) * factorValue;
    if (modifier) n = modifier(n);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  });
  if (filter.decay) extraScores.push(value => {
    const distance = Math.abs(numeric(value) - (origin ?? Date.now())) / (typeof value === 'string' ? 86400000 : 1);
    const n = Math.pow(rate, distance / scale);
    return Number.isFinite(n) ? n : 0;
  });
  const evaluate = (value, record, path, fullWords) => {
    if (Array.isArray(value)) {
      if (existOnly) return {match: present(value) === filter.exist, score: 0};
      let match = false; let score = 0;
      for (const v of value) { const r = evaluate(v, record, path); if (r.match) { match = true; score = Math.max(score, r.score); } }
      return {match, score};
    }
    let score = 0;
    const words = () => fullWords ?? (record ? fieldWords(record, path, value) : tokens(stripHtml(value)));
    for (const test of tests) { const r = test(value, words); if (!r.match) return {match: false, score: 0}; score += r.score; }
    if (value != null) for (const extra of extraScores) score += extra(value);
    return {match: true, score: score * (filter.boost ?? 1)};
  };
  return evaluate;
}

export function compileWhere(where, path = '') {
  if (where == null) return () => ({match: true, score: 0});
  const children = Object.entries(where).filter(([, clause]) => meaningful(clause)).map(([key, clause]) => {
    if (['_and', '_or', '_not'].includes(key)) {
      const predicates = list(clause).filter(meaningful).map(v => compileWhere(v, path));
      return (value, record) => {
        const results = predicates.map(predicate => predicate(value, record));
        return {match: key === '_and' ? results.every(r => r.match) : key === '_or' ? results.some(r => r.match) : results.every(r => !r.match),
          score: key === '_not' ? 0 : results.filter(r => r.match).reduce((sum, r) => sum + r.score, 0)};
      };
    }
    if (key === '_fulltext') {
      const predicate = compileFilter(clause);
      const tokenOnly = Object.entries(clause).every(([op, value]) => value == null || ['match', 'phrase', 'wildcard', 'fuzzy', 'boost', 'synonyms'].includes(op));
      return (_, record) => {
        let match = false; let score = 0;
        const wordsByText = cachedFulltextTokens(record);
        const texts = tokenOnly ? null : fulltextValues(record);
        for (let i = 0; i < wordsByText.length; i++) { const r = predicate(texts ? texts[i] : '', record, '_fulltext', wordsByText[i]); if (r.match) { match = true; score += r.score; } }
        return {match, score};
      };
    }
    const next = path ? `${path}.${key}` : key;
    const leaf = Object.keys(clause).some(k => leafOps.has(k));
    const predicate = leaf ? compileFilter(clause) : compileWhere(clause, next);
    return (value, record) => skipped(record, next) ? {match: false, score: 0} : leaf ? predicate(value?.[key], record, next) : predicate(value?.[key], record);
  });
  const evaluate = (value, record) => {
    if (Array.isArray(value)) {
      let match = false; let score = 0;
      for (const v of value) { const r = evaluate(v, record); if (r.match) { match = true; score = Math.max(score, r.score); } }
      return {match, score};
    }
    let score = 0;
    for (const child of children) { const r = child(value, record); if (!r.match) return {match: false, score: 0}; score += r.score; }
    return {match: true, score};
  };
  return evaluate;
}

function scoring(where) {
  if (!where || typeof where !== 'object') return false;
  return Object.entries(where).some(([k, v]) => v != null && (['match', 'phrase', 'wildcard', 'factor', 'decay'].includes(k) || (k === 'fuzzy' && typeof v === 'string') || scoring(v)));
}
function queryTerms(where, result = []) {
  if (!where || typeof where !== 'object') return result;
  for (const [k, v] of Object.entries(where)) {
    if (v != null && ['match', 'phrase', 'wildcard', 'fuzzy', 'startsWith'].includes(k)) result.push(...tokens(v));
    else if (typeof v === 'object') queryTerms(v, result);
  }
  return [...new Set(result)];
}

/** Keep caller field order, including the position of _ranking. */
export function flattenOrder(order, path = '', result = []) {
  for (const [key, value] of Object.entries(order ?? {})) {
    if (value == null || ['_minimumScore', '_semanticWeight'].includes(key)) continue;
    const next = path ? `${path}.${key}` : key;
    if (typeof value === 'object') flattenOrder(value, next, result);
    else result.push([next, value]);
  }
  return result;
}
function decoded(value) { try { return decodeURIComponent(value ?? ''); } catch { return value ?? ''; } }

function warnBadRecord(store, record, error) {
  store.badRecords ??= new WeakSet();
  if (record && typeof record === 'object' && !store.badRecords.has(record)) {
    store.badRecords.add(record);
    store.logger.error(`Skipping malformed document ${record.normalized?._id ?? '(unknown)'}: ${error.message}`);
  }
}

/** Shared by root queries and reference resolvers; preview never bypasses ACLs. */
export function visibleRecord(record, context, store) {
  try {
    const {headers = {}, auth = 'single'} = context;
    const doc = record.normalized; const meta = doc._metadata ?? {};
    const privilegedRead = auth === 'basic' || auth === 'preview';
    const acl = Array.isArray(doc._rbac) && doc._rbac.every(r => typeof r === 'string') ? doc._rbac : [];
    const published = meta.status === 'Published' || (meta.status == null && store && isAdditionalSourceDocument(doc, store.slot(context.slot).types));
    if (!privilegedRead && (!published || !acl.includes('r:Everyone:Read') || doc._deleted)) return false;
    if (privilegedRead && doc._deleted && headers['cg-include-deleted'] !== 'true') return false;
    if (auth === 'preview' || (auth === 'basic' && (headers['cg-roles'] != null || headers['cg-username'] != null))) {
      const roles = decoded(headers['cg-roles']).split(',').filter(Boolean);
      const username = decoded(headers['cg-username']);
      const permissions = ['r:Everyone:Read', ...roles.map(r => `r:${r}:Read`), ...(username ? [`u:${username}:Read`] : [])];
      if (!acl.some(r => permissions.includes(r))) return false;
    }
    if ((!privilegedRead || headers['cg-include-expired'] === 'false') && meta.expired && Date.parse(meta.expired) < Date.now()) return false;
    return true;
  } catch (error) { if (store) warnBadRecord(store, record, error); return false; }
}

function applyFacetFilters(records, filters, excludingPath) {
  return records.filter(({record, doc}) => filters.every(filter => filter.path === excludingPath ||
    (!skipped(record, filter.path) && valuesAt(doc, filter.path).some(value => {
      if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
      if (filter.ranges?.length) return filter.ranges.some(range => filter.values.includes(rangeName(range)) && inRange(value, range));
      return filter.values.some(expected => equal(String(value), expected));
    }))));
}
const rangeName = range => `${range.from ?? '*'}-${range.to ?? '*'}`;
const inRange = (value, range) => value != null && Number.isFinite(numeric(value)) && numeric(value) >= (range.from ?? -Infinity) && numeric(value) < (range.to ?? Infinity);

/** Apply the complete root-query pipeline before returning page + aggregation context. */
export function evaluateQuery(store, type, args, context) {
  const {slot = 'live'} = context;
  const locales = args.locale ? list(args.locale).map(v => v.replaceAll('_', '-').toLowerCase()) : [];
  const terms = queryTerms(args.where);
  let records = [];
  const docs = store.slot(slot).docs;
  const predicate = compileWhere(args.where);
  for (const id of candidatesFor(docs, type, args)) {
    const record = docs[id];
    try {
      if (!record?.normalized || !Array.isArray(record.searchable) || !Array.isArray(record.skipped)) throw new Error('Invalid normalized record');
      const doc = record.normalized;
      const meta = doc._metadata ?? {};
      if (!visibleRecord(record, context, store)) continue;
      if (locales.length && !locales.includes('all') && !locales.includes(String(meta.locale || 'neutral').toLowerCase())) continue;
      if (args.ids && !args.ids.some(id => equal(doc._id, id) || equal(meta.key, id))) continue;
      const variation = meta.variation;
      if ((!args.variation || args.variation.include === 'NONE') && variation) continue;
      if (args.variation?.include === 'SOME' && !(args.variation.value?.includes(variation) || (!variation && args.variation.includeOriginal))) continue;
      const result = predicate(doc, record);
      if (!result.match || (args.orderBy?._minimumScore != null && result.score < args.orderBy._minimumScore)) continue;
      const output = {...doc, _score: result.score};
      Object.defineProperty(output, QUERY_INFO, {value: {record, terms}});
      records.push({record, doc: output, score: result.score});
    } catch (error) { warnBadRecord(store, record, error); }
  }
  const facetRecords = records;
  const facetFilters = args.facetFilters ?? [];
  records = applyFacetFilters(records, facetFilters);
  const order = flattenOrder(args.orderBy);
  if (!order.length) order.push(...(scoring(args.where) ? [['_ranking', 'RELEVANCE']] : [['_metadata.lastModified', 'DESC']]), ['_id', 'ASC']);
  const scalarValue = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  for (const entry of records) entry.sortKeys = order.map(([path]) => path === '_ranking' || skipped(entry.record, path) ? undefined : scalarValue(valuesAt(entry.doc, path)[0]));
  records.sort((a, b) => {
    for (let i = 0; i < order.length; i++) {
      const [path, direction] = order[i];
      if (path === '_ranking') {
        if (direction !== 'DOC' && a.score !== b.score) return b.score - a.score;
        continue;
      }
      const av = a.sortKeys[i];
      const bv = b.sortKeys[i];
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      const comparison = av < bv ? -1 : av > bv ? 1 : 0;
      if (comparison) return direction === 'DESC' ? -comparison : comparison;
    }
    return 0;
  });
  for (const entry of records) delete entry.sortKeys;
  const total = records.length;
  let offset = Math.max(0, args.skip ?? 0);
  if (args.cursor != null) {
    try { offset = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()).offset; } catch { offset = 0; }
    if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  }
  const limit = Math.max(0, Math.min(10000, args.limit ?? 20));
  const items = records.slice(offset, offset + limit).map(r => r.doc);
  const cursor = limit > 0 && offset + limit < total ? Buffer.from(JSON.stringify({offset: offset + limit})).toString('base64url') : '';
  return {items, item: items[0] ?? null, total, cursor, records, facetRecords, facetFilters};
}

export function highlights(doc, highlight = {}) {
  const info = doc[QUERY_INFO];
  if (!info) return [];
  const entries = cachedFulltext(info.record);
  const score = compileSearch(info.terms.join(' '), 'match');
  const matched = entries.filter(entry => !info.terms.length || score(entry.words) > 0).map(entry => entry.text);
  if (highlight.enabled === false || !info.terms.length) return matched;
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(${info.terms.map(escapeRegex).join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  return matched.map(text => text.replace(regex, word => `${highlight.startToken ?? '<em>'}${word}${highlight.endToken ?? '</em>'}`));
}

export function facets(result, path, args) {
  const groups = new Map();
  function name(value) {
    if (!['string', 'number', 'boolean'].includes(typeof value) || value === '') return null;
    if (args.unit) {
      const ms = Date.parse(value);
      if (!Number.isFinite(ms)) return null;
      const interval = ({MINUTE: 60000, HOUR: 3600000, DAY: 86400000}[args.unit]) * Math.max(1, args.value ?? 1);
      return new Date(Math.floor(ms / interval) * interval).toISOString();
    }
    return String(value);
  }
  for (const {doc, record} of applyFacetFilters(result.facetRecords ?? result.records, result.facetFilters ?? [], path)) {
    if (skipped(record, path)) continue;
    const values = valuesAt(doc, path);
    const names = args.ranges?.length ? args.ranges.filter(range => values.some(v => inRange(v, range))).map(rangeName) : values.map(name);
    for (const n of new Set(names)) if (n != null) groups.set(n, (groups.get(n) ?? 0) + 1);
  }
  const direction = args.orderBy === 'ASC' ? 1 : -1;
  return [...groups].map(([name, count]) => ({name, count})).sort((a, b) => {
    const primary = args.orderType === 'VALUE' ? a.name.localeCompare(b.name, 'en', {numeric: true}) : a.count - b.count;
    return primary * direction || a.name.localeCompare(b.name);
  }).slice(0, Math.max(0, args.limit ?? 5));
}

export function autocomplete(result, path, args) {
  const needle = args.value.toLowerCase();
  const matches = new Set();
  for (const {doc, record} of result.records) for (const value of skipped(record, path) ? [] : valuesAt(doc, path)) {
    if (typeof value === 'string' && (value.toLowerCase().startsWith(needle) || fieldWords(record, path, value, true).some(t => t.startsWith(needle)))) matches.add(value);
  }
  return [...matches].slice(0, Math.max(0, args.limit ?? 10));
}
