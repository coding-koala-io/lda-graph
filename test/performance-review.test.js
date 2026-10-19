import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {Store} from '../src/store.js';
import {compactJournal} from '../src/journal.js';
import {startRecycle, recycleSettings} from '../src/recycle.js';
import {evaluateQuery} from '../src/query-engine.js';
import {handleProtocol} from '../src/protocol-routes.js';
import {clearTenant} from '../src/dashboard-data.js';
import {document} from './fixtures.js';
import {quiet} from './helpers.js';
import {tenants, A} from './tenant-helpers.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'graph-review-'));
  t.after(async () => {
    const inside = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    await rm(dir, {recursive: true, force: true});
  });
  return dir;
}
function makeStore(t, options = {}) {
  const store = new Store({dataDir: ':memory:', logger: quiet, ...options});
  t.after(() => store.dispose());
  return store;
}

test('1000 large journals snapshot without expanding items during synchronous capture', async t => {
  const store = makeStore(t, {dataDir: await scratch(t)});
  const items = Array.from({length: 500}, (_, i) => ({index: {Status: 201, _index: 'default', _id: `doc-${i}`, Result: 'created'}}));
  let calls = 0;
  for (let i = 0; i < 1000; i++) {
    const journal = compactJournal({items, status: 'done'});
    const get = Object.getOwnPropertyDescriptor(journal, 'items').get;
    Object.defineProperty(journal, 'items', {enumerable: true, get() { calls++; return get.call(this); }});
    store.state.journals[i] = journal;
  }
  const start = performance.now();
  const pending = store.writeSnapshot();
  const synchronousMs = performance.now() - start;
  assert.equal(calls, 0, 'snapshot capture must retain immutable journal references');
  assert.ok(synchronousMs < 250, `synchronous capture blocked for ${synchronousMs} ms`);
  await pending;
  assert.equal(calls, 1000, 'only the streaming JSON serializer expands items');
  t.diagnostic(`1000 x 500 journal capture: ${synchronousMs.toFixed(2)} ms; zero getter calls`);
});

for (const changedDuringSave of [false, true]) test(`overlapping flush writes ${changedDuringSave ? 'twice with a new revision' : 'once without new changes'}`, async t => {
  const store = makeStore(t, {dataDir: await scratch(t)});
  store.upsert('one', document());
  let release; const gate = new Promise(resolve => release = resolve);
  let writes = 0; const original = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => { writes++; await original(); if (writes === 1) await gate; };
  const saving = store.flush();
  if (changedDuringSave) store.upsert('two', document());
  const overlapping = store.flush({onlyIfChanged: true});
  assert.equal(overlapping, saving);
  release(); await overlapping;
  assert.equal(writes, changedDuringSave ? 2 : 1);
  const restored = makeStore(t, {dataDir: store.dataDir});
  assert.equal(Object.keys(restored.state.docs).length, changedDuringSave ? 2 : 1);
});

test('restarted live data above threshold disables recycling once, including lazy tenant loads', async t => {
  const dir = await scratch(t); const last = '2026-10-18T00:00:00Z';
  await writeFile(join(dir, '_recycle.json'), JSON.stringify({last}));
  const warnings = []; let heap = 0; let time = Date.parse('2026-10-19T00:00:00Z');
  const registry = {runtimes: new Map()};
  const controller = startRecycle({registry, logDir: dir, value: '10', memory: () => heap * 1048576,
    now: () => time, exit: () => assert.fail('live data must not trigger another restart'),
    logger: {...quiet, warn: line => warnings.push(line)}});
  t.after(controller.stop);
  await controller.tick(); // Idle startup before the first tenant loads.
  registry.runtimes.set('large', {store: {}}); heap = 11;
  await controller.tick(); await controller.tick();
  assert.equal(controller.health().enabled, true);
  await controller.tick();
  assert.equal(controller.health().enabled, false);
  time += 2 * 3600000;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.deepEqual(warnings, ['heap is above the recycle threshold right after start; data is too large for the limit - raise --max-old-space-size or MEMORY_RECYCLE_MB']);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '_recycle.json'), 'utf8')), {last, lastStartAboveThreshold: '2026-10-19T00:00:00.000Z'});
});

test('restarted process below threshold can still recycle after subsequent growth', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, '_recycle.json'), JSON.stringify({last: '2026-10-18T00:00:00Z'}));
  let heap = 9; const exits = [];
  const controller = startRecycle({registry: {runtimes: new Map()}, server: {close: callback => callback()}, logDir: dir,
    value: '10', logger: quiet, memory: () => heap * 1048576, now: () => Date.parse('2026-10-19T00:00:00Z'), exit: code => exits.push(code)});
  t.after(controller.stop);
  await controller.tick(); heap = 11;
  await controller.tick(); await controller.tick(); await controller.tick();
  assert.deepEqual(exits, [75]);
});

test('automatic recycle requires Windows and both WinSW variables', () => {
  for (const env of [{}, {BASE: 'folder'}, {SERVICE_ID: 'id'}]) assert.equal(recycleSettings({value: null, platform: 'win32', env}).enabled, false);
  assert.equal(recycleSettings({value: null, platform: 'linux', env: {BASE: 'folder', SERVICE_ID: 'id'}}).enabled, false);
  assert.equal(recycleSettings({value: null, platform: 'win32', env: {BASE: 'folder', SERVICE_ID: 'id'}}).enabled, true);
});

test('dispose clears pending saves before final flush', async t => {
  const store = makeStore(t, {dataDir: await scratch(t)});
  store.upsert('one', document()); assert.ok(store.timer);
  store.dispose(); assert.equal(store.timer, null);
  let writes = 0; const original = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => { writes++; await original(); };
  await store.flush({onlyIfChanged: true});
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(writes, 1);
});

test('tenant rename disposes save timers before flushing and moving the old folder', async t => {
  const gw = await tenants(t, {memoryRecycleMb: '0'});
  const registry = gw.server.tenants; const runtime = registry.get(A.id);
  runtime.store.upsert('one', document()); assert.ok(runtime.store.timer);
  const flush = runtime.store.flush.bind(runtime.store); let flushed = false;
  runtime.store.flush = async options => {
    assert.equal(runtime.store.timer, null, 'dispose must happen before the final flush');
    flushed = true; await flush(options);
  };
  await registry.apply(registry.entries.map(entry => entry.id === A.id ? {...entry, id: 'renamed'} : entry), {renameFrom: A.id});
  assert.equal(flushed, true);
  await new Promise(resolve => setTimeout(resolve, 550));
  await assert.rejects(readFile(join(gw.root, 'data', A.id, 'store.ndjson')), {code: 'ENOENT'});
  assert.match(await readFile(join(gw.root, 'data', 'renamed', 'store.ndjson'), 'utf8'), /"id":"one"/);
});

test('previous-slot timestamp clears on purge, source reset, reset and revert while abandon retains a valid old slot', async t => {
  const store = makeStore(t);
  const promote = () => { store.mutate('deployNewAccountVersion'); store.mutate('useNewAccountVersion'); assert.ok(store.state.metadata.oldSlotSince); };
  for (const path of ['/api/content/v2/data', '/api/content/v3/sources?mode=reset']) {
    promote(); const url = new URL(path, 'http://localhost');
    await handleProtocol({path: url.pathname, method: 'DELETE', url, store, slot: 'live', source: 'default', rebuild() {}, send() {}});
    assert.equal(store.state.slots.old, undefined); assert.equal(store.state.metadata.oldSlotSince, undefined);
  }
  for (const action of ['reset', 'useOldAccountVersion']) {
    promote(); action === 'reset' ? store.reset() : store.mutate(action);
    assert.equal(store.state.metadata.oldSlotSince, undefined);
  }
  promote(); clearTenant({store, rebuild() {}}, ['content']);
  assert.equal(store.state.metadata.oldSlotSince, undefined);
  store.state.metadata.oldSlotSince = 'stale'; store.mutate('abandonSlot'); assert.equal(store.state.metadata.oldSlotSince, undefined);
  promote(); const since = store.state.metadata.oldSlotSince;
  store.mutate('abandonSlot'); assert.equal(store.state.metadata.oldSlotSince, since);
});

test('indexed query logs a missing normalized record only once', t => {
  const errors = []; const store = makeStore(t, {logger: {...quiet, error: text => errors.push(text)}});
  store.state.docs.bad = {raw: {}};
  store.upsert('good', document());
  for (let i = 0; i < 2; i++) evaluateQuery(store, '_Content', {}, {auth: 'basic', headers: {}});
  assert.equal(errors.length, 1); assert.match(errors[0], /Skipping malformed document .*Invalid normalized record/);
});

test('invalid previous-slot limits warn and default to 24; zero keeps forever', t => {
  for (const value of ['invalid', -1, 'NaN', Infinity, '']) {
    const warnings = [];
    const store = makeStore(t, {previousSlotHours: value, logger: {...quiet, warn: text => warnings.push(text)}});
    assert.equal(store.previousSlotHours, 24); assert.equal(warnings.length, 1); assert.match(warnings[0], /PREVIOUS_SLOT_HOURS.*default 24/);
  }
  assert.equal(makeStore(t, {previousSlotHours: '0'}).previousSlotHours, 0);
});
