import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {validateTenants} from '../src/tenants.js';
import {createServer, configuration} from '../src/server.js';
import {Store} from '../src/store.js';
import {RequestLog} from '../src/request-log.js';
import {MODEL, document, index, ID} from './fixtures.js';
import {quiet, success, gateway, replaySynthetic} from './helpers.js';
import {HOME_ID} from './synthetic-fixtures.js';
import {A, B, basic, preview, tenants, scratch, eventually} from './tenant-helpers.js';

test('tenant config validates identifiers and cross-key uniqueness, warns on Base64 and ignores env keys', async t => {
  const bad = [
    [{...A, id: '../escape'}], [{...A, id: 'A'}], [{...A, id: 'a'.repeat(64)}], [A, {...B, id: A.id}],
    [{...A, appKey: ''}], [{...A, singleKey: ''}], [{...A, secret: ''}], [A, {...B, singleKey: A.appKey}],
    [A, {...B, appKey: A.singleKey}], [A, {...B, appKey: A.appKey}], [A, {...B, singleKey: A.singleKey}], [{...A, name: 7}],
  ];
  for (const entries of bad) assert.throws(() => validateTenants({tenants: entries}, quiet), /Tenant entry/);
  assert.throws(() => validateTenants({}, quiet), /tenants array/);
  assert.equal(validateTenants({tenants: [{...A, name: ''}]}, quiet)[0].name, A.id);
  const warnings = []; const logger = {log() {}, error: value => warnings.push(value)};
  assert.equal(validateTenants({tenants: [{...A, secret: 'bad secret'}]}, logger)[0].secret, 'bad secret');
  assert.ok(warnings.some(value => /Base64/.test(value)));
  const gw = await tenants(t, {appKey: 'ignored', secret: '', singleKey: 'ignored', logger});
  assert.ok(warnings.some(value => /ignored/.test(value)));
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: basic(A), body: {query: '{_Content{total}}'}})).status, 200);
  writeFileSync(gw.file, '{bad');
  assert.throws(() => createServer({...gw.options, logger: quiet}), /Invalid .*tenants.json/);
  assert.equal(configuration({TENANTS_FILE: 'accounts.json', ADMIN_USER: 'manager', ADMIN_PASSWORD: 'password'}).tenantsFile, 'accounts.json');
});

test('credential routing separates Basic, single, query-param and preview tenants; unrouted failures are logged', async t => {
  const lines = []; const gw = await tenants(t, {logger: {log: line => lines.push(line), error() {}}});
  for (const tenant of [A, B]) {
    await gw.request('/api/content/v3/types', {method: 'PUT', body: MODEL, auth: basic(tenant)});
    await gw.request('/_stream', {method: 'POST', body: index('same', document({metadata: {displayName: tenant.name}})) + index('draft', document({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']})), auth: basic(tenant)});
    assert.equal(success(await gw.gql('{_Content{total}}', {}, {auth: basic(tenant)}), '_Content').total, 2);
    for (const [path, auth] of [['/content/v2', `epi-single ${tenant.singleKey}`], ['/content/v2?auth=' + tenant.singleKey, null]]) {
      const output = await gw.request(path, {method: 'POST', auth, body: {query: '{_Content{total items{_metadata{displayName}}}}'}});
      assert.equal(success(output.data, '_Content').total, 1); assert.equal(output.data.data._Content.items[0]._metadata.displayName, tenant.name);
    }
    assert.equal(success(await gw.gql('{_Content{total}}', {}, {auth: preview(tenant)}), '_Content').total, 2);
    const mutation = await gw.gql('mutation{deployNewAccountVersion}', {}, {auth: preview(tenant)}); assert.ok(mutation.errors);
    assert.equal((await gw.request('/_stream', {method: 'POST', body: '', auth: preview(tenant)})).status, 401);
    assert.equal((await gw.request('/api/webhooks', {auth: `epi-single ${tenant.singleKey}`})).status, 401);
  }
  for (const auth of [null, 'epi-single unknown', basic(A, 'wrong'), basic({...A, appKey: 'unknown'}), preview(B, A), preview(A, A, {iss: 'wrong'}), 'Bearer bad', 'Basic ###']) {
    const result = await gw.request('/content/v2', {method: 'POST', auth, body: {query: '{_Content{total}}'}});
    assert.equal(result.status, 401); assert.deepEqual(result.data, {message: 'Unknown or missing credentials'});
  }
  const unrouted = readFileSync(join(gw.root, 'logs', '_unrouted', 'requests.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(unrouted.length, 8); assert.ok(unrouted.every(entry => entry.status === 401));
  assert.ok(lines.some(line => /^\[site-a\] POST \/_stream 200 .*ops=2 journal=/.test(line)));
  assert.ok(lines.some(line => /^\[_unrouted\]/.test(line)));
});

test('same synthetic fixtures remain isolated across docs, schemas, slots, tombstones, journals, jobs, webhooks and logs', async t => {
  const gw = await tenants(t); const journals = {};
  for (const tenant of [A, B]) {
    journals[tenant.id] = await replaySynthetic(gw.request, {auth: basic(tenant)});
    assert.equal(success(await gw.gql('{_Content(locale:en){total}}', {}, {auth: basic(tenant)}), '_Content').total, 5);
    assert.equal(success(await gw.gql('{_Content(locale:ALL){total}}', {}, {auth: basic(tenant)}), '_Content').total, 11);
  }
  const a = gw.server.tenants.get(A.id); const b = gw.server.tenants.get(B.id); const bDocs = structuredClone(b.store.state.docs);
  assert.deepEqual(Object.keys(a.store.state.docs).sort(), Object.keys(bDocs).sort());
  assert.deepEqual(a.store.state.docs[HOME_ID].raw, bDocs[HOME_ID].raw);
  assert.notEqual(journals[A.id], journals[B.id]);
  const bTombstones = structuredClone(b.store.state.tombstones);
  await gw.request('/_doc/same', {method: 'POST', body: document({metadata: {displayName: 'Only A'}}), auth: basic(A)});
  assert.equal(success(await gw.gql('{ArticlePage(ids:["same"]){total item{_metadata{displayName}}}}', {}, {auth: basic(A)}), 'ArticlePage').item._metadata.displayName, 'Only A');
  assert.equal(success(await gw.gql('{ArticlePage(ids:["same"]){total}}', {}, {auth: basic(B)}), 'ArticlePage').total, 0);
  const aModel = a.store.state.types.default;
  await gw.request('/api/content/v3/types', {method: 'PUT', body: {...aModel, contentTypes: {...aModel.contentTypes, OnlyA: {contentType: ['_Content'], properties: {}}}}, auth: basic(A)});
  assert.ok(!(await gw.gql('{OnlyA{total}}', {}, {auth: basic(A)})).errors); assert.ok((await gw.gql('{OnlyA{total}}', {}, {auth: basic(B)})).errors);
  assert.equal((await gw.request('/journal/stream/' + journals[A.id], {auth: basic(B)})).status, 404);
  await gw.request('/journal/indexing', {method: 'POST', auth: basic(A), body: {id: 'a-private-job', details: [{id: journals[A.id]}]}});
  assert.equal((await gw.request('/journal/indexing/a-private-job', {auth: basic(B)})).status, 404);
  assert.equal((await gw.request('/journal/indexing/a-private-job/status', {auth: basic(B)})).status, 404);
  await gw.gql('mutation{deployNewAccountVersion}', {}, {auth: basic(A)});
  await gw.request('/_stream', {method: 'POST', auth: basic(A), body: index('new-doc', document()), headers: {'cg-deploy-new': 'true'}});
  a.store.delete('same', {snapshotTime: '2026-10-14T12:00:00Z'});
  await gw.request('/api/webhooks', {method: 'POST', auth: basic(A), body: {url: 'http://local-a'}});
  assert.equal((await gw.request('/api/webhooks', {auth: basic(B)})).data.length, 0);
  assert.equal(b.store.state.slots.new, undefined); assert.deepEqual(b.store.state.tombstones, bTombstones); assert.deepEqual(b.store.state.docs, bDocs);
  for (const runtime of [a, b]) {
    assert.ok(runtime.log.recent.every(entry => entry.headers.authorization === 'Basic'));
    await runtime.store.flush(); assert.ok(existsSync(join(gw.root, 'data', runtime.tenant.id, 'store.ndjson')));
    assert.ok(existsSync(join(gw.root, 'logs', runtime.tenant.id, 'requests.ndjson')));
  }
  assert.ok(!b.log.recent.some(entry => entry.url === '/_doc/same'));
});

test('hot reload adds, rotates, renames and removes tenants; invalid edits preserve config and retained data', async t => {
  const errors = []; const gw = await tenants(t, {logger: {log() {}, error: value => errors.push(value)}});
  const c = {...A, id: 'site-c', name: 'Site C', appKey: 'app-c', singleKey: 'public-c'};
  writeFileSync(gw.file, JSON.stringify({tenants: [A, B, c]}));
  await eventually(async () => (await gw.request('/content/v2', {method: 'POST', auth: basic(c), body: {query: '{_Content{total}}'}})).status === 200, 'New tenant must route after watched change');
  await gw.request('/_doc/keep', {method: 'POST', auth: basic(c), body: document()}); await gw.server.tenants.get(c.id).store.flush();
  writeFileSync(gw.file, JSON.stringify({tenants: [A, {...B, appKey: A.appKey}]}));
  await eventually(() => errors.some(error => /reload rejected/.test(error)), 'Invalid edit must be reported');
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: basic(c), body: {query: '{_Content{total}}'}})).status, 200);
  const rotated = {...c, name: 'Renamed C', secret: B.secret, singleKey: 'new-public-c'};
  writeFileSync(gw.file, JSON.stringify({tenants: [A, B, rotated]}));
  await eventually(() => gw.server.tenants.find(c.id)?.name === 'Renamed C', 'Name and keys must reload');
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: basic(c), body: {query: '{_Content{total}}'}})).status, 401);
  assert.equal(success(await gw.gql('{_Content{total}}', {}, {auth: basic(rotated)}), '_Content').total, 1);
  writeFileSync(gw.file, JSON.stringify({tenants: [A, B]}));
  await eventually(() => !gw.server.tenants.find(c.id), 'Removed tenant must leave routing');
  assert.ok(existsSync(join(gw.root, 'data', c.id, 'store.ndjson')));
  writeFileSync(gw.file, JSON.stringify({tenants: [A, B, rotated]}));
  await eventually(() => Boolean(gw.server.tenants.find(c.id)), 'Tenant can be added back');
  assert.equal(success(await gw.gql('{_Content{total}}', {}, {auth: basic(rotated)}), '_Content').total, 1);
});

test('stores load lazily and root NDJSON/JSON migrate into default without overwriting existing folders', async t => {
  for (const format of ['ndjson', 'json']) {
    const root = scratch(t); const dataDir = join(root, 'data'); mkdirSync(dataDir);
    if (format === 'ndjson') { const old = new Store({dataDir, logger: quiet}); old.setTypes(MODEL); old.upsert(ID, document()); await old.flush(); }
    else writeFileSync(join(dataDir, 'store.json'), JSON.stringify({types: {default: MODEL}, docs: {[ID]: {raw: document()}}}));
    const gw = await gateway(t, {dataDir, tenantsFile: join(root, 'missing.json')});
    const initial = (await gw.request('/health', {auth: null})).data;
    assert.deepEqual(initial.tenants.default, {loaded: false, docs: 0});
    assert.ok(existsSync(join(dataDir, 'default', 'store.' + format))); assert.ok(!existsSync(join(dataDir, 'store.' + format)));
    assert.equal(success(await gw.gql('{ArticlePage{total}}'), 'ArticlePage').total, 1);
    assert.deepEqual((await gw.request('/health')).data.tenants.default, {loaded: true, docs: 1});
    writeFileSync(join(dataDir, 'store.json'), JSON.stringify({docs: {shouldNotReplace: document()}}));
    const second = await gateway(t, {dataDir, tenantsFile: join(root, 'missing.json')});
    assert.ok(existsSync(join(dataDir, 'store.json'))); assert.equal(success(await second.gql('{ArticlePage{total}}'), 'ArticlePage').total, 1);
  }
  const gw = await tenants(t);
  assert.deepEqual((await gw.request('/health', {auth: null})).data.tenants, {[A.id]: {loaded: false, docs: 0}, [B.id]: {loaded: false, docs: 0}});
  await gw.gql('{_Content{total}}', {}, {auth: basic(A)});
  assert.deepEqual((await gw.request('/health')).data.tenants[B.id], {loaded: false, docs: 0});
});

test('a missing custom config directory is watched when created later', async t => {
  const root = scratch(t); const parent = join(root, 'later'); const file = join(parent, 'tenants.json');
  const gw = await gateway(t, {tenantsFile: file});
  mkdirSync(parent); writeFileSync(file, JSON.stringify({tenants: [A, B]}));
  await eventually(() => Boolean(gw.server.tenants.find(A.id)), 'Config creation must switch env mode to file mode');
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: basic(A), body: {query: '{_Content{total}}'}})).status, 200);
});

test('tenant logs restore 500 complete Unicode entries across rotation and keep numbering monotonic', t => {
  const root = scratch(t); const log = new RequestLog(root, quiet);
  for (let n = 0; n < 500; n++) log.append({ts: 'now', reqBody: '🙂'.repeat(2000)});
  renameSync(join(root, 'requests.ndjson'), join(root, 'requests.ndjson.1'));
  for (let n = 0; n < 10; n++) log.append({ts: 'now', reqBody: 'recent'});
  const restored = new RequestLog(root, quiet); restored.load();
  assert.equal(restored.recent.length, 500); assert.equal(restored.recent[0].n, 11); assert.equal(restored.recent[0].reqBody, '🙂'.repeat(2000));
  restored.append({ts: 'next'}); assert.equal(restored.recent.at(-1).n, 511);
  assert.deepEqual(restored.clear(), {requests: 500, requestFiles: 2});
});
