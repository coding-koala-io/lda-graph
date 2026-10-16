import {MODEL, GET_CONTENT, index, stream} from './fixtures.js';

// Small invented site: shared IDs deliberately exercise tenant isolation.
export const HOME_GUID = '10000000-0000-4000-8000-000000000001';
export const HOME_KEY = HOME_GUID.replaceAll('-', '');
export const HOME_ID = `${HOME_GUID}_en_Published`;
export const JOB_ID = '20000000-0000-4000-8000-000000000001';
const guid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = n => guid(n).replaceAll('-', '');
const id = (n, locale = 'en') => `${guid(n)}_${locale}_Published`;
const modified = '2026-01-02T12:00:00.000Z';

export const TYPES = structuredClone(MODEL);
Object.assign(TYPES.contentTypes, {
  HomePage: {contentType: ['_Page'], properties: {Keywords: {type: '[String]', index: false}, ContentArea: {type: '[_IContent]'}}},
  CardBlock: {contentType: ['_Component'], properties: {Heading: {type: 'String', searchable: true}, Image: {type: 'ContentReference'}}},
  PictureMedia: {contentType: ['_Image'], properties: {}},
  FileMedia: {contentType: ['_Media'], properties: {}},
  _Folder: {abstract: true, contentType: ['_Content'], properties: {}},
  ContentFolder: {contentType: ['_Folder'], properties: {}},
});

function content(n, type, bases, name, locale = 'en', fields = {}) {
  const url = locale ? `/${locale}/${name.toLowerCase()}/` : `/assets/${name.toLowerCase()}`;
  return {__typename: type, _rbac: ['r:Everyone:Read'],
    _metadata: {__typename: bases.includes('_Media') ? 'MediaMetadata' : 'InstanceMetadata',
      key: key(n), locale, version: '3', types: [type, ...bases, '_Content', '_Item'],
      displayName___searchable: name, status: 'Published', lastModified: modified,
      path: [HOME_KEY, key(n)], locales: locale ? [locale] : [],
      url: {__typename: 'ContentUrl', default: url, hierarchical: url,
        internal: `cms://content/${key(n)}?loc=${locale}&ver=3`, type: 'HIERARCHICAL'}},
    _itemMetadata: {key: key(n), displayName___searchable: name, lastModified: modified, type}, ...fields};
}
const cards = [7, 8, 9].map(n => ({__typename: 'CardBlock',
  _metadata: {__typename: 'ItemMetadata', key: key(n + 20), displayOption___skip: 'wide'},
  'Heading$$String___searchable': `Picture ${n - 6}`,
  Image: {__typename: 'ContentReference', 'key$$String': key(n),
    url: {__typename: 'ContentUrl', 'default$$String': `/assets/picture-${n - 6}.png`}, item: id(n, '')}}));
const home = content(1, 'HomePage', ['_Page'], 'Home', 'en', {
  'Keywords$$String___skip': ['welcome', 'overview'], ContentArea: cards});
home._metadata.url.default = '/en/';
const translated = content(1, 'HomePage', ['_Page'], 'Home', 'sv');
const draft = structuredClone(home);
draft._metadata.status = 'Draft'; draft._metadata.version = '4'; draft._rbac = ['r:Editors:Read'];

export const DOCUMENTS = [
  [HOME_ID, home], [id(1, 'sv'), translated], [`${HOME_GUID}_4_en_Draft`, draft],
  [id(2), content(2, 'ArticlePage', ['_Page'], 'About', 'en', {'Heading$$String___searchable': 'About our site'})],
  [id(3), content(3, 'ArticlePage', ['_Page'], 'News', 'en', {'Heading$$String___searchable': 'Latest news'})],
  [id(4), content(4, 'CardBlock', ['_Component'], 'Welcome card', 'en', {
    'Heading$$String___searchable': 'Welcome', Image: cards[0].Image})],
  ...[7, 8, 9].map(n => [id(n, ''), content(n, 'PictureMedia', ['_Image', '_Media', '_ImageItem', '_AssetItem'], `Picture-${n - 6}.png`, '', {
    _assetMetadata: {fileSize: 128, mimeType: 'image/png', url: `/assets/picture-${n - 6}.png`},
    _imageMetadata: {width: 320, height: 200}})]),
  [id(10, ''), content(10, 'FileMedia', ['_Media', '_AssetItem'], 'Guide.txt', '', {
    _assetMetadata: {fileSize: 12, mimeType: 'text/plain', url: '/assets/guide.txt'}})],
  [id(11, ''), content(11, 'ContentFolder', ['_Folder'], 'Assets', '')],
];
const temporary = [
  [id(12), content(12, 'ArticlePage', ['_Page'], 'Retired')],
  [id(13), content(13, 'ArticlePage', ['_Page'], 'Obsolete')],
];
const batch = (docs, timestamp) => docs.map(([docId, doc]) => index(docId, doc, {
  language_routing: doc._metadata.locale, _snapshotTime: timestamp})).join('');
export const STREAM_INITIAL = batch([...DOCUMENTS, ...temporary], '2026-01-02T12:00:00Z');
export const STREAM_UPDATE = batch(DOCUMENTS, '2026-01-02T12:00:01Z');
export const STREAM_REMOVE = stream(
  {delete: {_id: id(12), _hardDeleted: true, _snapshotTime: '2026-01-02T12:00:02Z'}},
  {delete_by_paths: {_hardDeleted: true, _snapshotTime: '2026-01-02T12:00:02Z'}},
  {paths: [['_metadata.key', key(13)], ['_metadata.version', '3'], ['_metadata.locale', 'en']]});
export const CONTENT_QUERY = {query: GET_CONTENT, variables: {id: HOME_KEY, version: '3', status: 'published'}};
export const journalBody = journalId => ({id: JOB_ID, details: [{id: journalId, status: 'Processing'}]});

// Request factories bind journal URLs to IDs returned by the running server.
export const REQUESTS = [
  {method: 'GET', url: '/api/content/v3/types?id=default', status: 404},
  {method: 'PUT', url: '/api/content/v3/types', body: TYPES},
  {method: 'POST', url: '/api/content/v3/types', body: {languages: ['en', 'sv']}},
  {method: 'POST', url: '/_stream', body: STREAM_INITIAL, results: Array(13).fill('created')},
  {method: 'POST', url: '/_stream', body: STREAM_UPDATE, results: Array(11).fill('updated')},
  {method: 'POST', url: '/_stream', body: STREAM_REMOVE, results: ['deleted', 'deleted']},
  {method: 'POST', url: '/content/v2', body: CONTENT_QUERY},
  {method: 'POST', url: '/content/v2', body: {...CONTENT_QUERY, variables: JSON.stringify(CONTENT_QUERY.variables)}},
  {method: 'PUT', url: '/api/content/v3/types', body: TYPES},
  {method: 'POST', url: '/_stream', body: STREAM_UPDATE, results: Array(11).fill('updated')},
  {method: 'POST', url: '/journal/indexing', body: journalBody},
  {method: 'GET', url: () => `/journal/indexing/${JOB_ID}/status`},
  {method: 'GET', url: journalId => `/journal/stream/${journalId}`},
];
