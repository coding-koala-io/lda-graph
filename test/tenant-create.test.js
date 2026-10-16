import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {validateTenants} from '../src/tenants.js';
import {generateTenant} from '../src/tenant-create.js';
import {quiet} from './helpers.js';
import {A, basic, csrf, postForm, tenants} from './tenant-helpers.js';
import {document} from './fixtures.js';

test('generated IDs skip registered IDs and leftover folder IDs in suffix order', () => {
  const rnd = n => Buffer.alloc(n, 1);
  assert.equal(generateTenant('Acme', [], rnd, id => id === 'acme').id, 'acme-2');
  assert.equal(generateTenant('Acme', [], rnd, id => ['acme', 'acme-2'].includes(id)).id, 'acme-3');
  assert.equal(generateTenant('Acme', [{id: 'acme'}], rnd, id => id === 'acme-2').id, 'acme-3');
});

test('dashboard recreation after keep-folders deletion starts empty and preserves the old store', async t => {
  const gw = await tenants(t); const registry = gw.server.tenants;
  const token = csrf((await gw.request('/', {auth: null})).data);
  assert.equal((await postForm(gw, '/tenants', {name: 'Acme', csrf: token})).status, 303);
  const acme = registry.find('acme'); assert.ok(acme);
  assert.equal((await gw.request('/_doc/keep', {method: 'POST', auth: basic(acme), body: document()})).status, 200);
  const removed = await postForm(gw, '/tenants/acme/delete', {csrf: token, action: 'delete', confirm: 'acme'});
  assert.equal(removed.status, 303); assert.equal(registry.find('acme'), undefined);
  const oldData = join(gw.root, 'data', 'acme'); const oldLogs = join(gw.root, 'logs', 'acme');
  assert.ok(existsSync(oldData)); assert.ok(existsSync(oldLogs));
  const dataFiles = readdirSync(oldData); const logFiles = readdirSync(oldLogs);
  const snapshot = (folder, files) => files.map(file => readFileSync(join(folder, file)));
  const dataBefore = snapshot(oldData, dataFiles); const logsBefore = snapshot(oldLogs, logFiles);
  const created = await postForm(gw, '/tenants', {name: 'ACME', csrf: token});
  assert.equal(created.status, 303);
  assert.equal(new URL(created.headers.get('location'), gw.base).pathname, '/tenants/acme-2');
  assert.equal((await gw.request('/tenants/acme-2/stats', {auth: null})).data.docs, 0);
  assert.deepEqual(registry.get('acme-2').store.state.docs, {});
  assert.deepEqual(readdirSync(oldData), dataFiles); assert.deepEqual(snapshot(oldData, dataFiles), dataBefore);
  assert.deepEqual(readdirSync(oldLogs), logFiles); assert.deepEqual(snapshot(oldLogs, logFiles), logsBefore);
});

test('dashboard skips either root independently and ignores memory roots', async t => {
  for (const retainedRoot of ['data', 'logs']) {
    const gw = await tenants(t);
    mkdirSync(join(gw.root, retainedRoot, 'acme'), {recursive: true});
    const token = csrf((await gw.request('/', {auth: null})).data);
    const result = await postForm(gw, '/tenants', {name: 'Acme', csrf: token});
    assert.equal(result.status, 303);
    assert.equal(new URL(result.headers.get('location'), gw.base).pathname, '/tenants/acme-2');
  }
  const memory = await tenants(t, {dataDir: ':memory:', logDir: ':memory:'});
  const token = csrf((await memory.request('/', {auth: null})).data);
  assert.equal((await postForm(memory, '/tenants', {name: 'Acme', csrf: token})).status, 303);
  assert.ok(memory.server.tenants.find('acme'));
});

test('slug rules, length, fallback, suffixes and trimmed name validation', () => {
  for (const [name, id] of [['  My CMS / Site!!  ', 'my-cms-site'], ['___Hello___', 'hello'], ['你好 💡', 'instance'], ['A'.repeat(100), 'a'.repeat(40)], ['a'.repeat(39) + ' !next', 'a'.repeat(39)], ['---' + 'b'.repeat(50), 'b'.repeat(40)]]) {
    const entry = generateTenant(name, []);
    assert.equal(entry.id, id); assert.equal(entry.name, name.trim());
    assert.equal(validateTenants({tenants: [entry]}, quiet)[0].id, id);
  }
  const entries = [{id: 'instance'}, {id: 'instance-2'}, {id: 'instance-4'}];
  assert.equal(generateTenant('!!!', entries).id, 'instance-3');
  const long = 'a'.repeat(40);
  assert.equal(generateTenant(long, [{id: long}, {id: long + '-2'}]).id, long + '-3');
  for (const name of [undefined, null, 42, '', ' \t ', 'a'.repeat(101)]) assert.throws(() => generateTenant(name, []), /1-100/);
  assert.equal(generateTenant('  ' + 'a'.repeat(100) + '  ', []).name.length, 100);
});

test('generated keys retry collisions across both key namespaces and secret is 32-byte standard Base64', () => {
  const draws = [Buffer.alloc(4), Buffer.alloc(4, 1), Buffer.alloc(4), Buffer.alloc(4, 2), Buffer.alloc(32, 255)];
  const entry = generateTenant('Site', [{id: 'other', singleKey: 'app-site-00000000', appKey: 'pub-site-00000000'}], n => {
    const value = draws.shift(); assert.equal(value.length, n); return value;
  });
  assert.equal(entry.appKey, 'app-site-01010101'); assert.equal(entry.singleKey, 'pub-site-02020202');
  assert.equal(draws.length, 0); assert.equal(entry.secret, Buffer.alloc(32, 255).toString('base64'));
  const entries = [];
  for (let i = 0; i < 50; i++) {
    const value = generateTenant('Site', entries); entries.push(value);
    assert.match(value.appKey, new RegExp(`^app-${value.id}-[a-f0-9]{8}$`));
    assert.match(value.singleKey, new RegExp(`^pub-${value.id}-[a-f0-9]{8}$`));
    assert.match(value.secret, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(value.secret, 'base64').length, 32);
    assert.equal(Buffer.from(value.secret, 'base64').toString('base64'), value.secret);
  }
  assert.equal(new Set(entries.flatMap(e => [e.appKey, e.singleKey])).size, 100);
  assert.equal(new Set(entries.map(e => e.secret)).size, 50);
  validateTenants({tenants: entries}, quiet);
});

test('name-only form, concurrent create, redirect flash and highlighted CMS snippet; edit retains controls', async t => {
  const gw = await tenants(t); const root = (await gw.request('/', {auth: null})).data; const token = csrf(root);
  const form = /<form method="post" action="\/tenants">([\s\S]*?)<\/form>/.exec(root)[1];
  assert.deepEqual([...form.matchAll(/<input[^>]*name="([^"]+)"/g)].map(m => m[1]), ['csrf', 'name']);
  assert.match(form, /name="name"[^>]*required[^>]*maxlength="100"/); assert.ok(!form.includes('Generate secret'));
  const results = await Promise.all([1, 2, 3].map(() => postForm(gw, '/tenants', {name: '  Site & Demo  ', csrf: token, id: 'override', appKey: A.appKey, singleKey: A.singleKey, secret: 'override'})));
  assert.deepEqual(results.map(r => r.status), [303, 303, 303]);
  for (const [index, result] of results.entries()) {
    const id = index ? `site-demo-${index + 1}` : 'site-demo';
    const location = result.headers.get('location'); const url = new URL(location, gw.base);
    assert.equal(url.pathname, '/tenants/' + id); assert.equal(url.hash, '#connect');
    assert.equal(url.searchParams.get('flash'), 'Instance created — copy these settings into the CMS appsettings.Development.json');
    const entry = gw.server.tenants.find(id); assert.equal(entry.name, 'Site & Demo'); assert.notEqual(entry.appKey, A.appKey);
    const html = (await gw.request(location, {auth: null})).data;
    assert.match(html, /Instance created/); assert.match(html, /<section id="connect" class="connect-created">/);
    assert.ok(html.indexOf('<section id="connect"') < html.indexOf('<section id="overview"'));
    const encoded = /<pre id="settings">([\s\S]*?)<\/pre>/.exec(html)[1];
    const snippet = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.deepEqual(snippet.Optimizely.ContentGraph, {GatewayAddress: gw.base, AppKey: entry.appKey, Secret: entry.secret, SingleKey: entry.singleKey});
    const edit = (await gw.request('/tenants/' + id + '/edit', {auth: null})).data;
    for (const key of ['name', 'id', 'appKey', 'singleKey', 'secret']) assert.ok(edit.includes(`name="${key}"`));
    assert.ok(edit.includes('Generate secret'));
  }
});

test('create retains CSRF, origin, admin authentication, name validation and disk-edit protection', async t => {
  const admin = 'Basic ' + Buffer.from('manager:password').toString('base64');
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  const token = csrf((await gw.request('/', {auth: admin})).data);
  const original = readFileSync(gw.file, 'utf8');
  for (const auth of [null, basic(A)]) assert.equal((await postForm(gw, '/tenants', {name: 'Site', csrf: token}, {auth})).status, 401);
  for (const value of [undefined, 'wrong']) assert.equal((await postForm(gw, '/tenants', {name: 'Site', ...(value ? {csrf: value} : {})}, {auth: admin})).status, 403);
  assert.equal((await postForm(gw, '/tenants', {name: 'Site', csrf: token}, {auth: admin, headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example'}})).status, 403);
  for (const name of ['', '   ', 'x'.repeat(101)]) assert.equal((await postForm(gw, '/tenants', {name, csrf: token}, {auth: admin})).status, 400);
  assert.equal((await postForm(gw, '/tenants', {csrf: token}, {auth: admin})).status, 400);
  assert.equal(readFileSync(gw.file, 'utf8'), original);
  gw.server.tenants.watcher?.close(); clearTimeout(gw.server.tenants.reloadTimer);
  const edited = original + '\n'; writeFileSync(gw.file, edited);
  const result = await postForm(gw, '/tenants', {name: 'Site', csrf: token}, {auth: admin});
  assert.equal(result.status, 400); assert.match(result.data, /changed on disk/); assert.equal(readFileSync(gw.file, 'utf8'), edited);
});
