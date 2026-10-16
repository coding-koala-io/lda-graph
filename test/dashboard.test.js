import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from '../src/server.js';
import {MODEL, document, index, KEY} from './fixtures.js';
import {gateway, quiet, success} from './helpers.js';
import {A, B, basic, preview, tenants, csrf, postForm, scratch, eventually} from './tenant-helpers.js';

async function seed(gw, tenant = A) {
  await gw.request('/api/content/v3/types', {method: 'PUT', auth: basic(tenant), body: MODEL});
  const result = await gw.request('/_stream', {method: 'POST', auth: basic(tenant), body: index('one', document()) + index('draft', document({metadata: {status: 'Draft'}}))});
  await gw.request('/journal/indexing', {method: 'POST', auth: basic(tenant), body: {id: 'sync-job', details: [{id: result.data.journalId}]}, headers: {'og-job-id': 'CMS Job'}});
  return result.data.journalId;
}

test('tenant debug JSON, single-tenant aliases and GraphiQL picker/key/query selection work', async t => {
  const gw = await tenants(t); const journal = await seed(gw); const base = '/tenants/' + A.id;
  for (const path of ['/__debug/docs', '/__debug/types', '/__debug/schema', '/__debug/requests']) {
    const result = await gw.request(path, {auth: null}); assert.equal(result.status, 400); assert.match(result.data.message, /\/tenants\/site-a\/.*\/tenants\/site-b\//);
  }
  for (const path of ['/docs', '/docs/one', '/types', '/schema', '/requests', '/jobs', '/journals/' + journal]) assert.equal((await gw.request(base + path, {auth: null})).status, 200, path);
  const entry = gw.server.tenants.get(A.id).log.recent.at(-1);
  assert.deepEqual((await gw.request(base + '/requests/' + entry.n, {auth: null})).data, entry);
  assert.equal((await gw.request('/tenants/missing/docs', {auth: null})).status, 404);
  assert.equal((await gw.request(base + '/journals/missing', {auth: null})).status, 404);
  const picker = (await gw.request('/graphiql', {auth: null})).data; assert.match(picker, /Choose a tenant/); assert.match(picker, /Site A/); assert.match(picker, /Site B/);
  const query = '{_Content{total}}'; const html = (await gw.request('/graphiql?' + new URLSearchParams({tenant: A.id, query}), {auth: null})).data;
  assert.ok(html.includes('epi-single public-a')); assert.ok(!html.includes('public-b')); assert.ok(html.includes(query));
  assert.equal((await gw.request('/graphiql?tenant=missing', {auth: null})).status, 404);
  await gw.server.tenants.edit(entries => entries.filter(entry => entry.id === A.id));
  assert.equal((await gw.request('/__debug/docs', {auth: null})).data.length, 2);
  assert.ok((await gw.request('/graphiql', {auth: null})).data.includes('epi-single public-a'));
});

test('dashboard renders all sections, jobs, document versions, request details, filters, paging and escaped CMS data', async t => {
  const gw = await tenants(t); const journal = await seed(gw); const rt = gw.server.tenants.get(A.id);
  const attack = '<script>alert(1)</script>';
  rt.store.upsert('xss', document({metadata: {displayName: attack, key: KEY}, Heading: attack}));
  rt.store.upsert('sv-version', document({metadata: {key: KEY, locale: 'sv', status: 'Draft', version: '12'}}));
  for (let n = 0; n < 55; n++) rt.store.upsert('page-' + n, document({metadata: {displayName: 'Page ' + n}}));
  rt.store.mutate('deployNewAccountVersion'); rt.store.upsert('pending', document(), {slot: 'new'}); rt.store.delete('gone', {snapshotTime: '2026-01-01'});
  await gw.gql('query Test{_Content{total}}', {}, {auth: basic(A), headers: {'X-Query-Name': attack}});
  const requestEntry = rt.log.recent.at(-1); await rt.store.flush();
  const root = (await gw.request('/', {auth: null})).data;
  for (const label of ['Site A', 'Site B', 'AppKey', 'SingleKey', 'Published / Draft / other', 'Last full sync', 'Store size', 'New tenant']) assert.ok(root.includes(label));
  const base = '/tenants/' + A.id; const detail = (await gw.request(base, {auth: null})).data;
  for (const heading of ['Connect', 'Overview', 'Sync jobs', 'Documents', 'Requests', 'Schema', 'Danger zone']) assert.ok(detail.includes(`<h2>${heading}</h2>`));
  assert.ok(detail.includes(gw.base)); assert.ok(detail.includes(A.secret)); assert.ok(detail.includes('CMS Job')); assert.ok(detail.includes('new slot: 1 documents')); assert.ok(detail.includes('1 tombstones'));
  assert.ok(detail.includes('Next 50')); assert.ok(detail.includes('setInterval(refreshCounts,5000)')); assert.ok(detail.includes('schema-search'));
  assert.ok((await gw.request(base + '?page=2', {auth: null})).data.includes('Previous 50'));
  const filtered = (await gw.request(base + '?locale=sv&q=sv-version', {auth: null})).data; assert.match(filtered, /1 matching documents/);
  const pages = [detail, (await gw.request(base + '/documents/xss', {auth: null})).data, (await gw.request(base + '/request/' + requestEntry.n, {auth: null})).data];
  for (const html of pages) { assert.ok(!html.includes(attack)); assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); }
  assert.ok(pages[1].includes('Raw document (as received)')); assert.ok(pages[1].includes('Normalized document')); assert.ok(pages[1].includes('sv-version')); assert.ok(pages[1].includes('Query in GraphiQL'));
  assert.ok(pages[2].includes('&quot;authorization&quot;: &quot;Basic&quot;')); assert.ok(!pages[2].includes(basic(A)));
  assert.ok((await gw.request(base + '/sync/sync-job', {auth: null})).data.includes(journal));
  assert.ok((await gw.request(base + '/journals/' + journal + '?view=html', {auth: null})).data.includes('created'));
  await gw.request('/clientlog', {method: 'POST', auth: basic(A), body: 'x'.repeat(70000)});
  const long = rt.log.recent.at(-1); assert.ok((await gw.request(base + '/request/' + long.n, {auth: null})).data.includes('truncated at 64 KB'));
  const streamEntry = rt.log.recent.find(entry => entry.url === '/_stream');
  const streamDetail = (await gw.request(base + '/request/' + streamEntry.n, {auth: null})).data;
  assert.ok(streamDetail.includes('&quot;index&quot;')); assert.ok(streamDetail.includes('NDJSON · line 1'));
  assert.ok(streamDetail.includes('  &quot;index&quot;: {'));
  const s = (await gw.request(base + '/stats', {auth: null})).data;
  assert.equal(s.docs, 59); assert.equal(s.slots.new, 1); assert.equal(s.lastSync.status, 'Success'); assert.equal(s.lastSync.indexed, 2); assert.ok(s.storeBytes > 0); assert.equal(s.typesMethod, 'PUT');
});

test('clear forms enforce CSRF, typed confirmation and origin; JSON clears report exact counts and preserve other tenants', async t => {
  const gw = await tenants(t); await seed(gw); await seed(gw, B); const rt = gw.server.tenants.get(A.id); const other = structuredClone(gw.server.tenants.get(B.id).store.state);
  const base = '/tenants/' + A.id; const token = csrf((await gw.request(base, {auth: null})).data); assert.ok(token);
  for (const body of [{action: 'content', confirm: A.id}, {action: 'content', csrf: 'wrong', confirm: A.id}]) assert.equal((await postForm(gw, base + '/clear', body)).status, 403);
  assert.equal((await postForm(gw, base + '/reset', {})).status, 403, 'Tenant reset cannot bypass form protection');
  assert.equal((await postForm(gw, base + '/clear', {action: 'content', csrf: token, confirm: B.id})).status, 400);
  assert.equal((await postForm(gw, base + '/clear', {action: 'content', csrf: token, confirm: A.id}, {headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['content']}, headers: {Origin: 'https://evil.example'}})).status, 403);
  for (const action of ['content', 'types', 'jobs', 'requests', 'all', 'delete']) {
    const confirm = await postForm(gw, base + '/confirm', {action, csrf: token}); assert.equal(confirm.status, 200); assert.ok(confirm.data.includes('name="confirm"'));
  }
  rt.store.upsert('new', document(), {slot: 'new'}); rt.store.delete('gone', {snapshotTime: '2026-01-01'}); rt.store.delete('new-gone', {slot: 'new', snapshotTime: '2026-01-01'});
  const clear = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['content']}});
  assert.deepEqual(clear.data, {removed: {docs: 3, tombstones: 2}}); assert.equal(Object.keys(rt.store.state.types).length, 1); assert.equal(Object.keys(rt.store.state.jobs).length, 1);
  assert.equal(Object.keys(rt.store.slot('new').docs).length, 0);
  const typeClear = await postForm(gw, base + '/clear', {csrf: token, action: 'types', confirm: A.id});
  assert.equal(typeClear.status, 303); assert.match(decodeURIComponent(typeClear.headers.get('location')), /11 content types, 15 property types/);
  assert.ok((await gw.gql('{ArticlePage{total}}', {}, {auth: basic(A)})).errors); assert.ok(!(await gw.gql('{_Content{total}}', {}, {auth: basic(A)})).errors);
  const jobsClear = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['jobs']}}); assert.deepEqual(jobsClear.data.removed, {jobs: 1, journals: 1});
  const before = rt.log.recent.length;
  const requestClear = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['requests']}});
  assert.deepEqual(requestClear.data.removed, {requests: before, requestFiles: 1}); assert.equal(rt.log.recent.length, 0); assert.ok(!existsSync(join(gw.root, 'logs', A.id, 'requests.ndjson')));
  rt.store.state.webhooks.push({id: 'hook'}); rt.store.upsert('x', document());
  const all = await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['all']}});
  assert.equal(all.data.removed.docs, 1); assert.equal(all.data.removed.webhooks, 1); assert.equal(all.data.removed.newSlots, 1);
  assert.deepEqual(rt.store.state.slots, {}); assert.deepEqual(rt.store.state.jobs, {}); assert.equal(rt.log.recent.length, 0);
  assert.deepEqual(gw.server.tenants.get(B.id).store.state, other);
  assert.equal((await gw.request(base + '/clear', {method: 'POST', auth: null, body: {what: ['wrong']}})).status, 400);
});

test('dashboard creates, edits and deletes tenants atomically with validation, CSRF and optional folder deletion', async t => {
  const gw = await tenants(t); const token = csrf((await gw.request('/', {auth: null})).data);
  let c = {name: '<script>alert(1)</script>'};
  assert.equal((await postForm(gw, '/tenants', c)).status, 403);
  const invalid = await postForm(gw, '/tenants', {name: ' ', csrf: token}); assert.equal(invalid.status, 400); assert.match(invalid.data, /1-100/); assert.ok(!invalid.data.includes(c.name));
  const created = await postForm(gw, '/tenants', {...c, csrf: token}); assert.equal(created.status, 303); c = gw.server.tenants.find(new URL(created.headers.get('location'), gw.base).pathname.split('/').at(-1)); assert.ok(c.appKey);
  assert.equal(JSON.parse(readFileSync(gw.file, 'utf8')).tenants.length, 3); assert.equal(readdirSync(gw.root).some(name => name.endsWith('.tmp')), false);
  const base = '/tenants/' + c.id;
  assert.ok((await gw.request(base + '/edit', {auth: null})).data.includes('Generate secret'));
  const edited = {...c, name: 'Edited C', secret: B.secret, singleKey: 'rotated-c'};
  assert.equal((await postForm(gw, base + '/edit', {...edited, csrf: token})).status, 303);
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: basic(c), body: {query: '{_Content{total}}'}})).status, 401);
  await gw.request('/_doc/keep', {method: 'POST', auth: basic(edited), body: document()}); await gw.server.tenants.get(c.id).store.flush();
  const deleted = await postForm(gw, base + '/delete', {csrf: token, action: 'delete', confirm: c.id}); assert.equal(deleted.status, 303);
  assert.ok(existsSync(join(gw.root, 'data', c.id, 'store.ndjson'))); assert.ok(existsSync(join(gw.root, 'logs', c.id, 'requests.ndjson'))); assert.equal(gw.server.tenants.find(c.id), undefined);
  const recreated = await postForm(gw, '/tenants', {name: c.name, csrf: token}); assert.equal(recreated.status, 303);
  const newId = new URL(recreated.headers.get('location'), gw.base).pathname.split('/').at(-1);
  assert.equal(newId, c.id + '-2');
  const removeFolders = await postForm(gw, '/tenants/' + newId + '/delete', {csrf: token, action: 'delete', confirm: newId, deleteFolders: 'yes'}); assert.equal(removeFolders.status, 303);
  assert.ok(!existsSync(join(gw.root, 'data', newId))); assert.ok(!existsSync(join(gw.root, 'logs', newId)));
  assert.ok(existsSync(join(gw.root, 'data', c.id))); assert.ok(existsSync(join(gw.root, 'logs', c.id)));
  await gw.server.tenants.close(); assert.ok(!existsSync(join(gw.root, 'data', newId)), 'Shutdown must not recreate deleted folders');
});

test('failed tenant-config deletion leaves content and logs intact; malformed job details do not break dashboards', async t => {
  const gw = await tenants(t); await seed(gw); const base = '/tenants/' + A.id; const token = csrf((await gw.request(base, {auth: null})).data);
  const rt = gw.server.tenants.get(A.id); const original = structuredClone(rt.store.state);
  const edit = gw.server.tenants.edit; gw.server.tenants.edit = async () => { throw new Error('config disk unavailable'); };
  const result = await postForm(gw, base + '/delete', {csrf: token, action: 'delete', confirm: A.id, deleteFolders: 'yes'});
  assert.equal(result.status, 400); assert.deepEqual(rt.store.state, original); assert.ok(gw.server.tenants.find(A.id)); assert.equal(rt.busy, false);
  gw.server.tenants.edit = edit;
  for (const details of [[null], [{}], [{id: 7}]]) assert.equal((await gw.request('/journal/indexing', {method: 'POST', auth: basic(A), body: {id: 'malformed', details}})).status, 400);
  rt.store.state.jobs.legacyMalformed = {id: 'legacyMalformed', details: [null, {}]};
  for (const path of ['/', base, base + '/stats', base + '/jobs']) assert.equal((await gw.request(path, {auth: null})).status, 200, path);
});

test('legacy env dashboard can create a first file-mode tenant and import a root JSON store', async t => {
  const root = scratch(t); const file = join(root, 'tenants.json');
  const legacy = await gateway(t, {tenantsFile: file, appKey: 'env-app', secret: A.secret, singleKey: 'env-public'}); const token = csrf((await legacy.request('/', {auth: null})).data);
  assert.equal((await postForm(legacy, '/tenants', {name: A.name, csrf: token})).status, 303);
  assert.equal(legacy.server.tenants.legacy, false); assert.ok(legacy.server.tenants.find('default').secret); assert.ok(legacy.server.tenants.find(A.id));
  const warnings = []; const dataDir = join(root, 'data'); mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({types: {default: MODEL}, docs: {imported: {raw: document()}}}));
  writeFileSync(file, JSON.stringify({tenants: [A, B]}));
  const gw = await gateway(t, {tenantsFile: file, dataDir, logger: {log() {}, error: value => warnings.push(value)}});
  assert.ok(warnings.some(value => /Import legacy store/.test(value))); assert.ok(existsSync(join(dataDir, 'store.json')));
  const base = '/tenants/' + A.id; const detail = (await gw.request(base, {auth: null})).data;
  assert.ok(detail.includes('Import legacy store'));
  assert.equal((await postForm(gw, base + '/import', {csrf: csrf(detail)})).status, 303);
  assert.equal(success(await gw.gql('{ArticlePage{total}}', {}, {auth: basic(A)}), 'ArticlePage').total, 1);
  assert.ok(!existsSync(join(dataDir, 'store.json')));
  assert.equal((await postForm(gw, base + '/import', {csrf: csrf(detail)})).status, 400);
});

test('non-loopback requires separate ADMIN credentials and challenges every dashboard/debug page', async t => {
  for (const options of [{}, {adminUser: 'manager'}, {adminPassword: 'password'}]) assert.throws(() => createServer({host: '0.0.0.0', dataDir: ':memory:', logDir: ':memory:', logger: quiet, ...options}), /ADMIN_USER and ADMIN_PASSWORD/);
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  const admin = 'Basic ' + Buffer.from('manager:password').toString('base64');
  for (const path of ['/', '/tenants/' + A.id, '/tenants/' + A.id + '/docs', '/graphiql?tenant=' + A.id, '/__debug/docs']) {
    for (const auth of [null, basic(A), `epi-single ${A.singleKey}`, preview(A)]) {
      const result = await gw.request(path, {auth}); assert.equal(result.status, 401); assert.equal(result.headers.get('www-authenticate'), 'Basic realm="LDA Local Graph"');
    }
    assert.notEqual((await gw.request(path, {auth: admin})).status, 401);
  }
  assert.equal((await gw.request('/content/v2', {method: 'POST', auth: admin, body: {query: '{_Content{total}}'}})).status, 401, 'Admin keys never route to CMS account');
  assert.equal((await gw.request('/tenants/' + A.id + '/clear', {method: 'POST', auth: admin, body: {what: ['all']}, headers: {Origin: 'https://evil.example'}})).status, 403);
});

test('README explains tenant files, routing, storage, management and two CMS sites', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const pattern of [/TENANTS_FILE/, /tenants\.json/, /ADMIN_USER/, /ADMIN_PASSWORD/, /_unrouted/, /DATA_DIR\/<tenantId>/, /hot reload/i, /Import legacy store/, /two CMS sites/i, /CSRF/, /\/tenants\/\{id\}\/clear/]) assert.match(readme, pattern);
});
