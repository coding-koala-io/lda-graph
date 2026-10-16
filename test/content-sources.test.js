import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, success, BASIC} from './helpers.js';
import {MODEL, document, index, stream} from './fixtures.js';
import {A, preview, scratch} from './tenant-helpers.js';
import {mergeSourceModels} from '../src/content-sources.js';

const strings = names => Object.fromEntries(names.map(name => [name, {type: 'String'}]));
const CMP = {
  languages: ['de'], links: {EXTRA: {from: 'Id', to: 'Title'}},
  contentTypes: {
    cmp_Asset: {abstract: true, contentType: ['_Item'], properties: strings(['Id', 'Url', 'Title', 'AltText', 'MimeType'])},
    cmp_PublicImageAsset: {contentType: ['cmp_Asset', '_ImageItem'], properties: {Width: {type: 'Int'}, Height: {type: 'Int'}}},
  },
  propertyTypes: {},
};
const asset = (id, overrides = {}) => ({
  __typename: 'cmp_PublicImageAsset', _itemMetadata: {key: id, type: 'cmp_PublicImageAsset'},
  _assetMetadata: {mimeType: 'image/png', url: `/assets/${id}.png`, fileSize: 100},
  _imageMetadata: {width: 640, height: 480}, _rbac: ['r:Everyone:Read'],
  Id: id, Url: `/assets/${id}.png`, Title: `Image ${id}`, AltText: `Alt ${id}`, MimeType: 'image/png', Width: 640, Height: 480,
  ...overrides,
});
const batch = (...entries) => stream(...entries.flatMap(([id, doc]) => [{index: {_id: id}}, doc]));
const ASSETS = '{cmp_PublicImageAsset(where:{_itemMetadata:{key:{in:["one","two"]}}},orderBy:{_id:ASC}){items{Id Url Title Width}}}';
async function seed(t, options = {}) {
  const gw = await gateway(t, options);
  await gw.request('/api/content/v3/types', {method: 'PUT', body: MODEL});
  await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP});
  return gw;
}

test('source PUT/POST/GET keep models independent and list only sources with stored types', async t => {
  const gw = await gateway(t);
  assert.deepEqual((await gw.request('/api/content/v3/sources')).data, []);
  assert.equal((await gw.request('/api/content/v3/sources?id=default')).status, 404);
  await gw.request('/api/content/v3/types', {method: 'PUT', body: MODEL});
  assert.equal((await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP})).status, 200);
  assert.deepEqual((await gw.request('/api/content/v3/types?id=default')).data, MODEL);
  assert.deepEqual((await gw.request('/api/content/v3/types?id=cmp')).data, CMP);
  assert.deepEqual((await gw.request('/api/content/v3/sources?id=cmp')).data, {id: 'cmp', label: 'cmp', description: ''});
  assert.equal((await gw.request('/api/content/v3/sources?id=cmp')).status, 200);
  for (const endpoint of ['sources', 'types']) assert.equal((await gw.request(`/api/content/v3/${endpoint}?id=other`)).status, 404);
  assert.deepEqual((await gw.request('/api/content/v3/sources')).data.map(source => source.id), ['default', 'cmp']);
  const extra = {contentTypes: {cmp_EmptyAsset: {contentType: ['cmp_Asset'], properties: {Info: {type: 'cmp_Info'}}}}, propertyTypes: {cmp_Info: {properties: strings(['Label'])}}};
  assert.equal((await gw.request('/api/content/v3/types?id=cmp', {method: 'POST', body: extra})).status, 200);
  const stored = (await gw.request('/api/content/v3/types?id=cmp')).data;
  assert.deepEqual(stored.contentTypes, {...CMP.contentTypes, ...extra.contentTypes});
  assert.deepEqual(stored.propertyTypes, extra.propertyTypes);
  assert.deepEqual((await gw.request('/api/content/v3/types')).data, MODEL);
  assert.equal(success(await gw.gql('{cmp_EmptyAsset{total items{Info{Label}}}}'), 'cmp_EmptyAsset').total, 0);
  assert.equal(gw.server.tenants.get('default').schemas.live.getType('Locales').getValues().some(value => value.name === 'de'), false);
  const merged = mergeSourceModels(gw.server.store.state.types);
  assert.deepEqual(merged.languages, MODEL.languages); assert.deepEqual(merged.links, MODEL.links);
  await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP});
  assert.equal(gw.server.tenants.get('default').schemas.live.getType('cmp_EmptyAsset'), undefined);
});

test('two statusless source documents stream and query with Basic, single key and unconfigured public auth', async t => {
  const gw = await seed(t);
  const result = await gw.request('/_stream', {method: 'POST', body: batch(['cmp-one', asset('one')], ['cmp-two', asset('two')])});
  assert.equal(result.status, 200);
  assert.equal((await gw.request('/journal/stream/' + result.data.journalId)).data.errors, false);
  for (const auth of [BASIC, 'epi-single public', null]) {
    assert.deepEqual(success(await gw.gql(ASSETS, {}, {auth}), 'cmp_PublicImageAsset').items, [
      {Id: 'one', Url: '/assets/one.png', Title: 'Image one', Width: 640},
      {Id: 'two', Url: '/assets/two.png', Title: 'Image two', Width: 640},
    ]);
  }
  assert.equal(gw.server.store.state.docs['cmp-one'].normalized._metadata.status, undefined);
});

test('page reference item resolves a concrete additional source type for Basic and single key', async t => {
  const gw = await seed(t);
  const model = structuredClone(MODEL);
  model.contentTypes.ArticlePage.properties.PageImage = {type: 'ContentReference'};
  await gw.request('/api/content/v3/types', {method: 'PUT', body: model});
  await gw.request('/_stream', {method: 'POST', body: batch(['cmp-one', asset('one')]) + index('page', document({PageImage: {
    key: 'one', url: {default: '/assets/one.png', graph: 'graph://cmp/cmp_PublicImageAsset/one', type: 'GRAPH'}, item: 'cmp-one',
  }}))});
  const query = '{ArticlePage(ids:["page"]){item{PageImage{item{... on cmp_PublicImageAsset{Id Url}}}}}}';
  for (const auth of [BASIC, 'epi-single public']) assert.deepEqual(success(await gw.gql(query, {}, {auth}), 'ArticlePage').item.PageImage.item, {Id: 'one', Url: '/assets/one.png'});
  gw.server.store.upsert('cmp-one', asset('one', {_rbac: ['r:Editors:Read']}));
  assert.equal(success(await gw.gql(query, {}, {auth: 'epi-single public'}), 'ArticlePage').item.PageImage.item, null);
});

test('source visibility preserves explicit statuses, ACLs, expiry, deletion, Basic and preview behavior', async t => {
  const gw = await seed(t);
  const entries = [
    ['public', asset('public')], ['draft', asset('draft', {_metadata: {status: 'Draft'}})],
    ['private', asset('private', {_rbac: ['r:Editors:Read']})], ['missing-acl', asset('missing-acl', {_rbac: undefined})],
    ['expired', asset('expired', {_metadata: {expired: '2000-01-01'}})], ['deleted', asset('deleted', {_deleted: true})],
    ['blank-status', asset('blank-status', {_metadata: {status: ''}})],
  ];
  await gw.request('/_stream', {method: 'POST', body: batch(...entries) + index('cms-no-status', document({metadata: {status: undefined}}))});
  const query = '{cmp_PublicImageAsset(orderBy:{_id:ASC}){items{Id}}}';
  const ids = async options => success(await gw.gql(query, {}, options), 'cmp_PublicImageAsset').items.map(doc => doc.Id);
  assert.deepEqual(await ids({auth: 'epi-single public'}), ['public']);
  assert.equal((await ids({})).length, 6);
  assert.equal((await ids({headers: {'cg-include-deleted': 'true'}})).length, 7);
  assert.equal((await ids({headers: {'cg-roles': 'Editors'}})).length, 5);
  assert.equal((await ids({auth: preview(A)})).length, 5);
  assert.equal(success(await gw.gql('{ArticlePage{total}}', {}, {auth: 'epi-single public'}), 'ArticlePage').total, 0);
});

test('default definitions win content/property and cross-kind clashes with one warning per rebuild', async t => {
  const warnings = []; const errors = [];
  const gw = await seed(t, {logger: {log() {}, warn: message => warnings.push(message), error: message => errors.push(message)}});
  const extra = structuredClone(CMP);
  extra.contentTypes.ArticlePage = {properties: {Heading: {type: 'Int'}}};
  extra.propertyTypes.ContentUrl = {properties: {default: {type: 'Int'}}};
  extra.propertyTypes.StandardPage = {properties: {Wrong: {type: 'Int'}}};
  extra.contentTypes.RichText = {properties: {Wrong: {type: 'Int'}}};
  await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: extra});
  assert.equal(warnings.length, 1); assert.match(warnings[0], /default.*cmp:ArticlePage/);
  assert.deepEqual(errors, []);
  await gw.request('/_stream', {method: 'POST', body: index('page')});
  assert.equal(success(await gw.gql('{ArticlePage{item{Heading Related{url{default}} PlainBody{html}}}}'), 'ArticlePage').item.Heading, 'x Quick heading');
  assert.equal(gw.server.tenants.get('default').schemas.live.getQueryType().getFields().RichText, undefined);
  assert.equal(gw.server.tenants.get('default').schemas.live.getType('StandardPage').getFields().Wrong, undefined);
  assert.equal(warnings.length, 1, 'Queries do not repeat the rebuild warning');
  gw.server.tenants.get('default').rebuild(); assert.equal(warnings.length, 2);
  await gw.request('/_doc/no-status', {method: 'POST', body: document({metadata: {status: undefined}})});
  assert.equal(success(await gw.gql('{ArticlePage(ids:["no-status"]){total}}', {}, {auth: 'epi-single public'}), 'ArticlePage').total, 0);
});

test('source reset removes only matching source types/documents and types mode preserves documents', async t => {
  const gw = await seed(t);
  await gw.request('/api/content/v3/types?id=other', {method: 'PUT', body: {contentTypes: {OtherAsset: {properties: strings(['Id'])}}}});
  await gw.request('/_stream', {method: 'POST', body: batch(['cmp-one', asset('one')], ['by-types', asset('by-types', {__typename: undefined, _metadata: {types: ['cmp_PublicImageAsset']}})], ['other', {__typename: 'OtherAsset', Id: 'other'}]) + index('page')});
  assert.equal((await gw.request('/api/content/v3/sources?id=cmp&mode=types', {method: 'DELETE'})).status, 200);
  assert.ok(gw.server.store.state.docs['cmp-one']);
  assert.equal((await gw.request('/api/content/v3/sources?id=cmp')).status, 404);
  assert.deepEqual((await gw.request('/api/content/v3/types')).data, MODEL);
  await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP});
  assert.equal((await gw.request('/api/content/v3/sources?id=cmp&mode=reset', {method: 'DELETE'})).status, 200);
  assert.deepEqual(Object.keys(gw.server.store.state.docs).sort(), ['other', 'page']);
  assert.deepEqual((await gw.request('/api/content/v3/types')).data, MODEL);
  assert.equal((await gw.request('/api/content/v3/types?id=cmp')).status, 404);
  assert.equal((await gw.request('/api/content/v3/sources?id=other')).status, 200);
  assert.ok((await gw.gql('{cmp_PublicImageAsset{total}}')).errors);
  assert.equal(success(await gw.gql('{ArticlePage{total}}'), 'ArticlePage').total, 1);
  await gw.request('/api/content/v3/sources?id=missing&mode=reset', {method: 'DELETE'});
  assert.deepEqual(Object.keys(gw.server.store.state.docs).sort(), ['other', 'page']);
});

test('each slot merges its own sources and reset leaves other slots intact', async t => {
  const gw = await seed(t);
  await gw.request('/_stream', {method: 'POST', body: batch(['live-asset', asset('live')]) + index('live-page')});
  await gw.gql('mutation{deployNewAccountVersion}');
  const headers = {'cg-deploy-new': 'true'};
  await gw.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP, headers});
  assert.ok((await gw.gql('{cmp_PublicImageAsset{total}}', {}, {headers: {'cg-query-new': 'true'}})).errors, 'Additional sources require a default model for the schema');
  await gw.request('/api/content/v3/types', {method: 'PUT', body: MODEL, headers});
  await gw.request('/_stream', {method: 'POST', body: batch(['new-asset', asset('new')]) + index('new-page'), headers});
  const query = '{cmp_PublicImageAsset{items{Id}}}';
  assert.deepEqual(success(await gw.gql(query), 'cmp_PublicImageAsset').items, [{Id: 'live'}]);
  assert.deepEqual(success(await gw.gql(query, {}, {headers: {'cg-query-new': 'true'}, auth: 'epi-single public'}), 'cmp_PublicImageAsset').items, [{Id: 'new'}]);
  await gw.gql('mutation{useNewAccountVersion}');
  await gw.request('/api/content/v3/sources?id=cmp&mode=reset', {method: 'DELETE'});
  assert.deepEqual(Object.keys(gw.server.store.state.docs), ['new-page']);
  assert.ok(gw.server.store.state.slots.old.docs['live-asset']);
  await gw.gql('mutation{useOldAccountVersion}');
  assert.deepEqual(success(await gw.gql(query), 'cmp_PublicImageAsset').items, [{Id: 'live'}]);
});

test('per-source types persist across restart with live and pending merged schemas', async t => {
  const dataDir = scratch(t);
  const first = await seed(t, {dataDir});
  await first.request('/_stream', {method: 'POST', body: batch(['cmp-one', asset('one')], ['cmp-two', asset('two')])});
  await first.request('/api/content/v3/types', {method: 'PUT', body: MODEL, headers: {'cg-deploy-new': 'true'}});
  await first.request('/api/content/v3/types?id=cmp', {method: 'PUT', body: CMP, headers: {'cg-deploy-new': 'true'}});
  await new Promise((resolve, reject) => first.server.close(error => error ? reject(error) : resolve()));
  const second = await gateway(t, {dataDir});
  assert.deepEqual((await second.request('/api/content/v3/types')).data, MODEL);
  assert.deepEqual((await second.request('/api/content/v3/types?id=cmp')).data, CMP);
  assert.equal(success(await second.gql(ASSETS, {}, {auth: 'epi-single public'}), 'cmp_PublicImageAsset').items.length, 2);
  assert.equal(success(await second.gql('{cmp_PublicImageAsset{total}}', {}, {headers: {'cg-query-new': 'true'}}), 'cmp_PublicImageAsset').total, 0);
});

test('dashboard sources count type membership once and explorer includes empty types from every source', async t => {
  const gw = await seed(t);
  await gw.request('/api/content/v3/types?id=cmp', {method: 'POST', body: {contentTypes: {cmp_EmptyAsset: {contentType: ['cmp_Asset'], properties: {}}}}});
  await gw.request('/_stream', {method: 'POST', body: batch(['cmp-one', asset('one', {_metadata: {types: ['cmp_PublicImageAsset', 'cmp_Asset', '_Item']}})], ['cmp-two', asset('two')]) + index('page')});
  const stats = (await gw.request('/tenants/default/stats', {auth: null})).data;
  assert.deepEqual(stats.sources.find(source => source.id === 'cmp'), {id: 'cmp', contentTypes: 3, docs: 2});
  const html = (await gw.request('/tenants/default', {auth: null})).data;
  assert.match(html, /<h3>Sources<\/h3>/);
  const table = /<div id="source-table">([\s\S]*?)<\/table>/.exec(html)[1];
  assert.match(table, /<td>cmp<\/td><td><span class="number">3<\/span><\/td><td><span class="number">2<\/span>/);
  const explorer = (await gw.request('/explorer?tenant=default', {auth: null})).data;
  assert.match(explorer, /cmp_EmptyAsset/);
  assert.match(explorer, />cmp_PublicImageAsset<\/a><\/td><td><span class="number">2<\/span>/);
});
