import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {Store} from '../src/store.js';
import {configuration} from '../src/server.js';
import {gateway, success, quiet} from './helpers.js';
import {MODEL, ID, document, index} from './fixtures.js';

function scratch(t) {
  const root = resolve(tmpdir());
  const folder = mkdtempSync(join(root, 'local-graph-test-'));
  t.after(() => {
    const path = resolve(folder); const inside = relative(root, path);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Cleanup must remain in the temporary directory');
    rmSync(path, {recursive: true, force: true});
  });
  return folder;
}

test('configuration defaults and environment overrides', () => {
  assert.deepEqual(configuration({}), {port: 8082, host: '127.0.0.1', corsOrigins: '*', appKey: '', secret: '', singleKey: '', tenantsFile: './tenants.json', publicHostnames: '', adminUser: '', adminPassword: '', dataDir: './data', logDir: './logs', logBodies: true});
  assert.deepEqual(configuration({PORT: '0', HOST: 'localhost', CORS_ORIGINS: 'https://app.example', GRAPH_APP_KEY: 'a', GRAPH_SECRET: 's', GRAPH_SINGLE_KEY: 'k', DATA_DIR: ':memory:', LOG_DIR: 'l', LOG_BODIES: 'false'}), {port: 0, host: 'localhost', corsOrigins: 'https://app.example', appKey: 'a', secret: 's', singleKey: 'k', tenantsFile: './tenants.json', publicHostnames: '', adminUser: '', adminPassword: '', dataDir: ':memory:', logDir: 'l', logBodies: false});
});

test('disk round-trip and debounced writes preserve live + new slots', async t => {
  const dataDir = scratch(t);
  const store = new Store({dataDir, logger: quiet});
  store.setTypes(MODEL); store.upsert(ID, document());
  const journal = store.stream(index('second'));
  store.addJob({id: 'job', details: [{id: journal}]});
  store.state.webhooks.push({id: 'hook', url: 'local'});
  store.mutate('deployNewAccountVersion'); store.setTypes(MODEL, {slot: 'new'}); store.upsert('new', document(), {slot: 'new'});
  assert.equal(existsSync(join(dataDir, 'store.ndjson')), false);
  await new Promise(resolve => setTimeout(resolve, 650));
  await store.writing;
  assert.equal(existsSync(join(dataDir, 'store.ndjson')), true);
  assert.equal(existsSync(join(dataDir, 'store.ndjson.tmp')), false);
  const restored = new Store({dataDir, logger: quiet});
  assert.deepEqual(restored.state, store.state);
  assert.equal(restored.jobStatus('job').status, 'Success');
  assert.ok(restored.slot('new').docs.new); await restored.flush();
});

test('journal/job retention caps survive flush; memory mode writes no disk', async t => {
  const dataDir = scratch(t);
  const store = new Store({dataDir, logger: quiet});
  for (let i = 0; i < 1005; i++) store.stream('');
  for (let i = 0; i < 205; i++) store.addJob({id: `job${i}`, details: []});
  await store.flush();
  const data = new Store({dataDir, logger: quiet}).state;
  assert.equal(Object.keys(data.journals).length, 1000); assert.equal(Object.keys(data.jobs).length, 200); assert.equal(Object.hasOwn(data.jobs, 'job0'), false);
  const memory = new Store({dataDir: ':memory:'}); memory.changed(); await memory.flush(); assert.equal(memory.timer, null);
});

test('server close flushes pending changes and restart rebuilds schema from disk', async t => {
  const dataDir = scratch(t);
  const first = await gateway(t, {dataDir}); await first.seed();
  await new Promise((resolve, reject) => first.server.close(error => error ? reject(error) : resolve()));
  const second = await gateway(t, {dataDir});
  assert.equal(success(await second.gql('{ArticlePage{items{Heading} total}}'), 'ArticlePage').total, 1);
  await new Promise((resolve, reject) => second.server.close(error => error ? reject(error) : resolve()));
});

test('every HTTP request is logged; auth redacted, NDJSON text, bodies bounded, console details', async t => {
  const logDir = scratch(t); const lines = [];
  const {request, seed, gql} = await gateway(t, {logDir, logger: {log: line => lines.push(line), error: line => lines.push(line)}});
  await seed(); await gql('{_Content{total}}', {}, {headers: {'X-Query-Name': 'NamedQuery'}});
  await request('/clientlog', {method: 'POST', body: {content: 'x'.repeat(70000)}});
  await request('/missing');
  const entries = readFileSync(join(logDir, 'default', 'requests.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 5);
  assert.equal(entries[0].headers.authorization, 'Basic'); assert.equal(entries[1].reqBody, index());
  assert.equal(entries[2].headers['x-query-name'], 'NamedQuery'); assert.equal(entries[2].status, 200);
  assert.ok(Buffer.byteLength(entries[3].reqBody) <= 65536); assert.equal(entries[4].status, 404);
  assert.ok(lines.some(line => /POST \/_stream 200 \d+ms ops=1 journal=/.test(line)));
});

test('log body toggle, request ring cap, debug filters, SDL, dashboard and pinned GraphiQL', async t => {
  const {request, seed, server} = await gateway(t, {logBodies: false, singleKey: 'public'}); await seed();
  assert.equal((await request('/health', {auth: null})).data.status, 'ok');
  assert.equal((await request('/__debug/docs?type=ArticlePage&locale=en&status=Published&q=Quick')).data.length, 1);
  assert.equal((await request('/__debug/docs?locale=sv')).data.length, 0);
  assert.equal((await request('/__debug/docs/absent')).status, 404);
  assert.match((await request('/__debug/schema')).data, /interface _IContent/);
  const dashboard = (await request('/tenants/default')).data;
  assert.match(dashboard, /1 live documents/); assert.match(dashboard, /ArticlePage/);
  assert.match(dashboard, /tenants\/default\/request/);
  const html = (await request('/graphiql')).data;
  for (const version of ['react@18.3.1', 'react-dom@18.3.1', 'graphiql@3.7.1', 'epi-single public']) assert.ok(html.includes(version));
  for (let i = 0; i < 505; i++) await request('/health');
  assert.equal(server.recentRequests.length, 500);
  const logs = (await request('/__debug/requests?limit=3')).data;
  assert.equal(logs.length, 3); assert.equal(logs[0].reqBody, null); assert.equal(logs[0].resBody, null);
  assert.deepEqual((await request('/__debug/requests?limit=0')).data, []);
});

test('Unicode body truncation stays within the 64 KB UTF-8 limit', async t => {
  const {request, server} = await gateway(t);
  await request('/clientlog', {method: 'POST', body: 'aa' + '🙂'.repeat(20000)});
  assert.ok(Buffer.byteLength(server.recentRequests.at(-1).reqBody) <= 65536);
});
