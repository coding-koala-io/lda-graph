import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.js';
import {createServer} from '../src/server.js';
import {buildSchema} from '../src/schema.js';
import {matchFilter, evaluateQuery, editDistance} from '../src/query-engine.js';
import {gateway, success, quiet, BASIC, replaySynthetic} from './helpers.js';
import {MODEL, document, index, stream, ID} from './fixtures.js';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const ADMIN = `Basic ${Buffer.from(`local:${SECRET}`).toString('base64')}`;
function preview(claims = {}) {
  const header = Buffer.from(JSON.stringify({alg: 'HS256'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: 'graph', aud: 'graph', appKey: 'local', sub: 'editor', role: ['Editors'], ...claims})).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${header}.${payload}`).digest('base64url');
  return `Bearer ${header}.${payload}.${signature}`;
}
function scratch(t) {
  const root = resolve(tmpdir()); const folder = mkdtempSync(join(root, 'graph-access-'));
  t.after(() => {
    const target = resolve(folder); const inside = relative(root, target);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    rmSync(target, {recursive: true, force: true});
  });
  return folder;
}
const resultOf = (store, journal) => store.state.journals[journal].items.map(item => item.index.Result);

test('preview reads drafts through ACLs but cannot mutate or administer', async t => {
  const {request, gql, server} = await gateway(t, {appKey: 'local', secret: SECRET});
  await request('/api/content/v3/types', {method: 'PUT', body: MODEL, auth: ADMIN});
  await request('/_stream', {method: 'POST', auth: ADMIN, body: index('draft', document({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']})) + index('private', document({metadata: {status: 'Draft'}, _rbac: ['r:Admins:Read']}))});
  assert.equal(success(await gql('{_Content{total}}', {}, {auth: preview()}), '_Content').total, 1);
  const state = structuredClone(server.store.state);
  for (const auth of [preview(), 'epi-single public']) {
    for (const mutation of ['deployNewAccountVersion', 'useNewAccountVersion', 'useOldAccountVersion', 'abandonSlot']) {
      const response = await gql(`mutation{${mutation}}`, {}, {auth});
      assert.match(response.errors[0].message, /Basic authentication/);
      assert.equal(response.data[mutation], null);
    }
    for (const [path, method, body] of [['/_stream', 'POST', ''], ['/api/content/v3/types', 'PUT', MODEL], ['/journal/indexing', 'POST', {id: 'bad', details: []}], ['/api/webhooks', 'GET']]) {
      assert.equal((await request(path, {method, body, auth})).status, 401);
    }
  }
  assert.deepEqual(server.store.state, state, 'Rejected operations must not change the slots or content');
  assert.equal(success(await gql('mutation{deployNewAccountVersion}', {}, {auth: ADMIN}), 'deployNewAccountVersion'), 'done');
});

test('synthetic ContentReference items resolve IData with slot and access isolation', async t => {
  const {request, gql, server} = await gateway(t);
  await replaySynthetic(request);
  const home = success(await gql('{HomePage(locale:en){items{ContentArea{... on CardBlock{Image{item{__typename _id ... on PictureMedia{_metadata{url{default}}} ... on _IContent{_metadata{displayName}}}}}}}}}', {}, {auth: 'epi-single public'}), 'HomePage');
  const refs = home.items.flatMap(item => item.ContentArea ?? []).map(block => block.Image?.item).filter(Boolean);
  assert.equal(refs.length, 3, 'Embedded references must return all three images');
  assert.equal(new Set(refs.map(ref => ref._id)).size, 3);
  assert.ok(refs.every(ref => ref.__typename === 'PictureMedia' && ref._metadata.url.default && ref._metadata.displayName));
  const schema = buildSchema(server.store.state.types.default, server.store, {logger: quiet});
  const data = schema.getType('IData');
  assert.ok(schema.getPossibleTypes(data).some(type => type.name === 'PictureMedia'));
  assert.ok(schema.getPossibleTypes(data).some(type => type.name === '_ContentGeneric'));

  // A model ref on an arbitrary property must use the same resolver as item.
  const model = structuredClone(MODEL);
  model.contentTypes.ArticlePage.properties.Direct = {type: 'IData', ref: {type: 'Data', id: '_id'}};
  await request('/api/content/v3/types', {method: 'PUT', body: model});
  const query = '{ArticlePage(ids:["parent"]){item{Direct{_id} Related{item{_id ... on _IContent{_metadata{displayName}}}}}}}';
  const check = async (target, options = {}) => {
    server.store.upsert('parent', document({Direct: 'target', Related: {__typename: 'ContentReference', item: 'target'}}));
    server.store.upsert('target', document(target));
    return success(await gql(query, {}, options), 'ArticlePage').item;
  };
  assert.equal((await check({metadata: {status: 'Draft'}} , {auth: 'epi-single public'})).Related.item, null);
  assert.equal((await check({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']}, {auth: preview()})).Related.item._id, 'target');
  assert.equal((await check({_rbac: ['r:Admins:Read']}, {auth: preview()})).Direct, null);
  assert.equal((await check({_rbac: ['r:Admins:Read']}, {headers: {'cg-roles': 'Editors'}})).Related.item, null);
  assert.equal((await check({metadata: {expired: '2000-01-01'}}, {auth: 'epi-single public'})).Related.item, null);
  assert.equal((await check({metadata: {expired: '2000-01-01'}}, {headers: {'cg-include-expired': 'false'}})).Related.item, null);
  assert.equal((await check({_deleted: true})).Related.item, null);
  assert.equal((await check({_deleted: true}, {headers: {'cg-include-deleted': 'true'}})).Related.item._id, 'target');
  server.store.delete('target');
  assert.equal(success(await gql(query), 'ArticlePage').item.Related.item, null);
  await request('/api/content/v3/types', {method: 'PUT', body: model, headers: {'cg-deploy-new': 'true'}});
  server.store.upsert('parent', document({Related: {__typename: 'ContentReference', item: 'target'}}), {slot: 'new'});
  server.store.upsert('target', document({metadata: {displayName: 'New slot'}}), {slot: 'new'});
  server.store.upsert('target', document({metadata: {displayName: 'Live slot'}}));
  assert.equal(success(await gql(query, {}, {headers: {'cg-use-new': 'true'}}), 'ArticlePage').item.Related.item._metadata.displayName, 'New slot');
  assert.equal(success(await gql(query), 'ArticlePage').item.Related.item._metadata.displayName, 'Live slot');
});

test('phrase wildcard and Damerau-Levenshtein fuzzy filters work on fields and fulltext', async t => {
  const cases = [
    ['The quick, brown fox', {phrase: 'QUICK brown'}, true], ['quick very brown', {phrase: 'quick brown'}, false],
    ['quickly brown', {phrase: 'quick brown'}, false], ['The cedar plan', {wildcard: 'CE?A*'}, true],
    ['The cedar plan', {wildcard: 'dar*'}, false], ['cedar', {fuzzy: 'cedr'}, true], ['cedar', {fuzzy: 'cedra'}, true],
    ['cedar', {fuzzy: 'cxxar'}, false], ['elephant', {fuzzy: 'elepxxnt'}, true], ['elephant', {fuzzy: 'elepxxxt'}, false],
    ['Résumé', {fuzzy: 'résume'}, true], [[], {fuzzy: 'x'}, false], ['foo', {phrase: ''}, false],
  ];
  for (const [value, filter, expected] of cases) assert.equal(matchFilter(value, filter).match, expected, JSON.stringify({value, filter}));
  assert.equal(editDistance('ca', 'abc'), 2, 'Unrestricted transposition distance');
  const {gql, seed} = await gateway(t); await seed();
  for (const filter of ['phrase:"quick article"', 'wildcard:"ART?C*"', 'fuzzy:"articel"']) {
    const response = success(await gql(`{ArticlePage(where:{_metadata:{displayName:{${filter},synonyms:[ONE,TWO],boost:3}}}){total items{_score}}}`), 'ArticlePage');
    assert.equal(response.total, 1); assert.ok(response.items[0]._score >= 3);
  }
  for (const filter of ['phrase:"résumé quick"', 'wildcard:"RÉ?U*"', 'fuzzy:"quik"']) {
    assert.equal(success(await gql(`{ArticlePage(where:{_or:[{_fulltext:{${filter},synonyms:[ONE,TWO]}},{Heading:{eq:"missing"}}]}){total}}`), 'ArticlePage').total, 1);
  }
  assert.equal(success(await gql('{ArticlePage(where:{_fulltext:{fuzzy:"zzzzz"}}){total}}'), 'ArticlePage').total, 0);
});

test('GraphQL GET/POST/OPTIONS allow CORS', async t => {
  const {request} = await gateway(t, {appKey: 'local', secret: SECRET, singleKey: 'public'});
  const origin = 'http://localhost:3000';
  for (const path of ['/content/v2']) {
    const response = await request(path, {method: 'OPTIONS', auth: null, headers: {Origin: origin}});
    assert.equal(response.status, 204); assert.equal(response.data, '');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(response.headers.get('access-control-max-age'), '600');
    const allowed = response.headers.get('access-control-allow-headers').toLowerCase().split(', ');
    for (const name of ['authorization', 'content-type', 'x-query-name', 'cg-username', 'cg-roles', 'cg-include-deleted', 'cg-include-expired', 'cg-use-new', 'cg-deploy-new']) assert.ok(allowed.includes(name));
    assert.equal(response.headers.get('vary'), 'Origin');
  }
  for (const path of ['/health', '/missing', '/_stream', '/__debug/reset', '/']) {
    const response = await request(path, {method: 'OPTIONS', auth: null, headers: {Origin: origin}});
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('vary'), null);
  }
  const invalid = await request('/content/v2', {method: 'POST', body: {query: '{'}, auth: 'epi-single public', headers: {Origin: origin}});
  assert.equal(invalid.status, 200); assert.ok(invalid.data.errors.length);
  assert.equal(invalid.headers.get('access-control-allow-origin'), origin);
  assert.equal((await request('/health', {auth: null})).headers.get('access-control-allow-origin'), null);
});

test('debug routes need no tenant Basic: loopback reset checks origin, remote reads require admin Basic', async t => {
  const {request, base, server} = await gateway(t, {appKey: 'local', secret: SECRET});
  server.store.upsert('keep', document()); server.store.addJob({id: 'job', details: []});
  // Loopback admin routes do not require tenant credentials.
  for (const Origin of ['https://evil.example', 'null', 'invalid', base.replace('http:', 'https:')]) {
    assert.equal((await request('/__debug/reset', {method: 'POST', auth: ADMIN, headers: {Origin}})).status, 403);
  }
  assert.ok(server.store.state.docs.keep); assert.ok(server.store.state.jobs.job);
  assert.equal((await request('/__debug/docs', {auth: null})).status, 200, 'Loopback debug reads remain available');
  assert.equal((await request('/__debug/reset', {method: 'POST', auth: ADMIN, headers: {Origin: base}})).status, 200);
  for (const field of ['docs', 'types', 'journals', 'jobs', 'slots', 'tombstones']) assert.deepEqual(server.store.state[field], {});
  const remote = await gateway(t, {host: '0.0.0.0', appKey: 'local', secret: SECRET, adminUser: 'manager', adminPassword: 'admin-password'});
  for (const path of ['/__debug/docs', '/__debug/types', '/__debug/schema', '/__debug/requests', '/__debug/docs/missing', '/__debug/requests/1']) {
    assert.equal((await remote.request(path, {auth: null})).status, 401);
    assert.equal((await remote.request(path, {auth: preview()})).status, 401);
    assert.notEqual((await remote.request(path, {auth: `Basic ${Buffer.from('manager:admin-password').toString('base64')}`})).status, 401);
  }
  const unconfigured = await gateway(t);
  assert.equal((await unconfigured.request('/__debug/reset', {method: 'POST', auth: null, headers: {Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await unconfigured.request('/__debug/reset', {method: 'POST', auth: null})).status, 200);
});

test('timestamped deletes and path deletes prevent stale resurrection across persistence and slots', async t => {
  const store = new Store({dataDir: scratch(t), logger: quiet});
  const old = '2026-01-01T00:00:01Z'; const current = '2026-01-01T00:00:02Z'; const deleted = '2026-01-01T00:00:03Z'; const fresh = '2026-01-01T00:00:04Z';
  store.upsert('a', document(), {snapshotTime: current});
  assert.equal(store.delete('a', {snapshotTime: old}).Result, 'noop'); assert.ok(store.state.docs.a);
  assert.deepEqual(resultOf(store, store.stream(stream({delete: {_id: 'a', _snapshotTime: deleted}}, {index: {_id: 'a', _snapshotTime: current}}, document()))), ['deleted', 'noop']);
  assert.equal(store.state.docs.a, undefined); assert.equal(store.state.tombstones.a, deleted);
  store.upsert('path', document(), {snapshotTime: current});
  assert.deepEqual(resultOf(store, store.stream(stream({delete_by_paths: {_snapshotTime: old}}, {paths: [['_metadata.version', 12]]}))), ['noop']);
  assert.deepEqual(resultOf(store, store.stream(stream({delete_by_paths: {_snapshotTime: deleted}}, {paths: [['_metadata.version', 12]]}))), ['deleted']);
  assert.equal(store.upsert('path', document(), {snapshotTime: current}).Result, 'noop');
  store.upsert('soft', document(), {snapshotTime: current}); store.delete('soft', {hard: false, snapshotTime: deleted});
  assert.equal(store.upsert('soft', document(), {snapshotTime: current}).Result, 'noop'); assert.equal(store.state.docs.soft.normalized._deleted, true);
  store.delete('__proto__', {snapshotTime: deleted});
  assert.equal(store.upsert('__proto__', document(), {snapshotTime: current}).Result, 'noop');
  store.delete('new-only', {slot: 'new', snapshotTime: deleted});
  assert.equal(store.upsert('new-only', document(), {snapshotTime: current}).Result, 'created', 'Tombstones are slot-specific');
  await store.flush();
  const restored = new Store({dataDir: store.dataDir, logger: quiet});
  assert.equal(restored.upsert('a', document(), {snapshotTime: current}).Result, 'noop');
  assert.equal(restored.upsert('path', document(), {snapshotTime: current}).Result, 'noop');
  assert.equal(restored.upsert('a', document(), {snapshotTime: fresh}).Result, 'created');
  restored.mutate('useNewAccountVersion');
  assert.equal(restored.upsert('new-only', document(), {snapshotTime: current}).Result, 'noop');
  await restored.flush();
});

test('malformed document shapes are normalized and poisoned predicates are skipped once', async t => {
  const errors = []; const {request, gql, server, seed} = await gateway(t, {logger: {log() {}, error: m => errors.push(m)}}); await seed();
  for (const [i, acl] of [5, 'r:Everyone:Read', {}, ['r:Everyone:Read', 42]].entries()) {
    assert.equal((await request(`/_doc/bad-acl-${i}`, {method: 'POST', body: document({_rbac: acl})})).status, 200);
  }
  for (const [i, metadata] of [5, 'bad', [], null, {types: [5], locale: {}, status: []}].entries()) {
    assert.equal((await request(`/_doc/bad-meta-${i}`, {method: 'POST', body: document({_metadata: metadata})})).status, 200);
  }
  assert.equal(success(await gql('{ArticlePage{total}}', {}, {auth: 'epi-single public'}), 'ArticlePage').total, 1);
  assert.equal(success(await gql('{ArticlePage{total}}', {}, {auth: preview()}), 'ArticlePage').total, 6);
  assert.equal(success(await gql('{ArticlePage{total}}'), 'ArticlePage').total, 10);
  assert.equal(success(await gql('{ArticlePage{total}}', {}, {headers: {'cg-roles': 'Editors'}}), 'ArticlePage').total, 6);
  const record = server.store.state.docs['bad-acl-0'];
  assert.equal(record.raw._rbac, 5); assert.equal(record.normalized._rbac, undefined);
  server.store.upsert('poison', document()); server.store.state.docs.poison.searchable = null;
  for (let i = 0; i < 2; i++) {
    assert.equal(success(await gql('{ArticlePage(where:{_fulltext:{match:"quick"}}){total}}'), 'ArticlePage').total, 10);
  }
  assert.equal(errors.filter(message => message.includes('Skipping malformed document poison')).length, 1);
  assert.equal(evaluateQuery(server.store, 'ArticlePage', {}, {auth: 'single'}).total, 1, 'A non-scoring query also skips corrupt records');
  await request('/_doc/odd-field', {method: 'POST', body: document({'Number$$Int': {toString: null}, 'Tags$$String': [{toString: null}]})});
  const odd = success(await gql('{ArticlePage(orderBy:{Number:ASC}){total facets{Tags{name count} Number(ranges:[{from:0,to:10}]){name count}}}}'), 'ArticlePage');
  assert.equal(odd.total, 11, 'Odd field values cannot break ordering or facets');
  assert.equal(success(await gql('{ArticlePage{total facets{Tags(filters:["News"]){name count}}}}'), 'ArticlePage').total, 10);
});

test('persistence rebuilds raw records, quarantines corruption and coalesces async saves', async t => {
  const dataDir = scratch(t); const errors = [];
  const logger = {log() {}, error: m => errors.push(m)};
  const legacy = {types: {default: MODEL}, docs: {legacy: {raw: document(), normalized: {_id: 'wrong', Heading: 'wrong', _modified: '2026-01-01'}, searchable: ['wrong']}}, slots: null};
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify(legacy));
  const store = new Store({dataDir, logger});
  assert.equal(store.state.docs.legacy.normalized.Heading, 'x Quick heading');
  assert.equal(store.state.docs.legacy.normalized._id, 'legacy');
  store.mutate('deployNewAccountVersion'); store.upsert('pending', document(), {slot: 'new'});
  store.delete('gone', {snapshotTime: '2026-01-02'}); store.addJob({id: 'job', details: []}); store.state.webhooks.push({id: 'hook'});
  for (let i = 0; i < 800; i++) store.upsert(`large-${i}`, document({'Heading$$String___searchable': 'x'.repeat(4000)}));
  let active = 0; let maximum = 0; let writes = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => {
    writes++; maximum = Math.max(maximum, ++active);
    try { if (writes === 1) await gate; await write(); } finally { active--; }
  };
  const first = store.flush();
  for (let i = 0; i < 20; i++) { store.upsert('latest', document({metadata: {version: i}})); assert.equal(store.flush(), first); }
  let ticks = 0; const interval = setInterval(() => ticks++, 1);
  release(); await first; clearInterval(interval);
  assert.equal(maximum, 1); assert.equal(writes, 2); assert.ok(ticks > 0, 'Large saves yield to the event loop');
  const records = readFileSync(join(dataDir, 'store.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).record, 'end'); assert.ok(records.length > 800);
  for (const record of records.filter(record => record.record === 'docs')) {
    assert.deepEqual(Object.keys(record.value).sort(), ['locale', 'raw', 'snapshotTime']);
    assert.equal(Object.hasOwn(record.value, 'normalized'), false);
  }
  const restored = new Store({dataDir, logger});
  assert.equal(restored.state.docs.latest.normalized._metadata.version, '19');
  assert.equal(restored.slot('new').docs.pending.normalized.Heading, 'x Quick heading');
  assert.equal(restored.state.tombstones.gone, '2026-01-02'); assert.ok(restored.state.jobs.job); assert.equal(restored.state.webhooks[0].id, 'hook');
  assert.deepEqual(restored.state.docs.legacy.searchable, store.state.docs.legacy.searchable);
  const corruptDir = scratch(t);
  for (const contents of ['{"types":', 'null']) {
    writeFileSync(join(corruptDir, 'store.json'), contents);
    assert.deepEqual(new Store({dataDir: corruptDir, logger}).state.docs, {});
    assert.equal(existsSync(join(corruptDir, 'store.json')), false);
  }
  assert.equal(readdirSync(corruptDir).filter(file => /^store\.corrupt-.*\.json$/.test(file)).length, 2);
  writeFileSync(join(corruptDir, 'store.ndjson'), '{"record":"header","version":1}\n{"record":"docs"');
  assert.deepEqual(new Store({dataDir: corruptDir, logger}).state.docs, {});
  assert.ok(errors.some(message => /corrupt or partial.*starting empty/.test(message)));
  const failure = await gateway(t, {logger});
  failure.server.store.flush = async () => { throw new Error('disk unavailable'); };
  await new Promise(resolve => failure.server.close(resolve));
  assert.ok(errors.some(message => message.includes('Shutdown persistence failed: disk unavailable')));
});

test('facet filters narrow pages and totals while preserving own options through fragments', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  for (const [id, tag, number] of [['a1', 'A', 1], ['a2', 'A', 2], ['b1', 'B', 1], ['b2', 'B', 2]]) {
    await request(`/_doc/${id}`, {method: 'POST', body: document({'Tags$$String': [tag], 'Number$$Int': number})});
  }
  const query = `query($tags:[String],$numbers:[String],$active:Boolean!){
    filtered:ArticlePage(where:{Number:{lte:2}},limit:1,orderBy:{_id:ASC}){total cursor items{_id} ...Choices}
    unfiltered:ArticlePage(where:{Number:{lte:2}}){total}
  }
  fragment Choices on ArticlePageOutput{facets{...Options}}
  fragment Options on ArticlePageFacet{tags:Tags(filters:$tags) @include(if:$active){name count} Number(filters:$numbers){name count}}`;
  const response = await gql(query, {tags: ['A'], numbers: ['1'], active: true});
  assert.equal(response.errors, undefined);
  assert.equal(response.data.filtered.total, 1); assert.equal(response.data.filtered.items[0]._id, 'a1'); assert.equal(response.data.filtered.cursor, '');
  assert.equal(response.data.unfiltered.total, 4);
  assert.deepEqual(response.data.filtered.facets.tags, [{name: 'A', count: 1}, {name: 'B', count: 1}]);
  assert.deepEqual(response.data.filtered.facets.Number, [{name: '1', count: 1}, {name: '2', count: 1}]);
  const disabled = await gql(query, {tags: ['A'], numbers: null, active: false});
  assert.equal(disabled.errors, undefined); assert.equal(disabled.data.filtered.total, 4);
  const page = success(await gql('{ArticlePage(limit:1,orderBy:{_id:ASC}){total cursor items{_id} facets{Tags(filters:["A"]){name count}}}}'), 'ArticlePage');
  assert.equal(page.total, 2); assert.equal(page.items[0]._id, 'a1'); assert.ok(page.cursor);
  const next = success(await gql('query($cursor:String){ArticlePage(limit:1,cursor:$cursor,orderBy:{_id:ASC}){items{_id} cursor total facets{Tags(filters:["A"]){name count}}}}', {cursor: page.cursor}), 'ArticlePage');
  assert.equal(next.items[0]._id, 'a2'); assert.equal(next.cursor, ''); assert.equal(next.total, 2);
});

test('rich text and JSON scalars parse JSON strings without losing ordinary strings', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  const first = success(await gql('{ArticlePage{item{MainBody{html json} PlainBody{json} Payload}}}'), 'ArticlePage').item;
  assert.deepEqual(first.MainBody.json, {type: 'root'}); assert.deepEqual(first.PlainBody.json, {}); assert.deepEqual(first.Payload, {nested: true});
  for (const [value, expected] of [['[1,{"ok":true}]', [1, {ok: true}]], ['42', 42], ['false', false], ['null', null], ['"text"', 'text'], ['ordinary text', 'ordinary text']]) {
    await request(`/_doc/${ID}`, {method: 'POST', body: document({'Payload$$JSON___skip': value})});
    assert.deepEqual(success(await gql('{ArticlePage{item{Payload}}}'), 'ArticlePage').item.Payload, expected);
  }
});

test('startup rejects either unpaired Basic credential with a clear error', async () => {
  for (const options of [{appKey: 'local', secret: ''}, {appKey: '', secret: SECRET}]) {
    assert.throws(() => createServer({dataDir: ':memory:', logDir: ':memory:', ...options}), /GRAPH_APP_KEY and GRAPH_SECRET must both be set/);
    await assert.rejects(promisify(execFile)(process.execPath, ['src/server.js'], {env: {...process.env, PORT: '0', DATA_DIR: ':memory:', LOG_DIR: ':memory:', GRAPH_APP_KEY: options.appKey, GRAPH_SECRET: options.secret}}), error => {
      assert.match(error.stderr, /GRAPH_APP_KEY and GRAPH_SECRET must both be set/); assert.doesNotMatch(error.stdout, /listening/); return true;
    });
  }
  assert.ok(createServer({dataDir: ':memory:', logDir: ':memory:', appKey: 'local', secret: SECRET}));
});

test('request logs rotate at 50 MB, retain three archives and expose numbered entries and query names', async t => {
  const logDir = scratch(t); const lines = [];
  const {request, gql, server} = await gateway(t, {logDir, logger: {log: m => lines.push(m), error: m => lines.push(m)}});
  await request('/health');
  const tenantLogDir = join(logDir, 'default');
  const file = join(tenantLogDir, 'requests.ndjson');
  writeFileSync(file, 'current'); truncateSync(file, 50 * 1024 * 1024);
  for (let n = 1; n <= 3; n++) writeFileSync(`${file}.${n}`, `archive-${n}`);
  await request('/health');
  assert.equal(readFileSync(`${file}.2`, 'utf8'), 'archive-1'); assert.equal(readFileSync(`${file}.3`, 'utf8'), 'archive-2');
  for (let i = 0; i < 3; i++) { truncateSync(file, 50 * 1024 * 1024); await request('/health'); }
  assert.deepEqual(readdirSync(tenantLogDir).sort(), ['requests.ndjson', 'requests.ndjson.1', 'requests.ndjson.2', 'requests.ndjson.3']);
  await gql('query Named{...Root} fragment Root on Query{alias:_Content{total}}', {}, {headers: {'X-Query-Name': 'My CMS Query'}});
  assert.ok(lines.some(line => /query="My CMS Query" root=_Content/.test(line)));
  const entry = structuredClone(server.recentRequests.at(-1));
  const fetched = await request(`/__debug/requests/${entry.n}`);
  assert.equal(fetched.status, 200); assert.deepEqual(fetched.data, entry);
  assert.equal(fetched.data.headers.authorization, 'Basic'); assert.equal(fetched.data.reqBody.query.includes('query Named'), true);
  assert.equal((await request('/__debug/requests/99999')).status, 404);
  assert.ok((await request('/tenants/default')).data.includes(`/tenants/default/request/${entry.n}`));
});

test('README documents auth kinds, CORS, tombstones, facet filters and fuzzy distance', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const pattern of [/single.*basic.*preview/i, /preview.*cannot.*mutations/i, /OPTIONS.*204/, /Access-Control-Allow-Origin/, /tombstone/i, /before.*own filter/i, /Damerau-Levenshtein/, /longer than 5/, /store\.ndjson/, /50 MB/, /GRAPH_APP_KEY.*GRAPH_SECRET.*both/]) assert.match(readme, pattern);
});
