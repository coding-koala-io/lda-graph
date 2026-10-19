import {comparable, valuesAt} from './normalize.js';

export const indexedPaths = new Set(['_id', '_metadata.key', ...['default', 'hierarchical', 'internal', 'base'].map(name => `_metadata.url.${name}`)]);
export const indexValue = value => typeof comparable(value) === 'string' ? comparable(value).toLowerCase() : comparable(value);
const indexes = new WeakMap();
const blocked = (record, path) => record.skipped?.some(p => p === path || path.startsWith(`${p}.`));
function entries(record) {
  const doc = record?.normalized;
  if (!doc) return [];
  const result = [...new Set([doc.__typename, ...(Array.isArray(doc._metadata?.types) ? doc._metadata.types : [])])].filter(t => typeof t === 'string').map(t => [null, t]);
  for (const path of indexedPaths) if (!blocked(record, path)) {
    for (const value of valuesAt(doc, path)) if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) result.push([path, indexValue(value)]);
  }
  return result;
}

/** A docs container owns its index; slot swaps and replacement containers need no repair. */
export function getIndex(docs) {
  let index = indexes.get(docs);
  if (!index) {
    index = {byType: new Map(), byValue: new Map(), sequence: new Map(), idsUnindexed: new Set(), malformed: new Map(), next: 0};
    indexes.set(docs, index);
    for (const id of Object.keys(docs)) updateIndex(docs, id, null, docs[id]);
  }
  return index;
}
export function updateIndex(docs, id, before, after) {
  const index = indexes.get(docs);
  if (!index) return; // First query builds it lazily.
  index.malformed.delete(id);
  if (after && !after.normalized) index.malformed.set(id, after);
  const mapFor = path => path === null ? index.byType : (index.byValue.get(path) ?? (index.byValue.set(path, new Map()), index.byValue.get(path)));
  for (const [path, value] of entries(before)) {
    const map = mapFor(path); const ids = map.get(value);
    ids?.delete(id); if (!ids?.size) map.delete(value);
  }
  index.idsUnindexed.delete(id);
  if (after && (blocked(after, '_id') || blocked(after, '_metadata.key'))) index.idsUnindexed.add(id);
  if (!after) index.sequence.delete(id);
  else {
    if (!index.sequence.has(id)) index.sequence.set(id, index.next++);
    for (const [path, value] of entries(after)) {
      const map = mapFor(path);
      if (!map.has(value)) map.set(value, new Set());
      map.get(value).add(id);
    }
  }
}

/** Object.keys puts array-index keys first, followed by string insertion order. */
export function orderedCandidates(index, candidates, docs) {
  if (candidates.size > index.sequence.size / 4) return Object.keys(docs).filter(id => candidates.has(id));
  const integer = id => String(Number(id) >>> 0) === id && Number(id) < 4294967295;
  return [...candidates].sort((a, b) => integer(a) ? (integer(b) ? Number(a) - Number(b) : -1) : integer(b) ? 1 : index.sequence.get(a) - index.sequence.get(b));
}

export function candidatesFor(docs, type, args, onMalformed) {
  const index = getIndex(docs);
  if (onMalformed) for (const record of index.malformed.values()) onMalformed(record);
  let candidates = index.byType.get(type) ?? new Set();
  const hits = (path, values) => new Set(values.flatMap(v => [...(index.byValue.get(path)?.get(indexValue(v)) ?? [])]));
  const intersect = other => { const [small, large] = candidates.size < other.size ? [candidates, other] : [other, candidates]; candidates = new Set([...small].filter(id => large.has(id))); };
  if (args.ids) intersect(new Set([...hits('_id', args.ids), ...hits('_metadata.key', args.ids), ...index.idsUnindexed]));
  function visit(where, path = '') {
    if (!where || typeof where !== 'object' || Array.isArray(where)) return;
    for (const [key, clause] of Object.entries(where)) {
      if (key === '_and') { for (const child of Array.isArray(clause) ? clause : [clause]) visit(child, path); continue; }
      if (key === '_or' || key === '_not' || !clause || typeof clause !== 'object' || Array.isArray(clause)) continue;
      const next = path ? `${path}.${key}` : key;
      if (indexedPaths.has(next)) {
        for (const op of ['eq', 'in']) if (clause[op] != null) {
          const values = op === 'in' && Array.isArray(clause[op]) ? clause[op] : [clause[op]];
          if (values.every(v => v == null || ['string', 'number', 'boolean'].includes(typeof v))) intersect(hits(next, values));
        }
      }
      if (!Object.keys(clause).some(k => ['eq', 'notEq', 'in', 'notIn', 'exist', 'contains', 'startsWith', 'endsWith', 'like', 'match', 'phrase', 'wildcard', 'gt', 'gte', 'lt', 'lte', 'boost', 'synonyms', 'fuzzy', 'factor', 'decay'].includes(k))) visit(clause, next);
    }
  }
  visit(args.where);
  return orderedCandidates(index, candidates, docs);
}
