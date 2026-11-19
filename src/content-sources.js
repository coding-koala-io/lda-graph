/** Combine source definitions without changing any stored model. */
export function mergeSourceModels(sources, onConflict = () => {}) {
  if (!Object.hasOwn(sources, 'default')) return undefined;
  const model = {...sources.default, contentTypes: {...sources.default.contentTypes}, propertyTypes: {...sources.default.propertyTypes}};
  const names = new Set([...Object.keys(model.contentTypes), ...Object.keys(model.propertyTypes)]);
  for (const [source, extra] of Object.entries(sources)) {
    if (source === 'default') continue;
    for (const kind of ['contentTypes', 'propertyTypes']) for (const [name, definition] of Object.entries(extra[kind] ?? {})) {
      if (names.has(name)) { onConflict(source, name); continue; }
      Object.defineProperty(model[kind], name, {value: definition, enumerable: true, writable: true, configurable: true});
      names.add(name);
    }
  }
  return model;
}

export const isCms12Document = doc => !doc._metadata?.types?.length && Array.isArray(doc.ContentType) &&
  doc.ContentLink != null && typeof doc.ContentLink === 'object' && !Array.isArray(doc.ContentLink);

/** CMS 12's Content base also belongs to the shared _Content root. */
export function documentTypeHierarchy(doc) {
  const types = doc._metadata?.types;
  if (Array.isArray(types) && types.length) return types;
  if (!isCms12Document(doc)) return [];
  return doc.ContentType.includes('Content') ? [...doc.ContentType, '_Content'] : doc.ContentType;
}

export function documentHasType(doc, names) {
  return names.has(doc.__typename) || documentTypeHierarchy(doc).some(type => names.has(type));
}

/** Default definitions retain ownership of names shared with another source. */
export function isAdditionalSourceDocument(doc, sources) {
  const defaults = sources.default;
  const belongs = name => !Object.hasOwn(defaults?.contentTypes ?? {}, name) && !Object.hasOwn(defaults?.propertyTypes ?? {}, name) &&
    Object.entries(sources).some(([id, model]) => id !== 'default' && Object.hasOwn(model.contentTypes ?? {}, name));
  return [doc.__typename, ...(doc._metadata?.types ?? [])].some(name => typeof name === 'string' && belongs(name));
}
