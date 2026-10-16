import {product} from '../src/product.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, promises as fs} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {normalizeDocument} from '../src/normalize.js';
import {compactJournal} from '../src/journal.js';
import {memoryHtml} from '../src/dashboard.js';
import {processMemory} from '../src/process-memory.js';
import {MODEL, document, stream, index} from './fixtures.js';
import {quiet, success} from './helpers.js';
import {scratch, tenants, A, B, basic} from './tenant-helpers.js';

test('raw documents stay compact and isolated; lazy reads do not retain an object graph', () => {
  const input = document({'Payload$$JSON___skip': JSON.parse('{"__proto__":{"safe":true},"text":"東京 🙂 café"}')});
  const record = normalizeDocument(input, 'raw');
  assert.equal(typeof record.rawJson, 'string');
  assert.equal(Object.getOwnPropertyDescriptor(record, 'raw').value, undefined);
  assert.equal(typeof Object.getOwnPropertyDescriptor(record, 'raw').get, 'function');
  assert.deepEqual(record.raw, input);
  assert.notEqual(record.raw, record.raw, 'Inspection must not cache parsed objects');
  input.MainBody['html$$String'] = 'caller edit';
  const inspected = record.raw; inspected.MainBody['html$$String'] = 'dashboard edit';
  record.normalized.MainBody.html = 'normalized edit';
  assert.equal(record.raw.MainBody['html$$String'], '<p>Résumé quick content</p>');
  assert.equal({}.safe, undefined);
});

test('raw NDJSON stays version-1 compatible with soft deletes, routing overrides and previous/pending slots', async t => {
  const dataDir = scratch(t); const store = new Store({dataDir, logger: quiet});
  const raw = document({metadata: {locale: ''}, 'Heading$$String___searchable': '東京 🙂 café'});
  store.setTypes(MODEL);
  store.upsert('__proto__', raw, {locale: 'sv', snapshotTime: '2026-02-01'});
  store.mutate('deployNewAccountVersion'); store.setTypes(MODEL, {slot: 'new'});
  store.upsert('promoted', raw, {slot: 'new'}); store.mutate('useNewAccountVersion');
  store.upsert('soft', raw); store.delete('soft', {hard: false, snapshotTime: '2026-12-02'});
  store.mutate('deployNewAccountVersion'); store.upsert('pending', raw, {slot: 'new'});
  await store.flush();
  const entries = readFileSync(join(dataDir, 'store.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries[0], {record: 'header', version: 1});
  for (const entry of entries.filter(entry => entry.record === 'docs')) {
    assert.equal(typeof entry.value.raw, 'object');
    assert.equal('rawJson' in entry.value, false);
    assert.equal('normalized' in entry.value, false);
  }
  const reopened = new Store({dataDir, logger: quiet});
  assert.equal(reopened.state.docs.soft.raw._deleted, true);
  assert.equal(reopened.state.docs.soft.normalized._modified, '2026-12-02');
  assert.equal(reopened.state.slots.old.docs.__proto__.normalized._metadata.locale, 'sv');
  assert.equal(reopened.state.slots.old.docs.__proto__.raw._metadata.locale, '');
  assert.equal(reopened.slot('new').docs.pending.raw['Heading$$String___searchable'], '東京 🙂 café');
  reopened.mutate('useOldAccountVersion');
  assert.deepEqual(reopened.state.docs.__proto__.raw, raw);
  await reopened.flush();
});

test('compact journals reconstruct byte-identical success/error replies and preserve unusual legacy records', async t => {
  const items = ['created', 'updated', 'deleted', 'noop', 'not_found'].map((Result, n) => ({index: {Status: n === 0 ? 201 : 200, _index: 'default', _id: `東京-${n}`, Result}}));
  items.push({index: {Status: 400, _index: 'default', _id: '__proto__', Result: 'not_found', Error: {Type: 'parse_error', Reason: 'Missing source line'}}});
  const original = {ts: '2026-01-01', took: 3, errors: true, status: 'done', items};
  const compact = compactJournal(original);
  assert.equal(typeof compact.itemsJson, 'string');
  assert.equal(compact.itemCount, 6);
  assert.equal(JSON.stringify(compact), JSON.stringify(original));
  assert.notEqual(compact.items, compact.items);
  const unusual = {...original, items: [{index: {...items[0].index, _index: 'custom', extra: 1}}]};
  assert.equal(compactJournal(unusual), unusual);
  const dataDir = scratch(t);
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({docs: {legacy: {raw: document()}}, journals: {legacy: original}}));
  const store = new Store({dataDir, logger: quiet});
  assert.equal(JSON.stringify(store.state.journals.legacy), JSON.stringify(original));
  assert.equal(typeof store.state.journals.legacy.itemsJson, 'string');
  assert.equal(typeof store.state.docs.legacy.rawJson, 'string');
  await store.flush();
  assert.equal(JSON.stringify(new Store({dataDir, logger: quiet}).state.journals.legacy), JSON.stringify(original));
});

test('stream journals preserve every outcome through HTTP, dashboard detail and restart', async t => {
  const gw = await tenants(t); const runtime = gw.server.tenants.get(A.id);
  const body = index('doc') + index('doc') + stream({delete: {_id: 'doc'}}, {delete: {_id: 'absent'}}, {index: {_id: 'bad'}});
  const {data: {journalId}} = await gw.request('/_stream', {method: 'POST', body, auth: basic(A)});
  const wire = (await gw.request('/journal/stream/' + journalId, {auth: basic(A)})).data;
  assert.deepEqual(wire.items.map(({index}) => index.Result), ['created', 'updated', 'deleted', 'not_found', 'not_found']);
  assert.deepEqual(wire.items.map(({index}) => index.Status), [201, 200, 200, 200, 400]);
  assert.deepEqual(wire.items.at(-1).index.Error, {Type: 'parse_error', Reason: 'Missing source line'});
  assert.deepEqual(Object.keys(wire), ['took', 'errors', 'status', 'items']);
  const detail = (await gw.request(`/tenants/${A.id}/journals/${journalId}`)).data;
  assert.deepEqual(detail.items, wire.items);
  assert.ok((await gw.request(`/tenants/${A.id}/journals/${journalId}?view=html`)).data.includes('Missing source line'));
  await runtime.store.flush();
  const reopened = new Store({dataDir: runtime.store.dataDir, logger: quiet});
  assert.equal(JSON.stringify(reopened.state.journals[journalId]), JSON.stringify(detail));
});

test('snapshot promotion retries concurrent slot, source, raw and delete changes without copying maps', async t => {
  const dataDir = scratch(t); const store = new Store({dataDir, logger: quiet});
  store.setTypes(MODEL);
  for (let n = 0; n < 100; n++) store.upsert('doc-' + n, document({'Heading$$String___searchable': 'x'.repeat(3000)}));
  await store.flush();
  const before = readFileSync(join(dataDir, 'store.ndjson'), 'utf8');
  const originalOpen = fs.open; let changed = false; let writes = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args); const originalWrite = handle.writeFile.bind(handle);
    handle.writeFile = async (...writeArgs) => {
      writes++;
      const result = await originalWrite(...writeArgs);
      if (!changed) {
        changed = true;
        assert.equal(readFileSync(join(dataDir, 'store.ndjson'), 'utf8'), before, 'Old snapshot remains valid while writing');
        store.mutate('deployNewAccountVersion'); store.setTypes(MODEL, {slot: 'new'});
        store.upsert('new-doc', document(), {slot: 'new'}); store.mutate('useNewAccountVersion');
        store.delete('new-doc', {hard: false, snapshotTime: '2027-05-01'});
        store.setTypes({contentTypes: {Extra: {properties: {}}}}, {source: 'extra'});
      }
      return result;
    };
    return handle;
  });
  await store.flush();
  assert.ok(changed && writes > 2);
  const reopened = new Store({dataDir, logger: quiet});
  assert.deepEqual(reopened.state, store.state);
  assert.equal(Object.keys(reopened.state.docs).length, 1);
  assert.equal(Object.keys(reopened.state.slots.old.docs).length, 100);
  assert.equal(reopened.state.docs['new-doc'].raw._deleted, true);
  assert.ok(reopened.state.types.extra);
});

test('health exposes memory only to admins, retains lazy tenant counts, and dashboard warns strictly above 75%', async t => {
  const admin = 'Basic ' + Buffer.from('manager:password').toString('base64');
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  assert.deepEqual((await gw.request('/health', {auth: null})).data, {status: 'ok', product: product.key, version: product.version, dataVersion: product.dataVersion});
  const health = (await gw.request('/health', {auth: admin})).data;
  assert.deepEqual(health.tenants, {[A.id]: {loaded: false, docs: 0}, [B.id]: {loaded: false, docs: 0}});
  assert.equal(gw.server.tenants.runtimes.size, 0);
  for (const name of ['heapUsed', 'heapLimit', 'rss']) assert.ok(Number.isSafeInteger(health.memory[name]) && health.memory[name] > 0);
  assert.ok(health.memory.heapLimit >= health.memory.heapUsed);
  await gw.request('/api/content/v3/types', {method: 'PUT', body: MODEL, auth: basic(A)});
  await gw.request('/_doc/one', {method: 'POST', body: document(), auth: basic(A)});
  assert.equal(success(await gw.gql('{ArticlePage{total}}', {}, {auth: basic(A)}), 'ArticlePage').total, 1);
  assert.deepEqual((await gw.request('/health', {auth: admin})).data.tenants[A.id], {loaded: true, docs: 1});
  const dashboard = (await gw.request('/', {auth: admin})).data;
  for (const label of ['Process memory', 'Heap used:', 'Heap limit:', 'RSS:', '1</span> live documents']) assert.ok(dashboard.includes(label), label);
  assert.doesNotMatch(memoryHtml({heapUsed: 75, heapLimit: 100, rss: 100}), /Memory warning/);
  assert.match(memoryHtml({heapUsed: 76, heapLimit: 100, rss: 100}), /role="alert">Memory warning/);
  assert.ok(processMemory().heapLimit > 0);
});
