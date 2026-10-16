import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {Store} from '../src/store.js';
import {gateway, quiet, success} from './helpers.js';
import {A, B, basic, tenants, scratch} from './tenant-helpers.js';
import {MODEL, document, index} from './fixtures.js';

const base = '/tenants/' + A.id;
const query = '{_Content(orderBy:{_id:ASC}){total items{_id}}}';
const ids = result => success(result, '_Content').items.map(doc => doc._id);
const modelWith = name => ({...structuredClone(MODEL), contentTypes: {...MODEL.contentTypes, [name]: {contentType: ['_Page'], properties: {}}}});
const liveModel = modelWith('OriginalPage');
const newModel = modelWith('RebuiltPage');
const mutate = async (gw, name, headers = {}) => {
  assert.equal(success(await gw.gql(`mutation{${name}}`, {}, {auth: basic(A), headers}), name), 'done');
};

async function seed(gw) {
  assert.equal((await gw.request('/api/content/v3/types', {method: 'PUT', auth: basic(A), body: liveModel})).status, 200);
  assert.equal((await gw.request('/api/content/v3/types', {method: 'POST', auth: basic(A), body: {languages: liveModel.languages}})).status, 200);
  assert.equal((await gw.request('/_stream', {method: 'POST', auth: basic(A), body: ['original-1', 'original-2'].map(id => index(id, document({metadata: {key: id}}))).join('')})).status, 200);
  const store = gw.server.tenants.get(A.id).store;
  store.delete('original-gone', {snapshotTime: '2026-10-14T00:00:00Z'});
  // Distinct timestamps make a wrong metadata restore visible even on fast clocks.
  store.state.metadata.liveTypesUpdated = '2026-10-13T01:00:00Z';
  return structuredClone({types: store.state.types, docs: store.state.docs, tombstones: store.state.tombstones, metadata: store.state.metadata});
}

async function deploy(gw) {
  await mutate(gw, 'deployNewAccountVersion');
  assert.equal((await gw.request('/api/content/v3/types', {method: 'PUT', auth: basic(A), body: newModel, headers: {'cg-deploy-new': 'true'}})).status, 200);
  // Exercise both supported stream slot selectors.
  assert.equal((await gw.request('/_stream', {method: 'POST', auth: basic(A), body: ['rebuilt-1', 'rebuilt-2'].map(id => index(id, document({metadata: {key: id}}))).join(''), headers: {'cg-deploy-new': 'true'}})).status, 200);
  assert.equal((await gw.request('/_stream', {method: 'POST', auth: basic(A), body: index('rebuilt-3', document({metadata: {key: 'rebuilt-3'}}), {version: 'new'})})).status, 200);
  const store = gw.server.tenants.get(A.id).store;
  store.delete('rebuilt-gone', {slot: 'new', snapshotTime: '2026-10-14T02:00:00Z'});
  store.state.metadata.newTypesUpdated = '2026-10-14T01:00:00Z';
}

async function assertOriginal(gw, original) {
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A)})), ['original-1', 'original-2']);
  const runtime = gw.server.tenants.get(A.id);
  for (const field of ['types', 'docs', 'tombstones', 'metadata']) assert.deepEqual(runtime.store.state[field], original[field]);
  assert.deepEqual((await gw.request(base + '/stats', {auth: null})).data.slots, {live: 2, new: null, old: null});
  assert.equal(success(await gw.gql('{OriginalPage{total}}', {}, {auth: basic(A)}), 'OriginalPage').total, 0);
  assert.ok((await gw.gql('{RebuiltPage{total}}', {}, {auth: basic(A)})).errors, 'Revert must rebuild the live schema');
  assert.deepEqual(Object.keys(runtime.schemas).sort(), ['live', 'new'], 'Previous slot has no query schema');
}

test('deploy, stream three new docs, accept and revert original IDs/types/tombstones/metadata', async t => {
  const gw = await tenants(t); const original = await seed(gw); await deploy(gw);
  await mutate(gw, 'useNewAccountVersion', {'cg-use-new': 'true'});
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A)})), ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']);
  const stats = (await gw.request(base + '/stats', {auth: null})).data;
  assert.deepEqual(stats.slots, {live: 3, new: null, old: 2});
  assert.equal(stats.typesUpdated, '2026-10-14T01:00:00Z'); assert.equal(stats.typesMethod, 'PUT');
  assert.deepEqual(gw.server.tenants.get(A.id).store.state.slots.old.types, original.types);
  assert.match((await gw.request(base, {auth: null})).data, /previous \(revertable\): 2 docs/);
  const health = (await gw.request('/health', {auth: null})).data;
  assert.deepEqual(health.tenants[A.id], {loaded: true, docs: 3});
  // A revert also discards a rebuild started after accepting the previous one.
  await mutate(gw, 'deployNewAccountVersion');
  await gw.request('/_doc/pending?version=new', {method: 'POST', auth: basic(A), body: document()});
  await mutate(gw, 'useOldAccountVersion', {'cg-use-new': 'false'});
  await assertOriginal(gw, original);
});

test('useOld without previous drops new and preserves live', async t => {
  const gw = await tenants(t); const original = await seed(gw); await deploy(gw);
  await mutate(gw, 'useOldAccountVersion'); await assertOriginal(gw, original);
  await mutate(gw, 'useOldAccountVersion'); await assertOriginal(gw, original);
});

test('deploy/abandon keep previous; subsequent accept replaces previous', async t => {
  const gw = await tenants(t); const original = await seed(gw); await deploy(gw);
  await mutate(gw, 'useNewAccountVersion');
  const store = gw.server.tenants.get(A.id).store; const previous = structuredClone(store.state.slots.old);
  await mutate(gw, 'deployNewAccountVersion');
  assert.deepEqual(store.state.slots.old, previous);
  await mutate(gw, 'abandonSlot');
  assert.deepEqual(store.state.slots.old, previous); assert.equal(store.state.slots.new, undefined);
  await mutate(gw, 'useNewAccountVersion'); assert.deepEqual(store.state.slots.old, previous);
  await mutate(gw, 'useOldAccountVersion'); await assertOriginal(gw, original);
  await deploy(gw); await mutate(gw, 'useNewAccountVersion');
  const firstAccepted = structuredClone({types: store.state.types, docs: store.state.docs, tombstones: store.state.tombstones});
  await mutate(gw, 'deployNewAccountVersion');
  await gw.request('/_doc/second?version=new', {method: 'POST', auth: basic(A), body: document()});
  await mutate(gw, 'useNewAccountVersion');
  for (const field of ['types', 'docs', 'tombstones']) assert.deepEqual(store.state.slots.old[field], firstAccepted[field]);
  await mutate(gw, 'useOldAccountVersion');
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A)})), ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']);
});

test('previous persists as old NDJSON records and a reopened store/server still reverts', async t => {
  const first = await tenants(t); const original = await seed(first); await deploy(first);
  await mutate(first, 'useNewAccountVersion');
  // Preserve an empty new marker alongside old across restart as well.
  await mutate(first, 'deployNewAccountVersion');
  await new Promise((resolve, reject) => first.server.close(error => error ? reject(error) : resolve()));
  const dataDir = join(first.root, 'data', A.id);
  const records = readFileSync(join(dataDir, 'store.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const marker = records.find(record => record.record === 'slot' && record.slot === 'old');
  assert.equal(marker.typesUpdated, original.metadata.liveTypesUpdated); assert.equal(marker.typesMethod, 'POST');
  for (const record of ['types', 'docs', 'tombstones']) assert.ok(records.some(entry => entry.record === record && entry.slot === 'old'));
  const reopened = new Store({dataDir, logger: quiet});
  assert.equal(Object.keys(reopened.state.slots.old.docs).length, 2); assert.ok(reopened.state.slots.new);
  const second = await gateway(t, first.options);
  await mutate(second, 'useOldAccountVersion'); await assertOriginal(second, original);
});

test('legacy stores without old load unchanged; unknown NDJSON slot names are rejected', t => {
  const legacyDir = scratch(t);
  writeFileSync(join(legacyDir, 'store.json'), JSON.stringify({types: {default: MODEL}, docs: {legacy: {raw: document()}}, slots: {new: {types: {}, docs: {}, tombstones: {}}}}));
  const legacy = new Store({dataDir: legacyDir, logger: quiet});
  assert.ok(legacy.state.docs.legacy); assert.ok(legacy.state.slots.new); assert.equal(legacy.state.slots.old, undefined);
  for (const record of ['slot', 'types', 'docs', 'tombstones']) {
    const dataDir = scratch(t); const errors = [];
    writeFileSync(join(dataDir, 'store.ndjson'), [{record: 'header', version: 1}, {record, slot: 'unexpected', id: 'bad', value: document()}, {record: 'end'}].map(JSON.stringify).join('\n'));
    const store = new Store({dataDir, logger: {error: message => errors.push(message)}});
    assert.deepEqual(store.state.slots, {}); assert.deepEqual(store.state.docs, {});
    assert.match(errors[0], /Invalid slot/);
  }
});

for (const [name, clear] of [
  ['reset()', async gw => { gw.server.tenants.get(A.id).store.reset(); gw.server.tenants.get(A.id).rebuild(); }],
  ['sources mode=reset', gw => gw.request('/api/content/v3/sources?id=default&mode=reset', {method: 'DELETE', auth: basic(A)})],
  ['data purge', gw => gw.request('/api/content/v2/data?id=default', {method: 'DELETE', auth: basic(A)})],
  ['dashboard content', gw => gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['content']}})],
  ['dashboard all', gw => gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['all']}})],
]) test(`${name} clears previous and prevents revert resurrecting content`, async t => {
  const gw = await tenants(t); await seed(gw); await deploy(gw); await mutate(gw, 'useNewAccountVersion');
  const result = await clear(gw); if (result) assert.equal(result.status, 200);
  if (name === 'dashboard content' || name === 'dashboard all') { assert.equal(result.data.removed.docs, 5); assert.equal(result.data.removed.tombstones, 2); }
  assert.equal((await gw.request(base + '/stats', {auth: null})).data.slots.old, null);
  await mutate(gw, 'useOldAccountVersion'); assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A)})), []);
});

test('dashboard types clears previous types and metadata along with live/new', async t => {
  const gw = await tenants(t); await seed(gw); await deploy(gw); await mutate(gw, 'useNewAccountVersion'); await deploy(gw);
  const store = gw.server.tenants.get(A.id).store;
  const contentTypes = [store.state, store.state.slots.new, store.state.slots.old].reduce((count, slot) => count + Object.keys(slot.types.default.contentTypes).length, 0);
  const result = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['types']}});
  assert.equal(result.status, 200); assert.equal(result.data.removed.contentTypes, contentTypes);
  assert.deepEqual(store.state.slots.old.types, {}); assert.equal(Object.keys(store.state.slots.old.docs).length, 2);
  assert.equal(store.state.slots.old.typesUpdated, undefined); assert.equal(store.state.slots.old.typesMethod, undefined);
  await mutate(gw, 'useOldAccountVersion');
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A)})), ['original-1', 'original-2']);
  assert.deepEqual(store.state.types, {}); assert.deepEqual(store.state.metadata, {});
  assert.ok((await gw.gql('{OriginalPage{total}}', {}, {auth: basic(A)})).errors);
});

test('cg-query-new selects new for GET/POST, preserves cg-use-new and defaults to live', async t => {
  const gw = await tenants(t); await seed(gw); await deploy(gw);
  const cases = [
    [{}, ['original-1', 'original-2']],
    [{'cg-query-new': 'true'}, ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']],
    [{'cg-query-new': 'TrUe'}, ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']],
    [{'cg-use-new': 'TRUE'}, ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']],
    [{'cg-query-new': 'false', 'cg-use-new': 'true'}, ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']],
    [{'cg-query-new': 'true', 'cg-use-new': 'false'}, ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']],
    [{'cg-query-new': 'false', 'cg-use-new': 'false'}, ['original-1', 'original-2']],
  ];
  for (const [headers, expected] of cases) {
    for (const method of ['GET', 'POST']) {
      const result = await gw.request('/content/v2' + (method === 'GET' ? '?query=' + encodeURIComponent(query) : ''), {method, auth: `epi-single ${A.singleKey}`, headers, ...(method === 'POST' ? {body: {query}} : {})});
      assert.equal(result.status, 200); assert.deepEqual(ids(result.data), expected);
    }
  }
  await mutate(gw, 'useNewAccountVersion');
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A), headers: {'cg-query-new': 'true'}})), []);
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A), headers: {'cg-use-new': 'true'}})), []);
  assert.deepEqual(ids(await gw.gql(query, {}, {auth: basic(A), headers: {'cg-query-new': 'old'}})), ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']);
});

test('CORS preflight includes cg-query-new', async t => {
  const gw = await tenants(t);
  const result = await gw.request('/content/v2', {method: 'OPTIONS', auth: null, headers: {Origin: 'http://localhost:3000', 'Access-Control-Request-Headers': 'cg-query-new'}});
  assert.equal(result.status, 204);
  const allowed = result.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
  assert.ok(allowed.includes('cg-query-new')); assert.ok(allowed.includes('cg-use-new'));
});

test('dashboard document/model/schema selection accepts cg-query-new and compatibility headers', async t => {
  const gw = await tenants(t); await seed(gw); await deploy(gw);
  for (const headers of [{'cg-query-new': 'TrUe'}, {'cg-use-new': 'TRUE'}]) {
    assert.deepEqual((await gw.request(base + '/docs', {auth: null, headers})).data.map(doc => doc.id).sort(), ['rebuilt-1', 'rebuilt-2', 'rebuilt-3']);
    assert.equal((await gw.request(base + '/docs/rebuilt-1', {auth: null, headers})).data.normalized._id, 'rebuilt-1');
    assert.equal((await gw.request(base + '/documents/rebuilt-1', {auth: null, headers})).status, 200);
    assert.deepEqual((await gw.request(base + '/types', {auth: null, headers})).data, newModel);
    const schema = (await gw.request(base + '/schema', {auth: null, headers})).data;
    assert.match(schema, /RebuiltPage/); assert.ok(!schema.includes('OriginalPage'));
  }
  assert.equal((await gw.request(base + '/docs/rebuilt-1', {auth: null})).status, 404);
  assert.deepEqual((await gw.request(base + '/types', {auth: null})).data, liveModel);
});

function runPlayground(html) {
  const configs = []; const renders = []; let change;
  const GraphiQL = {createFetcher: config => { configs.push(config); return config; }};
  const document = {getElementById: () => ({addEventListener: (event, listener) => { assert.equal(event, 'change'); change = listener; }})};
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  runInNewContext(script, {GraphiQL, document, ReactDOM: {createRoot: () => ({render: element => renders.push(element)})}, React: {createElement: (_, props) => props}});
  return {configs, renders, change};
}

test('known keys serve same tenant GraphiQL config; live/new toggle switches same-origin query headers', async t => {
  const gw = await tenants(t);
  for (const tenant of [A, B]) for (const slot of ['live', 'new']) {
    const suffix = slot === 'new' ? '&slot=new' : '';
    const result = await gw.request(`/app/graphiql?auth=${tenant.singleKey}${suffix}`, {auth: null});
    assert.equal(result.status, 200); assert.match(result.headers.get('content-type'), /^text\/html/);
    assert.equal(result.data, (await gw.request(`/graphiql?tenant=${tenant.id}${suffix}`, {auth: null})).data);
    assert.match(result.data, /Query:/); assert.match(result.data, /<select id="query-slot">/); assert.match(result.data, />new slot<\/option>/);
    assert.ok(!result.data.includes('cg-use-new'));
    assert.match(result.data, new RegExp(`<option value="${slot}" selected>`));
    const browser = runPlayground(result.data);
    assert.equal(browser.configs[0].url, '/content/v2'); assert.equal(browser.configs[0].headers.Authorization, `epi-single ${tenant.singleKey}`);
    assert.equal(browser.configs[0].headers['cg-query-new'], slot === 'new' ? 'true' : undefined);
    browser.change({target: {value: 'new'}});
    assert.equal(browser.configs.at(-1).headers['cg-query-new'], 'true');
    browser.change({target: {value: 'live'}});
    assert.equal(browser.configs.at(-1).headers['cg-query-new'], undefined);
    assert.equal(browser.configs.at(-1).headers.Authorization, `epi-single ${tenant.singleKey}`);
    assert.equal(browser.renders.length, 3);
  }
});

test('missing/unknown auth returns 404 HTML Unknown Graph key', async t => {
  const gw = await tenants(t);
  for (const path of ['/app/graphiql', '/app/graphiql?auth=', '/app/graphiql?auth=unknown', '/app/graphiql?auth=' + A.appKey]) {
    const result = await gw.request(path, {auth: null});
    assert.equal(result.status, 404); assert.match(result.headers.get('content-type'), /^text\/html/); assert.match(result.data, /Unknown Graph key/);
  }
});

function navigation(gw, path, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(gw.base + path, {headers: {Host: host, Accept: 'text/html', 'Sec-Fetch-Dest': 'iframe'}}, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', part => { data += part; });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, data})); response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('iframe navigation accepts loopback Host with no framing headers and retains Host protection', async t => {
  const gw = await tenants(t); const port = gw.server.address().port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    const result = await navigation(gw, '/app/graphiql?auth=' + A.singleKey, host);
    assert.equal(result.status, 200); assert.ok(result.data.includes('epi-single ' + A.singleKey));
    assert.equal(result.headers['x-frame-options'], undefined); assert.equal(result.headers['content-security-policy'], undefined);
  }
  assert.equal((await navigation(gw, '/app/graphiql?auth=' + A.singleKey, `evil.example:${port}`)).status, 403);
  // CMS tenant keys suffice for this page even when dashboard access needs ADMIN.
  const remote = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  assert.equal((await remote.request('/app/graphiql?auth=' + A.singleKey, {auth: null})).status, 200);
});

test('app/graphiql auth URL stays redacted in console, ring and disk logs', async t => {
  const lines = []; const gw = await tenants(t, {logger: {log: line => lines.push(line), error() {}}});
  await gw.request('/app/graphiql?auth=' + A.singleKey + '&slot=new', {auth: null});
  await gw.request('/app/graphiql?auth=unknown-secret', {auth: null});
  assert.equal(gw.server.tenants.get(A.id, false).log.recent.at(-1).url, '/app/graphiql?auth=***&slot=new');
  for (const id of [A.id, '_unrouted']) {
    const entries = readFileSync(join(gw.root, 'logs', id, 'requests.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(entries.every(entry => entry.url.includes('auth=***')));
    assert.ok(entries.every(entry => !entry.url.includes(A.singleKey) && !entry.url.includes('unknown-secret')));
  }
  assert.ok(lines.every(line => !line.includes(A.singleKey) && !line.includes('unknown-secret')));
});
