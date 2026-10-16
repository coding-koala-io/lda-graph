import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, success, BASIC} from './helpers.js';
import {MODEL, KEY, GUID, ID, document, stream, index, SEARCH, GET_CONTENT, ARTICLE, CONTENT, ITEM} from './fixtures.js';

test('startup model GET/PUT/POST, minimal schema, source and purge endpoints', async t => {
  const {request, gql, server} = await gateway(t);
  assert.equal((await request('/api/content/v3/types?id=default')).status, 404);
  assert.equal(success(await gql('{ _Content { total items { _id } } }'), '_Content').total, 0);
  await request('/api/content/v3/types', {method: 'PUT', body: MODEL});
  assert.deepEqual((await request('/api/content/v3/types?id=default')).data, MODEL);
  await request('/api/content/v3/types', {method: 'POST', body: {languages: ['fi'], contentTypes: {AnotherPage: {contentType: ['_Page'], properties: {}}}, propertyTypes: {Other: {properties: {label: {type: 'String'}}}}}});
  const merged = (await request('/__debug/types')).data;
  assert.deepEqual(merged.languages, ['fi']);
  assert.ok(merged.contentTypes._Item && merged.contentTypes.ArticlePage && merged.contentTypes.AnotherPage);
  assert.ok(merged.propertyTypes.RichText && merged.propertyTypes.Other);
  assert.equal(merged.preset, 'next');
  assert.deepEqual((await request('/api/content/v3/sources')).data, [{id: 'default', label: 'default', description: ''}]);
  assert.equal((await request('/api/content/v3/sources?id=other')).status, 404);
  await request('/_stream', {method: 'POST', body: index()});
  await request('/api/content/v3/sources?id=default&mode=types', {method: 'DELETE'});
  assert.equal(Object.keys(server.store.state.docs).length, 1);
  assert.equal((await request('/api/content/v3/types')).status, 404);
  await request('/api/content/v2/data?id=default', {method: 'DELETE'});
  assert.equal(Object.keys(server.store.state.docs).length, 0);
  await request('/_stream', {method: 'POST', body: index()});
  await request('/api/content/v3/sources?id=default&mode=reset', {method: 'DELETE'});
  assert.equal(Object.keys(server.store.state.docs).length, 0);
});

test('stream index/delete/delete_by_paths, ordered operations, journals and jobs', async t => {
  const {request, seed, server} = await gateway(t); await seed();
  const body = stream({index: {_id: 'extra', language_routing: 'sv'}}, document(), {delete: {_id: 'extra', _hardDeleted: true}}, {index: {_id: 'old'}}, document({metadata: {version: '11'}}), {delete_by_paths: {_hardDeleted: true}}, {paths: [['_metadata.key', KEY], ['_metadata.version', '11'], ['_metadata.locale', 'en']]});
  const result = await request('/_stream', {method: 'POST', body});
  const id = result.data.journalId;
  const journal = (await request(`/journal/stream/stream/${id}`)).data;
  assert.equal(journal.status, 'done'); assert.equal(journal.errors, false);
  assert.deepEqual(journal.items.map(i => i.index.Result), ['created', 'deleted', 'created', 'deleted']);
  assert.deepEqual(Object.keys(server.store.state.docs), [ID]);
  const job = {id: 'job', details: [{id, status: 'Processing'}]};
  await request('/journal/indexing', {method: 'POST', body: job});
  const storedJob = (await request('/journal/indexing/job')).data;
  assert.deepEqual({id: storedJob.id, details: storedJob.details}, job);
  assert.deepEqual(storedJob, job); assert.equal(Object.hasOwn(storedJob, 'ts'), false);
  assert.deepEqual((await request('/journal/indexing/job/status')).data, {id: 'job', status: 'Success', failingJournals: [], error: null, totalJournalIds: 1, succeededJournalIds: 1, failedJournalIds: 0, queuedJournalIds: 0});
  assert.equal((await request('/journal/indexing/missing/status')).status, 404);
  assert.equal((await request('/journal/stream/missing')).status, 404);
});

test('malformed stream recovers, missing source leaves next action intact, job reports Error', async t => {
  const {request, server} = await gateway(t);
  const body = stream('invalid json', {index: {_id: 'missing'}}, {index: {_id: 'bad'}}, '{bad document', {index: {_id: 'good'}}, document(), {delete_by_paths: {}}, {paths: []}, {delete: {_id: 'absent'}});
  const {data: {journalId}} = await request('/_stream', {method: 'POST', body});
  const journal = (await request(`/journal/stream/${journalId}`)).data;
  assert.equal(journal.errors, true); assert.equal(journal.items.filter(i => i.index.Status === 400).length, 4);
  assert.equal(journal.items.at(-1).index.Result, 'not_found');
  assert.ok(server.store.state.docs.good);
  await request('/journal/indexing', {method: 'POST', body: {id: 'failed', details: [{id: journalId}]}});
  const status = (await request('/journal/indexing/failed/status')).data;
  assert.equal(status.status, 'Error'); assert.deepEqual(status.failingJournals, [journalId]); assert.equal(status.failedJournalIds, 1);
});

test('snapshot protection, soft deletion and _doc event upsert', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  let response = await request('/_stream', {method: 'POST', body: index(ID, document({metadata: {displayName___searchable: 'Stale'}}), {_snapshotTime: '2020-01-01T00:00:00Z'})});
  assert.equal((await request(`/journal/stream/${response.data.journalId}`)).data.items[0].index.Result, 'noop');
  const path = '/_doc/event?language_routing=sv';
  response = await request(path, {method: 'POST', body: document({metadata: {locale: ''}}), headers: {SnapshotTime: '2026-10-14T00:00:00Z'}});
  assert.equal(response.data.result, 'created');
  assert.equal((await request(path, {method: 'POST', body: document()})).data.result, 'updated');
  await request('/_stream', {method: 'POST', body: stream({delete: {_id: ID, _hardDeleted: false}})});
  const query = '{ _Content { total items { _deleted } } }';
  assert.equal(success(await gql(query), '_Content').total, 1);
  assert.equal(success(await gql(query, {}, {headers: {'cg-include-deleted': 'true'}}), '_Content').total, 2);
  assert.equal(success(await gql(query, {}, {auth: 'epi-single public', headers: {'cg-include-deleted': 'true'}}), '_Content').total, 1);
});

test('raw/normalized documents preserve rich text, references, embedded blocks and skip fields', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  const debug = (await request(`/__debug/docs/${ID}`)).data;
  assert.equal(debug.raw['Heading$$String___searchable'], 'x Quick heading');
  assert.equal(debug.normalized.Heading, 'x Quick heading'); assert.equal(debug.normalized.MainBody.html, '<p>Résumé quick content</p>');
  assert.deepEqual(debug.normalized.Payload, {nested: true});
  const result = success(await gql('{ ArticlePage { items { __typename Heading MainBody { html json } Related { key url { default } } ContentArea { __typename _metadata { __typename key ... on ItemMetadata { displayOption } } ... on TeaserBlock { Heading } } Unindexed Payload } } }'), 'ArticlePage');
  assert.equal(result.items[0].ContentArea[0].__typename, 'TeaserBlock');
  assert.equal(result.items[0].ContentArea[0]._metadata.__typename, 'ItemMetadata');
  assert.equal(result.items[0].Related.url.default, '/related');
  assert.equal(result.items[0].Unindexed, 'secret unsearchable');
});

for (const [name, variables, expected] of [
  ['displayName match', {limit: 10, searchPhrase: 'Artic', searchId: null}, 1],
  ['displayName startsWith', {limit: 10, searchPhrase: 'Quick Art', searchId: null}, 1],
  ['key with dashed GUID', {limit: 10, searchPhrase: 'unmatched', searchId: GUID}, 1],
  ['no match', {limit: 10, searchPhrase: 'unmatched', searchId: 'none'}, 0],
]) test(`synthetic SearchProvider: ${name}`, async t => {
  const {gql, seed} = await gateway(t); await seed();
  const result = success(await gql(SEARCH, variables, {headers: {'X-Query-Name': 'SearchProvider'}}), '_Content');
  assert.equal(result.items.length, expected);
  if (expected) assert.deepEqual(result.items[0]._metadata, {__typename: 'InstanceMetadata', Name: 'Quick Article', ContentType: ['ArticlePage', '_Page', '_Content', '_Item'], ContentGuid: KEY, Language: 'en'});
});

test('SearchProvider type like interpolation', async t => {
  const {gql, seed} = await gateway(t); await seed();
  const result = success(await gql(SEARCH.replace('${searchPhrase}', 'ArticlePage'), {searchPhrase: 'nothing', searchId: null}), '_Content');
  assert.equal(result.items.length, 1);
});

test('synthetic GetContentProvider, ArticlePageQuery, _ContentQuery and CRLF _ItemQuery', async t => {
  const {gql, seed} = await gateway(t); await seed();
  assert.equal(success(await gql(GET_CONTENT, {id: KEY, version: '12', status: 'Published'}), '_Content').item._metadata.lastModified, '2026-10-13T08:15:30.123Z');
  const article = success(await gql(ARTICLE), 'ArticlePage'); assert.equal(article.total, 1); assert.equal(article.items[0]._metadata.version, '12');
  assert.equal(success(await gql(CONTENT.replace('3f2a...32hex', KEY)), '_Content').items.length, 1);
  assert.equal(success(await gql(ITEM, '{}'), '_Item').items[0]._itemMetadata.displayName, 'Quick Article');
});

test('auth checks Basic credentials, configured single key, missing auth and query-param key', async t => {
  const {request, gql, seed} = await gateway(t, {appKey: 'local', secret: 'local', singleKey: 'public'}); await seed();
  for (const auth of [null, 'epi-single wrong', `Basic ${Buffer.from('wrong:wrong').toString('base64')}`, 'Bearer token']) assert.equal((await request('/content/v2', {method: 'POST', body: {query: '{ _Content { total } }'}, auth})).status, 401);
  assert.equal((await request('/api/content/v3/types', {auth: 'epi-single public'})).status, 401);
  assert.equal((await request('/content/v2?auth=public', {method: 'POST', body: {query: '{ _Content { total } }'}, auth: null})).status, 200);
  assert.equal(success(await gql('{ _Content { total } }', {}, {auth: 'epi-single public'}), '_Content').total, 1);
  assert.equal((await request('/content/v2', {auth: null, headers: {Accept: 'text/html'}})).status, 200);
});

test('single-key hides drafts, restricted, expired and deleted; Basic roles/username constrain ACL', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('draft', document({metadata: {status: 'Draft'}})) + index('restricted', document({_rbac: ['r:Editors:Read']})) + index('user', document({_rbac: ['u:Jane Doe:Read']})) + index('expired', document({metadata: {expired: '2000-01-01T00:00:00Z'}}))});
  const query = '{ _Content { items { _id } total } }';
  assert.equal(success(await gql(query), '_Content').total, 5);
  assert.equal(success(await gql(query, {}, {auth: null}), '_Content').total, 1);
  assert.equal(success(await gql(query, {}, {headers: {'cg-include-expired': 'false'}}), '_Content').total, 4);
  const role = success(await gql(query, {}, {headers: {'cg-roles': 'Editors%2COther'}}), '_Content');
  assert.equal(role.total, 4); assert.ok(role.items.some(d => d._id === 'restricted')); assert.ok(!role.items.some(d => d._id === 'user'));
  assert.equal(success(await gql(query, {}, {headers: {'cg-username': 'Jane%20Doe'}}), '_Content').total, 4);
});

test('paging cursor overrides skip; facets/autocomplete use full filtered set', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('two', document({metadata: {displayName___searchable: 'Quick Second'}})) + index('three', document({__typename: 'StandardPage', metadata: {types: ['StandardPage', '_Page', '_Content', '_Item'], displayName___searchable: 'Third'}}))});
  const query = 'query($cursor:String,$skip:Int){ _Content(limit:1, skip:$skip, cursor:$cursor, orderBy:{_id:ASC}) { items {_id} total(all:true) cursor facets { _metadata { types(filters:["ArticlePage","StandardPage"],limit:10) {name count} } } autocomplete { _metadata { displayName(value:"Quick",limit:10) } } } }';
  const first = success(await gql(query), '_Content'); assert.equal(first.total, 3); assert.ok(first.cursor);
  assert.deepEqual(first.facets._metadata.types, [{name: '_Content', count: 3}, {name: '_Item', count: 3}, {name: '_Page', count: 3}, {name: 'ArticlePage', count: 2}, {name: 'StandardPage', count: 1}]);
  assert.deepEqual(first.autocomplete._metadata.displayName, ['Quick Article', 'Quick Second']);
  const next = success(await gql(query, {cursor: first.cursor, skip: 999}), '_Content'); assert.equal(next.items[0]._id, 'three');
  const last = success(await gql(query, {cursor: next.cursor}), '_Content'); assert.equal(last.cursor, ''); assert.equal(last.items[0]._id, 'two');
});

test('locale, ids and variation choices including originals', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('sv', document({metadata: {locale: 'sv'}})) + index('neutral', document({metadata: {locale: ''}}), {language_routing: ''}) + index('us', document({metadata: {locale: 'en-US'}})) + index('variant', document({metadata: {variation: 'a'}}))});
  async function total(args = '') { return success(await gql(`{ _Content${args ? `(${args})` : ''} {total} }`), '_Content').total; }
  assert.equal(await total(), 4); assert.equal(await total('locale:en'), 1); assert.equal(await total('locale:[sv, NEUTRAL]'), 2); assert.equal(await total('locale:en_US'), 1);
  assert.equal(await total('variation:{include:ALL}'), 5); assert.equal(await total('variation:{include:NONE}'), 4); assert.equal(await total('variation:{include:SOME,value:["a"]}'), 1); assert.equal(await total('variation:{include:SOME,value:["a"],includeOriginal:true}'), 5);
  assert.equal(await total(`ids:["${ID}"]`), 1); assert.equal(await total(`ids:["${GUID.toUpperCase()}"]`), 4);
});

test('smooth rebuild keeps new documents/types isolated and mutations accept/revert/discard', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  assert.equal(success(await gql('mutation { deployNewAccountVersion(languages:["en"]) }'), 'deployNewAccountVersion'), 'done');
  const newModel = structuredClone(MODEL); newModel.contentTypes.NewPage = {contentType: ['_Page'], properties: {NewField: {type: 'String'}}};
  await request('/api/content/v3/types', {method: 'PUT', body: newModel, headers: {'cg-deploy-new': 'true'}});
  await request('/_stream', {method: 'POST', body: index('new', document({__typename: 'NewPage', metadata: {types: ['NewPage', '_Page', '_Content', '_Item']}, 'NewField$$String': 'new field'}), {version: 'new'})});
  assert.equal(success(await gql('{ _Content {items {_id}} }'), '_Content').items[0]._id, ID);
  assert.equal(success(await gql('{ NewPage {items {NewField}} }', {}, {headers: {'cg-use-new': 'true'}}), 'NewPage').items[0].NewField, 'new field');
  assert.ok((await gql('{ NewPage {total} }')).errors);
  assert.equal(success(await gql('mutation { useNewAccountVersion(languages:["en"]) }'), 'useNewAccountVersion'), 'done');
  assert.equal(success(await gql('{ _Content {items {_id}} }'), '_Content').items[0]._id, 'new');
  assert.deepEqual(Object.keys((await request('/__debug/stats')).data.slots), ['live', 'new', 'old']);
  for (const mutation of ['useOldAccountVersion', 'abandonSlot']) {
    await gql('mutation { deployNewAccountVersion }');
    await request('/_doc/unwanted?version=new', {method: 'POST', body: document()});
    assert.equal(success(await gql(`mutation { ${mutation} }`), mutation), 'done');
    assert.equal(success(await gql('{ _Content {total} }'), '_Content').total, 1);
    assert.equal(success(await gql('{ _Content {items {_id}} }'), '_Content').items[0]._id, ID);
  }
  assert.ok((await gql('{ NewPage {total} }')).errors);
  assert.ok((await gql('mutation { abandonSlot }', {}, {auth: 'epi-single public'})).errors);
});

test('GraphQL parse/validation/coercion errors, operationName and variables string/null', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  for (const query of ['{', '{ missing }', 'query($n:Int!){_Content(limit:$n){total}}']) {
    const result = await gql(query); assert.ok(result.errors.length); assert.ok(result.extensions.correlationId);
  }
  assert.ok((await gql('{ _Content {total} }', '{bad')).errors);
  assert.equal(success(await gql('{_Content{total}}', null), '_Content').total, 1);
  assert.equal(success(await gql('query A{_Content{total}} query B{ArticlePage{total}}', '{}', {operationName: 'B'}), 'ArticlePage').total, 1);
  assert.equal((await request('/content/v2', {method: 'POST', body: '{bad'})).status, 400);
  assert.ok((await request('/content/v2?query=' + encodeURIComponent('{_Content{total}}'))).data.data);
});

test('extract text/binary, clientlog, webhooks, locale deletion and debug reset', async t => {
  const {request, seed, server} = await gateway(t); await seed();
  assert.deepEqual((await request('/extract?cache=1s', {method: 'POST', body: 'Résumé', headers: {'Content-Type': 'application/octet-stream'}})).data, {type: 'text/plain', language: '', text: 'Résumé'});
  assert.equal((await request('/extract', {method: 'POST', body: new Uint8Array([255, 0, 12])})).data.text, '');
  assert.equal((await request('/clientlog', {method: 'POST', body: {level: 'Info', content: 'test'}})).status, 204);
  const hook = (await request('/api/webhooks', {method: 'POST', body: {url: 'http://localhost/hook', event: 'publish'}})).data;
  assert.ok(hook.id); assert.deepEqual((await request('/api/webhooks')).data, [hook]);
  await request(`/api/webhooks/${hook.id}`, {method: 'DELETE'}); assert.deepEqual((await request('/api/webhooks')).data, []);
  await request('/account?language_routing=en&softDelete=true', {method: 'DELETE'}); assert.equal(Object.keys(server.store.state.docs).length, 0);
  await seed(); await request('/__debug/reset', {method: 'POST'});
  assert.deepEqual(server.store.state.docs, {}); assert.deepEqual(server.store.state.types, {}); assert.deepEqual(server.store.state.journals, {});
});
