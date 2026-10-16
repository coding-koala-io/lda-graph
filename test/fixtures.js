import {effectiveModel} from '../src/model.js';

export const KEY = '30000000000040008000000000000001';
export const GUID = '30000000-0000-4000-8000-000000000001';
export const ID = `${GUID}_en_Published`;
const properties = fields => Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, {type, index: type !== 'JSON', searchable: name === 'Heading'}]));
// Synthetic type model with built-in metadata and content interfaces.
export const MODEL = effectiveModel({
  languages: ['en', 'sv', 'en-US'], preset: 'next', useTypedFieldNames: true,
  links: {DEFAULT: {from: '_metadata.key', to: '_metadata.container'}},
  contentTypes: {
    _AssetItem: {abstract: true, contentType: ['_Item'], properties: properties({_assetMetadata: '_AssetMetadata'})},
    _ImageItem: {abstract: true, contentType: ['_AssetItem'], properties: properties({_imageMetadata: '_ImageMetadata'})},
    _Page: {abstract: true, contentType: ['_Content'], properties: properties({_pageMetadata: '_PageMetadata'})},
    _Component: {abstract: true, contentType: ['_Content'], properties: {}},
    _Media: {abstract: true, contentType: ['_Content', '_AssetItem'], properties: {}},
    _Image: {abstract: true, contentType: ['_Media', '_ImageItem'], properties: {}},
    ArticlePage: {abstract: false, contentType: ['_Page'], properties: properties({Heading: 'String!', MainBody: 'SearchableRichText', PlainBody: 'RichText', Related: 'ContentReference', ContentArea: '[_IContent!]', Tags: '[String!]', Number: 'Int', Rating: 'Float', Visible: 'Boolean', Unindexed: 'String', Payload: 'JSON'})},
    StandardPage: {abstract: false, contentType: ['_Page'], properties: properties({Heading: 'String'})},
    TeaserBlock: {abstract: false, contentType: ['_Component'], properties: properties({Heading: 'String'})},
  },
  propertyTypes: {
    _AssetMetadata: {properties: properties({fileSize: 'Float', mimeType: 'String', url: 'String'})},
    _ImageMetadata: {properties: properties({width: 'Int', height: 'Int'})},
    _PageMetadata: {properties: properties({visibleInMenu: 'Boolean'})},
    TeaserBlockProperty: {properties: properties({Heading: 'String'})},
  },
});
// Exercise abstract metadata definitions in the types payload.
for (const name of ['InstanceMetadata', 'MediaMetadata', 'ItemMetadata']) MODEL.propertyTypes[name].abstract = true;
MODEL.propertyTypes.MediaMetadata.base = 'InstanceMetadata';
MODEL.propertyTypes.ContentMetadata.properties.displayName.searchable = true;

export function document(overrides = {}) {
  const {metadata = {}, ...rest} = overrides;
  return {
    __typename: 'ArticlePage',
    _metadata: {__typename: 'InstanceMetadata', key: KEY, locale: 'en', version: '12', types: ['ArticlePage', '_Page', '_Content', '_Item'], displayName___searchable: 'Quick Article', status: 'Published', lastModified: '2026-10-13T08:15:30.123Z', created: '2026-10-01T00:00:00.000Z', path: ['root'], url: {__typename: 'ContentUrl', default: '/article', type: 'HIERARCHICAL'}, ...metadata},
    _itemMetadata: {key: KEY, displayName___searchable: 'Quick Article', lastModified: '2026-10-13T08:15:30.123Z', type: 'ArticlePage'},
    _rbac: ['r:Everyone:Read'],
    'Heading$$String___searchable': 'x Quick heading',
    MainBody: {__typename: 'SearchableRichText', 'html$$String': '<p>Résumé quick content</p>', 'json$$JSON___skip': '{"type":"root"}'},
    PlainBody: {__typename: 'RichText', 'html$$String': '<p>Stored only</p>', 'json$$JSON___skip': '{}'},
    Related: {__typename: 'ContentReference', 'key$$String': KEY, url: {__typename: 'ContentUrl', 'default$$String': '/related'}},
    ContentArea: [{__typename: 'TeaserBlock', _metadata: {__typename: 'ItemMetadata', key: 'blockkey', displayName___searchable: 'Teaser', displayOption___skip: 'wide'}, 'Heading$$String___searchable': 'Embedded heading'}],
    'Tags$$String': ['News', 'Technology'], 'Number$$Int': 7, 'Rating$$Float': 1.5, 'Visible$$Boolean': true,
    'Unindexed$$String___skip': 'secret unsearchable', 'Payload$$JSON___skip': {nested: true}, ...rest,
  };
}
export const stream = (...lines) => lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n';
export const index = (id = ID, doc = document(), options = {}) => stream({index: {_id: id, language_routing: 'en', _snapshotTime: '2026-10-13T08:15:30.123+00:00', ...options}}, doc);

// Query fixtures cover search, content lookup and string interpolation.
export const SEARCH = `query SearchProvider($limit: Int $searchPhrase: String $searchId: String){
  _Content(orderBy: { _ranking: RELEVANCE, _metadata: { displayName: ASC } } locale: ALL limit: $limit
    where: { _or: [
      { _metadata: { displayName: { boost: 10, match: $searchPhrase, synonyms: [ONE, TWO] } } }
      { _metadata: { displayName: { boost: 10, startsWith: $searchPhrase, synonyms: [ONE, TWO] } } }
      { _metadata: { types: { like: "%\${searchPhrase}%" } } }
      { _fulltext: { match: $searchPhrase, synonyms: [ONE, TWO] } }
      { _metadata: { key: { eq: $searchId } } } ] }){
    items { _metadata { __typename Name: displayName ContentType: types ContentGuid: key Language: locale } }
  }
}`;
export const GET_CONTENT = `query GetContentProvider($id: String, $version: String, $status: String) {
  _Content(locale: ALL
    where: { _metadata: { key: { eq: $id }, version: { eq: $version }, status: { eq: $status } } }
    orderBy: { _metadata: { lastModified: DESC } }
    variation: { include: ALL }) {
    item { _metadata { lastModified } }
  }
}`;
export const ARTICLE = `query ArticlePageQuery {
  ArticlePage(where: { _fulltext: { match: "x" }}, locale: en, limit: 10) {
    items { _id _metadata { key version locale } }
    total(all: true)
  }
}`;
export const CONTENT = `query _ContentQuery {
  _Content(where: {_and: [ { _metadata: { key: { eq: "3f2a...32hex" } } } , { _metadata: { status: { eq: "Published" } } }  ]}, limit: 2) {
    items { _id _metadata { key version locale } }
  }
}`;
export const ITEM = 'query _ItemQuery {\r\n_Item(limit:20,orderBy:{_itemMetadata:{displayName:ASC}},where:{_fulltext:{match: "q"}}){items{_itemMetadata{key} _itemMetadata{displayName}}}}';
