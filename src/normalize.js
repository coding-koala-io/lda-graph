/** Normalize CMS field names without changing their values. */
export function fieldName(key) {
  return key.replace(/___(searchable|skip)$/, '').replace(/\$\$[^$]+$/, '');
}

/** GUID equality accepts both N and D formats; other strings remain exact. */
export function comparable(value) {
  if (typeof value !== 'string') return value;
  const guid = value.replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(guid) && (/^[0-9a-f]{32}$/i.test(value) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    ? guid.toLowerCase() : value;
}

/** Traverse a dotted path through objects and lists, returning flattened leaves. */
export function valuesAt(value, path) {
  const parts = Array.isArray(path) ? path : path.split('.').filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(v => valuesAt(v, parts));
  if (!parts.length) return [value];
  if (value == null) return [];
  return valuesAt(value[parts[0]], parts.slice(1));
}

export function stripHtml(text) {
  return String(text).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

// Inspection is deliberately non-memoizing: queries never inflate the raw graph.
const rawProperty = {enumerable: true, configurable: true, get() { return JSON.parse(this.rawJson); }};

/** @returns {{raw: object, rawJson: string, normalized: object, searchable: string[], skipped: string[]}} */
export function normalizeDocument(raw, id, snapshotTime, locale) {
  const searchable = new Set();
  const skipped = new Set();
  function visit(value, path = '', blocked = false) {
    if (Array.isArray(value)) return value.map(v => visit(v, path, blocked));
    if (value == null || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const name = fieldName(key);
      const next = path ? `${path}.${name}` : name;
      const skip = blocked || key.endsWith('___skip');
      if (skip) skipped.add(next);
      if (!skip && (key.endsWith('___searchable') || name === 'displayName' || (value.__typename === 'SearchableRichText' && name === 'html'))) searchable.add(next);
      Object.defineProperty(result, name, {value: visit(child, next, skip), enumerable: true, writable: true, configurable: true});
    }
    return result;
  }
  const normalized = visit(raw);
  // Keep raw payloads for inspection, but never trust system-field shapes.
  if (!normalized._metadata || typeof normalized._metadata !== 'object' || Array.isArray(normalized._metadata)) normalized._metadata = {};
  const meta = normalized._metadata;
  for (const key of ['types', 'path', 'locales']) {
    if (!Array.isArray(meta[key]) || meta[key].some(v => typeof v !== 'string')) meta[key] = [];
  }
  for (const key of ['key', 'locale', 'status', 'expired', 'lastModified', 'variation', 'displayName', '__typename']) {
    if (meta[key] != null && typeof meta[key] !== 'string') delete meta[key];
  }
  if (!Array.isArray(normalized._rbac) || normalized._rbac.some(v => typeof v !== 'string')) delete normalized._rbac;
  if (typeof normalized.__typename !== 'string') delete normalized.__typename;
  if (normalized._metadata?.version != null) normalized._metadata.version = String(normalized._metadata.version);
  if (locale != null && normalized._metadata && !normalized._metadata.locale) normalized._metadata.locale = locale;
  Object.assign(normalized, {_id: id, _modified: snapshotTime ?? normalized._metadata?.lastModified ?? null, _deleted: !!normalized._deleted});
  const record = {normalized, searchable: [...searchable], skipped: [...skipped]};
  Object.defineProperty(record, 'rawJson', {value: JSON.stringify(raw), writable: true, configurable: true});
  Object.defineProperty(record, 'raw', rawProperty);
  return record;
}

export function fulltextValues(record) {
  return record.searchable.flatMap(path => valuesAt(record.normalized, path)).filter(v => typeof v === 'string').map(stripHtml);
}
