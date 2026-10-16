import {product} from '../src/product.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {configuration, createServer} from '../src/server.js';
import {validateTenants} from '../src/tenants.js';
import {Store} from '../src/store.js';
import {RequestLog} from '../src/request-log.js';
import {gateway, quiet, success} from './helpers.js';
import {A, B, basic, preview, tenants, scratch, csrf, postForm, eventually} from './tenant-helpers.js';
import {MODEL, document, index} from './fixtures.js';

const ADMIN = 'Basic ' + Buffer.from('manager:password').toString('base64');
const formValues = html => Object.fromEntries([...html.matchAll(/<input[^>]*name="(id|name|appKey|singleKey|secret)"[^>]*value="([^"]*)"/g)].map(match => [match[1], match[2]]));
const noCors = result => { for (const [key] of result.headers) assert.ok(!key.startsWith('access-control-'), key); assert.equal(result.headers.get('vary'), null); };
function networkRequest(gw, path, {host = 'graph.lan', origin, auth, method = 'GET', body} = {}) {
  return new Promise((resolveRequest, reject) => {
    const request = http.request(gw.base + path, {method, headers: {Host: host, ...(origin ? {Origin: origin} : {}), ...(auth ? {Authorization: auth} : {}), ...(body !== undefined ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})}}, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; });
      response.on('end', () => resolveRequest({status: response.statusCode, data: text, headers: new Headers(response.headers)}));
      response.on('error', reject);
    });
    request.on('error', reject); request.end(body);
  });
}

test('env-to-file preserves explicit env keys and requires a deliberate default-key setup for empty keys', async t => {
  const root = scratch(t); const file = join(root, 'custom', 'accounts.json');
  const explicit = {appKey: 'env-app', secret: A.secret, singleKey: 'env-public'};
  const gw = await gateway(t, {tenantsFile: file, ...explicit});
  const html = (await gw.request('/', {auth: null})).data;
  assert.ok(html.includes(resolve(file))); assert.ok(!html.includes('Give the default instance explicit keys first'));
  assert.equal((await postForm(gw, '/tenants', {name: A.name, csrf: csrf(html)})).status, 303);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tenants[0], {id: 'default', name: 'Default', ...explicit});
  assert.equal(success(await gw.gql('{_Content{total}}', {}, {auth: basic(explicit)}), '_Content').total, 0);
  assert.equal((await gw.request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, auth: 'epi-single env-public'})).status, 200);
  for (const keys of [{appKey: '', secret: '', singleKey: ''}, {...explicit, singleKey: ''}]) {
    const missing = join(root, `missing-${keys.appKey || 'all'}.json`);
    const legacy = await gateway(t, {tenantsFile: missing, ...keys});
    const setup = (await legacy.request('/', {auth: null})).data;
    assert.match(setup, /Give the default instance explicit keys first/); assert.match(setup, /Update the running CMS appsettings/);
    const blocked = await postForm(legacy, '/tenants', {name: B.name, csrf: csrf(setup)});
    assert.equal(blocked.status, 400); assert.ok(!existsSync(missing)); assert.equal(legacy.server.tenants.legacy, true);
    const values = formValues(setup); assert.ok(values.appKey && values.secret && values.singleKey);
    assert.equal(Buffer.from(values.secret, 'base64').length, 32);
    assert.equal((await postForm(legacy, '/tenants/default/edit', {...values, csrf: csrf(setup)})).status, 303);
    assert.ok(existsSync(missing)); assert.equal(legacy.server.tenants.legacy, false);
    assert.equal(success(await legacy.gql('{_Content{total}}', {}, {auth: basic(values)}), '_Content').total, 0);
    assert.equal((await postForm(legacy, '/tenants', {name: B.name, csrf: csrf(setup)})).status, 303);
  }
});

test('remote admin forms accept authenticated request Host origins and PUBLIC_HOSTNAMES', async t => {
  assert.equal(configuration({PUBLIC_HOSTNAMES: 'graph.lan,proxy.example'}).publicHostnames, 'graph.lan,proxy.example');
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  const html = await networkRequest(gw, '/', {auth: ADMIN, origin: 'http://graph.lan'});
  assert.equal(html.status, 200);
  const values = {name: 'Network', csrf: csrf(html.data)};
  for (const origin of ['http://graph.lan', 'https://graph.lan']) {
    assert.equal((await networkRequest(gw, '/tenants', {auth: ADMIN, origin, method: 'POST', body: new URLSearchParams({...values, name: origin.startsWith('https') ? 'Network TLS' : 'Network'}).toString()})).status, 303);
  }
  for (const auth of [undefined, basic(A), 'Basic ' + Buffer.from('manager:wrong').toString('base64')]) assert.equal((await networkRequest(gw, '/', {auth, origin: 'http://graph.lan'})).status, 403);
  assert.equal((await networkRequest(gw, '/', {auth: ADMIN, origin: 'https://evil.example'})).status, 403);
  const publicGw = await tenants(t, {publicHostnames: ' graph.lan, https://proxy.example '});
  assert.equal((await networkRequest(publicGw, '/', {origin: 'http://graph.lan'})).status, 200);
  assert.equal((await networkRequest(publicGw, '/', {host: 'proxy.example', origin: 'https://proxy.example'})).status, 200);
  assert.equal((await networkRequest(publicGw, '/', {host: 'graph.lan.evil', origin: 'http://graph.lan.evil'})).status, 403);
});

test('dashboard and watched ID renames flush and move stores/logs; collisions refuse and removals evict', async t => {
  const gw = await tenants(t); const registry = gw.server.tenants;
  const old = registry.get(A.id); old.store.setTypes(MODEL); old.store.upsert('keep', document());
  old.store.mutate('deployNewAccountVersion'); old.store.upsert('pending', document(), {slot: 'new'});
  old.store.delete('gone', {snapshotTime: '2026-01-01'});
  const journal = old.store.stream(index('journal-doc', document())); old.store.addJob({id: 'job', details: [{id: journal}]});
  const html = (await gw.request('/tenants/' + A.id, {auth: null})).data;
  const moved = {...A, id: 'renamed', appKey: 'rotated-app'};
  old.store.upsert('unflushed', document());
  assert.equal((await postForm(gw, '/tenants/' + A.id + '/edit', {...moved, csrf: csrf(html)})).status, 303);
  assert.ok(!registry.runtimes.has(A.id)); assert.ok(!existsSync(join(gw.root, 'data', A.id))); assert.ok(!existsSync(join(gw.root, 'logs', A.id)));
  assert.ok(existsSync(join(gw.root, 'data', moved.id, 'store.ndjson'))); assert.ok(existsSync(join(gw.root, 'logs', moved.id, 'requests.ndjson')));
  const runtime = registry.get(moved.id); assert.notEqual(runtime, old);
  assert.ok(runtime.store.state.docs.unflushed); assert.ok(runtime.store.slot('new').docs.pending); assert.ok(runtime.store.state.tombstones.gone);
  assert.ok(runtime.store.state.jobs.job); assert.ok(runtime.store.state.journals[journal]); assert.ok(runtime.schemas.live.getType('ArticlePage'));
  const watched = {...moved, id: 'watched'};
  writeFileSync(gw.file, JSON.stringify({tenants: [watched, B]}));
  await eventually(() => Boolean(registry.find(watched.id)), 'Watched rename must apply');
  assert.ok(!existsSync(join(gw.root, 'data', moved.id))); assert.ok(registry.get(watched.id).store.state.docs.keep);
  for (const root of ['data', 'logs']) {
    const collision = {...watched, id: 'collision-' + root}; mkdirSync(join(gw.root, root, collision.id), {recursive: true});
    const before = readFileSync(gw.file, 'utf8');
    const result = await postForm(gw, '/tenants/' + watched.id + '/edit', {...collision, csrf: csrf(html)});
    assert.equal(result.status, 400); assert.match(result.data, /target folder already exists/); assert.equal(readFileSync(gw.file, 'utf8'), before);
    assert.ok(registry.find(watched.id)); assert.ok(registry.get(watched.id).store.state.docs.keep);
  }
  const removed = registry.get(watched.id); removed.store.upsert('last', document());
  await registry.edit(entries => entries.filter(entry => entry.id !== watched.id));
  assert.ok(!registry.runtimes.has(watched.id)); assert.ok(!registry.retired?.size);
  assert.ok(new Store({dataDir: join(gw.root, 'data', watched.id), logger: quiet}).state.docs.last);
  const memory = await tenants(t, {dataDir: ':memory:', logDir: ':memory:'});
  const memoryOld = memory.server.tenants.get(A.id); memoryOld.store.upsert('memory-doc', document());
  memoryOld.log.append({url: '/before-rename'});
  await memory.server.tenants.edit(entries => entries.map(entry => entry.id === A.id ? {...entry, id: 'memory-renamed'} : entry));
  const memoryNew = memory.server.tenants.get('memory-renamed');
  assert.notEqual(memoryNew, memoryOld); assert.ok(memoryNew.store.state.docs['memory-doc']);
  memoryOld.log.append({url: '/finishing-request'}); memoryNew.log.append({url: '/next-request'});
  assert.deepEqual(memoryNew.log.recent.map(entry => entry.n), [1, 2, 3]);
});

test('all dashboard and GraphiQL HTML is same-origin without CORS; GraphQL GET/POST/OPTIONS has CORS', async t => {
  const gw = await tenants(t); const runtime = gw.server.tenants.get(A.id);
  runtime.store.upsert('doc', document()); const journal = runtime.store.stream(index('stream-doc', document())); runtime.store.addJob({id: 'job', details: [{id: journal}]});
  const detail = (await gw.request('/tenants/' + A.id, {auth: null})).data; const n = runtime.log.recent.at(-1).n;
  const base = '/tenants/' + A.id;
  const paths = ['/', base, base + '/edit', base + '/documents/doc', base + '/request/' + n, base + '/sync/job', base + '/journals/' + journal + '?view=html', '/graphiql', '/graphiql?tenant=' + A.id, '/content/v2'];
  for (const path of paths) {
    const result = await gw.request(path, {auth: null, headers: {Accept: 'text/html'}}); assert.equal(result.status, 200, path); noCors(result);
    const cross = await gw.request(path, {auth: null, headers: {Accept: 'text/html', Origin: 'https://evil.example'}}); assert.equal(cross.status, 403, path); noCors(cross);
    const preflight = await gw.request(path === '/content/v2' ? '/graphiql' : path, {method: 'OPTIONS', auth: null, headers: {Origin: 'https://evil.example'}}); assert.equal(preflight.status, 403); noCors(preflight);
  }
  const confirm = await postForm(gw, base + '/confirm', {action: 'content', csrf: csrf(detail)}); assert.equal(confirm.status, 200); noCors(confirm);
  for (const method of ['POST', 'OPTIONS']) {
    const result = await gw.request('/content/v2', {method, auth: method === 'POST' ? 'epi-single ' + A.singleKey : null, headers: {Origin: 'https://app.example'}, ...(method === 'POST' ? {body: {query: '{_Content{total}}'}} : {})});
    assert.equal(result.status, method === 'POST' ? 200 : 204); assert.equal(result.headers.get('access-control-allow-origin'), 'https://app.example'); assert.equal(result.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  }
});

test('clear types counts content and property types across models and slots in JSON and flash', async t => {
  const gw = await tenants(t); const runtime = gw.server.tenants.get(A.id); const base = '/tenants/' + A.id;
  const model = {contentTypes: Object.fromEntries(Array.from({length: 33}, (_, n) => ['Content' + n, {}])), propertyTypes: Object.fromEntries(Array.from({length: 18}, (_, n) => ['Property' + n, {}]))};
  runtime.store.setTypes(model); runtime.rebuild();
  const token = csrf((await gw.request(base, {auth: null})).data);
  const result = await postForm(gw, base + '/clear', {csrf: token, action: 'types', confirm: A.id});
  assert.match(decodeURIComponent(result.headers.get('location')), /Removed 33 content types, 18 property types/);
  runtime.store.setTypes(model); runtime.store.setTypes({contentTypes: {Next: {}}, propertyTypes: {Nested: {}}}, {slot: 'new'});
  runtime.store.setTypes({contentTypes: {Extra: {}}, propertyTypes: {}}, {source: 'another'}); runtime.rebuild();
  const json = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['types']}});
  assert.deepEqual(json.data.removed, {contentTypes: 35, propertyTypes: 19}); assert.deepEqual(runtime.store.state.types, {}); assert.deepEqual(runtime.store.slot('new').types, {});
  assert.equal(runtime.schemas.live.getType('Content0'), undefined);
  assert.deepEqual((await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['types']}})).data.removed, {contentTypes: 0, propertyTypes: 0});
});

test('auth query values are redacted in console, persisted/ring URLs and dashboard details, including unrouted URLs', async t => {
  const lines = []; const gw = await tenants(t, {logger: {log: line => lines.push(line), error() {}}});
  assert.equal((await gw.request('/content/v2?auth=' + A.singleKey + '&cache=false', {method: 'POST', auth: null, body: {query: '{_Content{total}}'}})).status, 200);
  await gw.request('/content/v2?auth=unknown-secret&%61uth=second-secret', {method: 'POST', auth: null, body: {query: '{_Content{total}}'}});
  const runtime = gw.server.tenants.get(A.id); const entry = runtime.log.recent.at(-1);
  assert.equal(entry.url, '/content/v2?auth=***&cache=false');
  for (const id of [A.id, '_unrouted']) {
    const disk = readFileSync(join(gw.root, 'logs', id, 'requests.ndjson'), 'utf8');
    assert.match(disk, /auth=\*\*\*/); for (const key of [A.singleKey, 'unknown-secret', 'second-secret']) assert.ok(!disk.includes(key));
  }
  const page = (await gw.request('/tenants/' + A.id, {auth: null})).data;
  assert.match(page, /auth=\*\*\*/); assert.ok(!page.includes('?auth=' + A.singleKey));
  const detail = (await gw.request('/tenants/' + A.id + '/request/' + entry.n, {auth: null})).data;
  assert.match(detail, /auth=\*\*\*/); assert.ok(!detail.includes(A.singleKey));
  assert.ok(lines.some(line => line.includes('?auth=***&cache=false'))); for (const key of [A.singleKey, 'unknown-secret', 'second-secret']) assert.ok(!lines.join('\n').includes(key));
  const root = scratch(t); writeFileSync(join(root, 'requests.ndjson'), JSON.stringify({n: 1, url: '/content/v2?auth=historical-secret'}) + '\n');
  const restored = new RequestLog(root, quiet); restored.load(); assert.equal(restored.recent[0].url, '/content/v2?auth=***');
});

test('root request logs and rotations migrate with legacy stores and remain visible after restart', async t => {
  for (const format of ['json', 'ndjson']) {
    const root = scratch(t); const dataDir = join(root, 'data'); const logDir = join(root, 'logs'); mkdirSync(dataDir); mkdirSync(logDir);
    if (format === 'json') writeFileSync(join(dataDir, 'store.json'), JSON.stringify({docs: {legacy: {raw: document()}}}));
    else { const store = new Store({dataDir, logger: quiet}); store.upsert('legacy', document()); await store.flush(); }
    for (const [suffix, n] of [['', 4], ['.1', 3], ['.2', 2], ['.3', 1]]) writeFileSync(join(logDir, 'requests.ndjson' + suffix), JSON.stringify({n, ts: '2026-01-01', url: '/legacy-' + n}) + '\n');
    const gw = await gateway(t, {tenantsFile: join(root, 'absent.json'), dataDir, logDir});
    for (const suffix of ['', '.1', '.2', '.3']) { assert.ok(!existsSync(join(logDir, 'requests.ndjson' + suffix))); assert.ok(existsSync(join(logDir, 'default', 'requests.ndjson' + suffix))); }
    const runtime = gw.server.tenants.get('default'); assert.ok(runtime.store.state.docs.legacy); assert.deepEqual(runtime.log.recent.map(entry => entry.n), [1, 2, 3, 4]);
    const log = (await gw.request('/tenants/default/requests', {auth: null})).data; assert.equal(log[0].url, '/legacy-1');
  }
  const root = scratch(t); const logs = join(root, 'logs'); mkdirSync(join(logs, 'default'), {recursive: true});
  writeFileSync(join(logs, 'requests.ndjson'), 'root-original'); writeFileSync(join(logs, 'default', 'requests.ndjson'), 'tenant-original');
  await gateway(t, {tenantsFile: join(root, 'absent.json'), logDir: logs});
  assert.equal(readFileSync(join(logs, 'requests.ndjson'), 'utf8'), 'root-original'); assert.equal(readFileSync(join(logs, 'default', 'requests.ndjson'), 'utf8'), 'tenant-original');
});

test('protocol journals/jobs preserve their wire shapes while dashboard timestamps remain internal', async t => {
  const gw = await tenants(t); const stream = await gw.request('/_stream', {method: 'POST', auth: basic(A), body: index('doc', document())});
  const id = stream.data.journalId; const runtime = gw.server.tenants.get(A.id);
  const result = await gw.request('/journal/stream/' + id, {auth: basic(A)});
  const {ts, ...wire} = runtime.store.state.journals[id]; assert.ok(ts); assert.deepEqual(result.data, wire);
  assert.deepEqual(Object.keys(result.data).sort(), ['errors', 'items', 'status', 'took']);
  const input = {id: 'job', details: [{id: 'stream/' + id, status: 'Processing'}], label: 'CMS job'};
  await gw.request('/journal/indexing', {method: 'POST', auth: basic(A), body: input, headers: {'og-job-id': 'CMS header'}});
  assert.deepEqual((await gw.request('/journal/indexing/job', {auth: basic(A)})).data, input);
  const status = (await gw.request('/journal/indexing/job/status', {auth: basic(A)})).data; assert.equal(status.status, 'Success'); assert.equal(Object.hasOwn(status, 'ts'), false);
  const admin = (await gw.request('/tenants/' + A.id + '/jobs', {auth: null})).data[0]; assert.ok(admin.ts); assert.equal(admin.ogJobId, 'CMS header');
});

test('dashboard writes refuse valid, invalid and deleted hand edits until successful reload', async t => {
  const errors = []; const gw = await tenants(t, {logger: {log() {}, error: line => errors.push(line)}}); const registry = gw.server.tenants;
  const token = csrf((await gw.request('/', {auth: null})).data);
  for (const text of ['{bad json', JSON.stringify({tenants: [A, {...B, name: 'Hand edited'}]})]) {
    writeFileSync(gw.file, text);
    const result = await postForm(gw, '/tenants/' + A.id + '/edit', {...A, name: 'Dashboard change', csrf: token});
    assert.equal(result.status, 400); assert.match(result.data, /tenants.json was changed on disk — reload or fix it first/); assert.equal(readFileSync(gw.file, 'utf8'), text);
    if (text.startsWith('{bad')) { assert.match(result.data, /Invalid /); assert.equal(await registry.reload(), false); }
    else { assert.equal(await registry.reload(), true); assert.equal(registry.find(B.id).name, 'Hand edited'); }
  }
  assert.equal((await postForm(gw, '/tenants/' + A.id + '/edit', {...A, name: 'Dashboard change', csrf: token})).status, 303);
  assert.equal(JSON.parse(readFileSync(gw.file, 'utf8')).tenants[1].name, 'Hand edited');
  assert.ok(errors.some(error => /reload rejected/.test(error)));
  const saved = readFileSync(gw.file, 'utf8'); unlinkSync(gw.file);
  const deleted = await postForm(gw, '/tenants/' + A.id + '/edit', {...A, csrf: token});
  assert.equal(deleted.status, 400); assert.match(deleted.data, /changed on disk/); assert.ok(!existsSync(gw.file));
  writeFileSync(gw.file, saved);
  // Hand edit during the asynchronous flush is checked again before atomic promotion.
  const runtime = registry.get(A.id); const flush = runtime.store.flush.bind(runtime.store);
  const edited = JSON.stringify({tenants: [A, {...B, name: 'During flush'}]});
  runtime.store.flush = async () => { await flush(); writeFileSync(gw.file, edited); };
  const moved = {...A, id: 'racing-rename'};
  const racing = await postForm(gw, '/tenants/' + A.id + '/edit', {...moved, csrf: token});
  assert.equal(racing.status, 400); assert.equal(readFileSync(gw.file, 'utf8'), edited); assert.ok(registry.find(A.id)); assert.ok(existsSync(join(gw.root, 'data', A.id))); assert.ok(!existsSync(join(gw.root, 'data', moved.id)));
  runtime.store.flush = flush;
});

test('remote health exposes tenant details only to valid admin credentials without loading stores', async t => {
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  for (const auth of [null, basic(A), 'Basic ' + Buffer.from('manager:wrong').toString('base64')]) assert.deepEqual((await gw.request('/health', {auth})).data, {status: 'ok', product: product.key, version: product.version, dataVersion: product.dataVersion});
  const authorized = await gw.request('/health', {auth: ADMIN}); assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.data.tenants, {[A.id]: {loaded: false, docs: 0}, [B.id]: {loaded: false, docs: 0}});
  assert.equal(gw.server.tenants.runtimes.size, 0);
  const local = await tenants(t); assert.ok((await local.request('/health', {auth: null})).data.tenants);
});

test('file and dashboard keys enforce safe syntax/length and secrets reject edge whitespace', async t => {
  for (const field of ['appKey', 'singleKey']) for (const value of ['', 'with space', 'colon:key', ' padded', 'padded ', 'a'.repeat(201), 'unicode-é', 'line\nbreak', 'slash/key']) assert.throws(() => validateTenants({tenants: [{...A, [field]: value}]}, quiet), new RegExp(field));
  for (const secret of ['', ' ', ' leading', 'trailing ', '\ttabs', 'newline\n']) assert.throws(() => validateTenants({tenants: [{...A, secret}]}, quiet), /secret/);
  assert.equal(validateTenants({tenants: [{...A, appKey: 'AZaz09._~-', singleKey: 'b'.repeat(200), secret: 'not-base64'}]}, quiet)[0].appKey, 'AZaz09._~-');
  const gw = await tenants(t); const token = csrf((await gw.request('/', {auth: null})).data); const before = readFileSync(gw.file, 'utf8');
  for (const values of [{...A, appKey: 'bad:key'}, {...A, singleKey: 'bad key'}, {...A, secret: ' padded'}]) {
    const result = await postForm(gw, '/tenants/' + A.id + '/edit', {...values, csrf: token}); assert.equal(result.status, 400); assert.equal(readFileSync(gw.file, 'utf8'), before);
  }
  const badFile = join(gw.root, 'invalid-keys.json'); writeFileSync(badFile, JSON.stringify({tenants: [{...A, appKey: 'bad:key'}]}));
  assert.throws(() => createServer({...gw.options, tenantsFile: badFile}), /appKey/);
});

test('dashboard has responsive tenant cards, readable metrics/status/time and sticky section navigation', async t => {
  const gw = await tenants(t); const runtime = gw.server.tenants.get(A.id);
  runtime.store.setTypes(MODEL); runtime.rebuild();
  for (let n = 0; n < 1234; n++) runtime.store.upsert('doc-' + n, document());
  runtime.store.addJob({id: 'success', details: []}); runtime.store.state.jobs.success.ts = new Date(Date.now() - 3 * 60000).toISOString();
  await runtime.store.flush();
  const html = (await gw.request('/', {auth: null})).data;
  assert.match(html, /max-width:1400px/); assert.match(html, /@media\(max-width:1099px\)/);
  assert.match(html, /class="tenant-directory"/); assert.match(html, /class="tenant-cards"/); assert.match(html, /class="tenant-card"/);
  const cards = html.slice(html.indexOf('<div class="tenant-cards">'), html.indexOf('<h2>New tenant'));
  for (const value of ['Site A', 'site-a', '1,234', 'Last full sync', 'Open', 'GraphiQL', 'Keys', 'AppKey', 'SingleKey', '(reveal)', 'Published / Draft / other']) assert.ok(cards.includes(value), value);
  assert.match(html, /badge success/); assert.match(html, /3 min ago/); assert.match(html, /<time datetime="[^"]+" title="[^"]+"/); assert.match(html, /\d+\.\d (KB|MB)/);
  assert.match(html, /text-align:right/); assert.match(html, /toLocaleString/); assert.ok(!html.includes('<link rel="stylesheet"'));
  runtime.store.state.journals.failed = {errors: true, items: []}; runtime.store.addJob({id: 'failure', details: [{id: 'failed'}]});
  assert.match((await gw.request('/', {auth: null})).data, /badge failure/);
  const detail = (await gw.request('/tenants/' + A.id, {auth: null})).data;
  assert.match(detail, /1,234 live documents/); assert.match(detail, /1,234 matching documents/); assert.ok(!html.includes('\uFFFD'));
  assert.match(detail, /class="section-nav" aria-label="Tenant sections"/); assert.match(detail, /position:sticky;top:0/); assert.match(detail, /badge neutral/);
});

test('GraphQL GET has POST CORS/auth protections, including query parameters with HTML Accept', async t => {
  const gw = await tenants(t, {corsOrigins: 'https://app.example'});
  const runtime = gw.server.tenants.get(A.id);
  const query = '/content/v2?query=' + encodeURIComponent('{_Content{total}}');
  const Origin = 'https://app.example';
  for (const Accept of ['application/json', 'text/html']) {
    for (const auth of ['epi-single ' + A.singleKey, preview(A), null]) {
      const path = query + (auth === null ? '&auth=' + A.singleKey : '');
      const result = await gw.request(path, {auth, headers: {Origin, Accept}});
      assert.equal(result.status, 200); assert.equal(result.data.errors, undefined);
      assert.equal(result.data.data._Content.total, 0);
      assert.match(result.headers.get('content-type'), /application\/json/);
      assert.equal(result.headers.get('access-control-allow-origin'), Origin);
      assert.equal(result.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
      assert.equal(result.headers.get('vary'), 'Origin');
    }
  }
  const noQuery = await gw.request('/content/v2', {auth: 'epi-single ' + A.singleKey, headers: {Origin, Accept: 'application/json'}});
  assert.equal(noQuery.status, 200); assert.ok(noQuery.data.errors);
  assert.equal(noQuery.headers.get('access-control-allow-origin'), Origin);
  for (const auth of [basic(A), 'bAsIc invalid']) {
    const result = await gw.request(query, {auth, headers: {Origin}});
    assert.equal(result.status, 403); assert.match(result.data.message, /Basic/);
  }
  const before = structuredClone(runtime.store.state);
  const mutation = '/content/v2?query=' + encodeURIComponent('mutation{deployNewAccountVersion}');
  for (const auth of ['epi-single ' + A.singleKey, preview(A)]) {
    const result = await gw.request(mutation, {auth, headers: {Origin, Accept: 'text/html'}});
    assert.equal(result.status, 403); assert.match(result.data.message, /mutations/);
    assert.equal(result.headers.get('access-control-allow-origin'), Origin);
  }
  assert.deepEqual(runtime.store.state, before);
  const denied = await gw.request(query, {auth: preview(A), headers: {Origin: 'https://evil.example'}});
  assert.equal(denied.status, 403); noCors(denied);
  const html = await gw.request('/content/v2', {auth: null, headers: {Origin, Accept: 'text/html'}});
  assert.equal(html.status, 403); noCors(html);
});

test('URL headers redact auth in ring, disk, dashboard and historical logs without changing request headers', async t => {
  const lines = []; const gw = await tenants(t, {logger: {log: line => lines.push(line), error: line => lines.push(line)}});
  const headers = {
    Referer: 'https://app.example/page?auth=referer-secret&cache=1&%61uth=encoded-secret#part',
    'X-Source-Url': '/page?AUTH=custom-secret&auth=repeat-secret&keep=yes',
    'X-Plain': 'ordinary value',
  };
  for (const auth of ['epi-single ' + A.singleKey, 'epi-single unknown']) {
    await gw.request('/content/v2?query=' + encodeURIComponent('{_Content{total}}'), {auth, headers});
  }
  const expected = {referer: 'https://app.example/page?auth=***&cache=1&%61uth=***#part', 'x-source-url': '/page?AUTH=***&auth=***&keep=yes'};
  const secrets = ['referer-secret', 'encoded-secret', 'custom-secret', 'repeat-secret'];
  const entry = gw.server.tenants.get(A.id).log.recent.at(-1);
  for (const [key, value] of Object.entries(expected)) assert.equal(entry.headers[key], value);
  assert.equal(entry.headers['x-plain'], 'ordinary value'); assert.equal(entry.headers.authorization, 'epi-single');
  assert.ok(headers.Referer.includes('referer-secret'));
  const detail = (await gw.request('/tenants/' + A.id + '/request/' + entry.n, {auth: null})).data;
  for (const id of [A.id, '_unrouted']) {
    const disk = readFileSync(join(gw.root, 'logs', id, 'requests.ndjson'), 'utf8');
    const saved = JSON.parse(disk.trim().split('\n')[0]);
    for (const [key, value] of Object.entries(expected)) assert.equal(saved.headers[key], value);
    for (const secret of secrets) assert.ok(!disk.includes(secret));
  }
  assert.match(detail, /auth=\*\*\*/);
  for (const secret of secrets) { assert.ok(!detail.includes(secret)); assert.ok(!lines.join('\n').includes(secret)); }
  const root = scratch(t);
  writeFileSync(join(root, 'requests.ndjson'), JSON.stringify({n: 1, url: '/old', headers: {referer: headers.Referer, 'x-source-url': [headers['X-Source-Url'], 'https://other.example/?auth=array-secret'], 'x-plain': 'ordinary value'}}) + '\n');
  const restored = new RequestLog(root, quiet); restored.load();
  assert.equal(restored.recent[0].headers.referer, expected.referer);
  assert.deepEqual(restored.recent[0].headers['x-source-url'], [expected['x-source-url'], 'https://other.example/?auth=***']);
  const input = {url: '/direct', headers: {referer: headers.Referer, 'x-source-url': [headers['X-Source-Url']]}};
  restored.append(input);
  assert.equal(input.headers.referer, expected.referer);
  assert.deepEqual(input.headers['x-source-url'], [expected['x-source-url']]);
});
