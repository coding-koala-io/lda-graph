import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {Store} from '../src/store.js';
import {getIndex, candidatesFor} from '../src/indexes.js';
import {compileWhere, matchWhere, evaluateQuery} from '../src/query-engine.js';
import {recycleDecision, recycleSettings, startRecycle} from '../src/recycle.js';
import {document, MODEL} from './fixtures.js';
import {quiet} from './helpers.js';
import {tenants, A} from './tenant-helpers.js';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-perf-'));
  t.after(() => { const inside = relative(resolve(tmpdir()), resolve(dir)); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); rmSync(dir, {recursive: true, force: true}); });
  return dir;
}
function storeFor(t, options = {}) { const store = new Store({dataDir: ':memory:', logger: quiet, ...options}); t.after(() => store.dispose()); return store; }
const context = {auth: 'basic', headers: {}, slot: 'live'};

test('indexes follow replacements, deletes, numeric insertion order, slots and resets', t => {
  const store = storeFor(t);
  for (const id of ['z', '10', '2', 'a', '0']) store.upsert(id, document({metadata: {key: id}}));
  const ids = () => candidatesFor(store.state.docs, 'ArticlePage', {});
  assert.deepEqual(ids(), Object.keys(store.state.docs));
  store.upsert('z', document({metadata: {key: 'changed', url: {default: ['/one', '/two']}}}));
  assert.deepEqual(candidatesFor(store.state.docs, '_Content', {where: {_metadata: {url: {default: {in: ['/TWO']}}}}}), ['z']);
  assert.deepEqual(candidatesFor(store.state.docs, '_Content', {ids: ['CHANGED']}), ['z']);
  store.delete('z', {hard: false}); assert.deepEqual(ids(), Object.keys(store.state.docs));
  store.delete('2'); store.upsert('a', document()); store.delete('a'); store.upsert('a', document());
  assert.deepEqual(ids(), Object.keys(store.state.docs));
  const liveIndex = getIndex(store.state.docs);
  store.mutate('deployNewAccountVersion'); store.upsert('new', document(), {slot: 'new'});
  const nextIndex = getIndex(store.slot('new').docs);
  store.mutate('useNewAccountVersion'); assert.equal(getIndex(store.state.docs), nextIndex); assert.equal(getIndex(store.state.slots.old.docs), liveIndex);
  store.mutate('useOldAccountVersion'); assert.equal(getIndex(store.state.docs), liveIndex);
  store.reset(); assert.deepEqual(ids(), []);
});

test('required index clauses never narrow optional or uninterpretable predicates', t => {
  const store = storeFor(t); store.upsert('one', document()); store.upsert('two', document({metadata: {key: 'two'}}));
  for (const where of [
    {_or: [{_metadata: {key: {eq: 'two'}}}, {Number: {eq: 7}}]},
    {_not: {_metadata: {key: {eq: 'two'}}}},
    {_metadata: {eq: {}, key: {eq: 'missing'}}},
    {_metadata: {key: {eq: null}}},
  ]) {
    const actual = evaluateQuery(store, '_Content', {where}, context).items.map(d => d._id);
    const expected = Object.values(store.state.docs).filter(r => matchWhere(r.normalized, where, r).match).map(r => r.normalized._id).sort();
    assert.deepEqual(actual.sort(), expected);
  }
  store.upsert('skip', document({_metadata___skip: {key: 'secret', types: ['_Content']}}));
  assert.deepEqual(candidatesFor(store.state.docs, '_Content', {where: {_metadata: {key: {eq: 'secret'}}}}), []);
  assert.deepEqual(candidatesFor(store.state.docs, '_Content', {where: {_and: [{_metadata: {key: {in: ['two']}}}]}}), ['two']);
});

test('compiled filters match the reference evaluator including arrays, scores, nulls and HTML', t => {
  const store = storeFor(t);
  store.upsert('one', document({Nested: [{a: 'red', b: 'no'}, {a: 'blue', b: 'yes'}], Heading___searchable: '<p>résumé quick &lt;em&gt;alpha&lt;/em&gt;</p>'}));
  const record = store.state.docs.one;
  const clauses = [null, {}, {_and: []}, {_or: []}, {_not: []}, {Nested: {a: {eq: 'red'}, b: {eq: 'yes'}}}, {Nested: {_or: [{a: {eq: 'red'}}, {b: {eq: 'yes'}}]}}, {Tags: {exist: true}}, {Tags: {exist: true, factor: {value: 2}}}, {Unindexed: {eq: 'secret unsearchable'}}, {_fulltext: {match: 'quick quick', boost: 3}}, {_fulltext: {phrase: 'quick content'}}, {_fulltext: {wildcard: 'qu* r?sumé'}}, {_fulltext: {fuzzy: 'quik'}}, {Number: {gte: 2, factor: {value: 2, modifier: 'LOG1P'}, boost: 4}}, {_metadata: {lastModified: {decay: {origin: '2026-10-13', scale: 3}}}}, {Heading: {match: null, boost: 2}}];
  const values = [null, '', 'QUICK', '<b>quick</b> résumé', 2, true, ['quick', 'no'], []];
  const operators = ['eq', 'notEq', 'in', 'notIn', 'exist', 'contains', 'startsWith', 'endsWith', 'like', 'match', 'phrase', 'wildcard', 'fuzzy', 'gt', 'gte', 'lt', 'lte'];
  for (const op of operators) for (const value of values) clauses.push({Heading: {[op]: value, boost: 2}});
  for (const where of clauses) assert.deepEqual(compileWhere(where)(record.normalized, record), matchWhere(record.normalized, where, record), JSON.stringify(where));
});

test('continuous 100ms pushes finish snapshots and load while writes continue', async t => {
  const dir = scratch(t); const store = storeFor(t, {dataDir: dir});
  let completed = 0; const original = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => { await original(); completed++; const read = storeFor(t, {dataDir: dir}); assert.ok(Object.keys(read.state.docs).length); };
  const timer = setInterval(() => store.upsert('doc-' + Date.now(), document()), 100);
  try { await new Promise(resolve => setTimeout(resolve, 3000)); } finally { clearInterval(timer); }
  assert.ok(completed > 0); await store.flush();
});

test('snapshot promotion is consistent during soft delete and preserves last good file on failure', async t => {
  const dir = scratch(t); const store = storeFor(t, {dataDir: dir});
  for (let i = 0; i < 60; i++) store.upsert('doc-' + i, document({Heading___searchable: 'x'.repeat(3000)}));
  await store.flush(); const before = readFileSync(join(dir, 'store.ndjson'), 'utf8');
  const old = store.state.docs['doc-59']; const originalOpen = fs.open; let injected = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args); const write = handle.writeFile.bind(handle);
    handle.writeFile = async data => { if (!injected) { injected = true; store.delete('doc-59', {hard: false, snapshotTime: '2027-01-01'}); } return write(data); }; return handle;
  });
  const promoted = []; const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { await originalRename(...args); if (args[1].endsWith('store.ndjson')) promoted.push(readFileSync(args[1], 'utf8')); });
  await store.flush(); assert.equal(old.normalized._deleted, false); assert.equal(old.raw._deleted, undefined);
  assert.equal(promoted[0], before); assert.ok(promoted.at(-1).includes('"_deleted":true'));
  t.mock.restoreAll();
  t.mock.method(fs, 'rename', async () => { throw new Error('simulated crash before rename'); });
  const last = readFileSync(join(dir, 'store.ndjson'), 'utf8'); store.upsert('later', document());
  await assert.rejects(store.flush(), /simulated crash/); assert.equal(readFileSync(join(dir, 'store.ndjson'), 'utf8'), last);
  assert.ok(existsSync(join(dir, 'store.ndjson'))); clearTimeout(store.timer);
});

test('previous-slot expiry persists, handles legacy timestamps and supports keep forever', async t => {
  const dir = scratch(t); const store = storeFor(t, {dataDir: dir, previousSlotHours: 24});
  store.upsert('old', document()); store.mutate('deployNewAccountVersion'); store.mutate('useNewAccountVersion');
  const since = Date.parse(store.state.metadata.oldSlotSince); assert.ok(store.previousSlotExpires());
  assert.equal(store.expirePrevious(since + 24 * 3600000), false);
  await store.flush(); const restored = storeFor(t, {dataDir: dir}); assert.equal(restored.state.metadata.oldSlotSince, store.state.metadata.oldSlotSince);
  assert.equal(restored.expirePrevious(since + 25 * 3600000), true); assert.equal(restored.state.slots.old, undefined);
  store.previousSlotHours = 0; assert.equal(store.expirePrevious(since + 999 * 3600000), false); assert.equal(store.previousSlotExpires(), null);
  delete store.state.metadata.oldSlotSince; store.expirePrevious(since); assert.equal(store.state.metadata.oldSlotSince, new Date(since).toISOString());
  store.state.metadata.oldSlotSince = '2000-01-01'; await store.flush();
  const expiredOnLoad = storeFor(t, {dataDir: dir}); assert.equal(expiredOnLoad.state.slots.old, undefined);
});

test('dashboard, health and explorer picker leave tenant stores unloaded', async t => {
  const logs = [];
  const gw = await tenants(t, {logger: {log: text => logs.push(text), error() {}}, memoryRecycleMb: '0'});
  for (const path of ['/', '/explorer', '/health']) assert.equal((await gw.request(path)).status, 200);
  assert.ok([...gw.server.tenants.runtimes.values()].every(r => !r.store));
  assert.deepEqual((await gw.request('/health')).data.recycle, {enabled: false, thresholdMb: 0, last: null});
  const page = (await gw.request('/')).data; assert.match(page, /not loaded/); assert.match(page, new RegExp(`href="/tenants/${A.id}">Load`));
  await gw.request('/tenants/' + A.id); assert.ok(gw.server.tenants.get(A.id, false).store);
  assert.ok(logs.some(line => /^\[site-a\] loading store \(0\.0 MB\)…$/.test(line)));
  assert.ok(logs.some(line => /^\[site-a\] loaded store in \d+ ms$/.test(line)));
});

test('recycle requires 3 consecutive checks, respects cooldown and warns hourly', () => {
  const state = {}; let now = Date.parse('2026-10-19T00:00:00Z');
  const tick = (heapUsed, last) => recycleDecision(state, {heapUsed: heapUsed * 1048576, now, thresholdMb: 10, last});
  assert.equal(tick(11), 'wait'); assert.equal(tick(10), 'wait'); assert.equal(tick(11), 'wait'); assert.equal(tick(11), 'wait');
  const last = new Date(now).toISOString(); assert.equal(tick(11, last), 'warn'); assert.equal(tick(11, last), 'wait');
  now += 3600000; assert.equal(tick(11, new Date(now).toISOString()), 'warn'); assert.equal(tick(11, last), 'recycle');
  assert.deepEqual(recycleSettings({value: '0'}), {enabled: false, thresholdMb: 0}); assert.equal(recycleSettings({value: '12', platform: 'linux'}).enabled, true);
  assert.equal(recycleSettings({value: null, env: {}, platform: 'win32'}).enabled, false);
  assert.deepEqual(recycleSettings({value: null, env: {BASE: 'synthetic-wrapper', SERVICE_ID: 'test'}, platform: 'win32', heapLimit: 100 * 1048576}), {enabled: true, thresholdMb: 75});
});

test('recycle drains connections, flushes despite failures, persists cooldown and exits 75 via injection', async t => {
  const dir = scratch(t); const calls = []; const runtime = {tenant: {id: 'test'}, store: {flush: async () => { calls.push('flush'); throw new Error('synthetic failure'); }}};
  const controller = startRecycle({server: {close: cb => { calls.push('close'); cb(); }}, registry: {runtimes: new Map([['test', runtime]])}, logDir: dir, logger: quiet, value: '1', memory: () => 2 * 1048576, now: () => 1700000000000, exit: code => calls.push(code)});
  t.after(controller.stop); await controller.tick(); await controller.tick(); await controller.tick();
  assert.deepEqual(calls, ['close', 'flush', 75]); assert.equal(JSON.parse(readFileSync(join(dir, '_recycle.json'))).last, new Date(1700000000000).toISOString());
  const restarted = startRecycle({logDir: dir, logger: quiet, value: '1', memory: () => 2 * 1048576, now: () => 1700000000001, exit: () => assert.fail('cooldown must prevent exit')}); t.after(restarted.stop);
  await restarted.tick(); await restarted.tick(); await restarted.tick();
});

test('shutdown flush skips a clean snapshot while explicit flush retains its embedding contract', async t => {
  const store = storeFor(t, {dataDir: scratch(t)}); store.upsert('one', document()); await store.flush();
  let writes = 0; const original = store.writeSnapshot.bind(store); store.writeSnapshot = async () => { writes++; await original(); };
  await store.flush({onlyIfChanged: true}); assert.equal(writes, 0); await store.flush(); assert.equal(writes, 1);
  const restored = storeFor(t, {dataDir: store.dataDir});
  restored.writeSnapshot = () => assert.fail('An unchanged loaded snapshot must not be rewritten on shutdown');
  await restored.flush({onlyIfChanged: true});
});

test('ids preserve skipped key matches and soft delete preserves normalized field order', t => {
  const store = storeFor(t);
  store.upsert('one', document({_metadata___skip: {key: 'secret', types: ['_Content']}}));
  assert.deepEqual(evaluateQuery(store, '_Content', {ids: ['SECRET']}, context).items.map(d => d._id), ['one']);
  const keys = Object.keys(store.state.docs.one.normalized);
  store.delete('one', {hard: false}); assert.deepEqual(Object.keys(store.state.docs.one.normalized), keys);
});

test('recycle closes lingering connections after the drain deadline before flushing', async t => {
  const calls = [];
  const controller = startRecycle({server: {close: () => calls.push('close'), closeAllConnections: () => calls.push('disconnect')}, registry: {runtimes: new Map([['test', {tenant: {id: 'test'}, store: {flush: async () => calls.push('flush')}}]])}, logDir: ':memory:', logger: quiet, value: '1', memory: () => 2 * 1048576, drainMs: 5, exit: code => calls.push(code)});
  t.after(controller.stop); await controller.tick(); await controller.tick(); await controller.tick();
  assert.deepEqual(calls, ['close', 'disconnect', 'flush', 75]);
});
