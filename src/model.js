const props = fields => Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, {type}]));
const metadata = props({key: 'String', locale: 'String', fallbackForLocale: 'String', version: 'String', displayName: 'String', url: 'ContentUrl', types: '[String]', published: 'DateTime', expired: 'DateTime', status: 'String', changeset: 'String', container: 'String', created: 'DateTime', createdBy: 'String', lastModified: 'DateTime', lastModifiedBy: 'String', locales: '[String]', path: '[String]', sortOrder: 'Int', variation: 'String'});

/** Built-ins keep startup queries usable before the CMS pushes its model. */
export function effectiveModel(model = {}) {
  const contentTypes = {
    _Item: {abstract: true, properties: props({_itemMetadata: '_ItemMetadata'})},
    _Content: {abstract: true, contentType: ['_Item'], properties: props({_metadata: 'IContentMetadata', _rbac: '[String]'})},
    ...model.contentTypes,
  };
  const propertyTypes = {
    ContentUrl: {properties: props({type: 'String', default: 'String', hierarchical: 'String', internal: 'String', graph: 'String', base: 'String'})},
    ContentMetadata: {abstract: true, properties: metadata},
    InstanceMetadata: {base: 'ContentMetadata', properties: props({owner: 'String', routeSegment: 'String'})},
    MediaMetadata: {base: 'InstanceMetadata', properties: props({mimeType: 'String', thumbnail: 'String', content: 'String'})},
    ItemMetadata: {base: 'ContentMetadata', properties: props({displayOption: 'String'})},
    _ItemMetadata: {properties: props({key: 'String', displayName: 'String', lastModified: 'DateTime', type: 'String'})},
    RichText: {properties: props({html: 'String', json: 'JSON'})},
    SearchableRichText: {properties: props({html: 'String', json: 'JSON'})},
    ContentReference: {properties: {...props({key: 'String', url: 'ContentUrl'}), item: {type: 'IData', ref: {type: 'Data', id: '_id'}}}},
    Link: {properties: props({url: 'ContentUrl', title: 'String', text: 'String', target: 'String'})},
    Data: {abstract: true, properties: props({_id: 'String'})},
    ...model.propertyTypes,
  };
  // The wire client marks these abstract; concrete metadata objects are required
  // here so its stored __typename survives GraphQL's interface resolution.
  for (const name of ['InstanceMetadata', 'MediaMetadata', 'ItemMetadata']) {
    propertyTypes[name] = {...propertyTypes[name], abstract: false, base: propertyTypes[name].base ?? 'ContentMetadata'};
  }
  propertyTypes.ContentMetadata = {...propertyTypes.ContentMetadata, abstract: true};
  propertyTypes.Data = {...propertyTypes.Data, abstract: true};
  return {...model, contentTypes, propertyTypes};
}
