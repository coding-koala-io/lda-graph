// Dev-only benchmark. Run: node scripts/bench-memory.js [5000 20000]
// Fresh workers isolate load peaks from fixture generation. No HTTP ports/services.
import assert from 'node:assert/strict';
import {mkdtempSync, openSync, writeSync, closeSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {graphql} from 'graphql';
import {Store} from '../src/store.js';
import {buildSchema} from '../src/schema.js';
import {RequestLog, truncate} from '../src/request-log.js';
import {TYPES, DOCUMENTS} from '../test/synthetic-fixtures.js';

const MiB = 1024 ** 2;
const quiet = {log() {}, error(message) { throw new Error(message); }};
const gcMemory = () => { global.gc(); return process.memoryUsage(); };
function rawDocument(n) {
  const template = DOCUMENTS[[3, 5, 6, 9][n % 4]][1];
  const doc = structuredClone(template);
  const key = Math.floor(n / 6).toString(16).padStart(32, '0');
  const locale = ['en', 'sv', 'de'][Math.floor(n / 2) % 3];
  Object.assign(doc._metadata, {key, locale, locales: ['en', 'sv', 'de'], version: String(n % 2 + 3), status: n % 2 ? 'Draft' : 'Published', displayName___searchable: `CMS document ${n}`});
  // Numerous real-shaped property objects plus HTML/editor JSON: 2–30 KiB raw.
  doc.ContentArea = Array.from({length: 2 + n % 12}, (_, j) => ({__typename: 'CardBlock',
    _metadata: {key: `${key}-${j}`, displayOption___skip: 'wide'},
    'Heading$$String___searchable': `Card ${n}/${j}`, Image: {__typename: 'ContentReference', 'key$$String': key, item: `doc-${n - n % 6}`, url: {__typename: 'ContentUrl', 'default$$String': `/assets/${n}/${j}.png`}}}));
  const text = `CMS ${n}: published content, café, navigation, search and media. `;
  const repetitions = 2 + n % 150;
  doc.MainBody = {__typename: 'SearchableRichText', 'html$$String': `<p>${text.repeat(repetitions)}</p>`, 'json$$JSON___skip': JSON.stringify({type: 'root', children: [{type: 'paragraph', text: text.repeat(repetitions)}]})};
  doc['Payload$$JSON___skip'] = Array.from({length: 2 + n % 7}, (_, j) => ({label: `Property ${j}`, value: `${n}-${j}`, enabled: true, settings: {width: 320, height: 200}}));
  return doc;
}
function fixture(folder, count) {
  mkdirSync(join(folder, 'logs'));
  const fd = openSync(join(folder, 'store.ndjson'), 'w');
  const write = entry => writeSync(fd, JSON.stringify(entry) + '\n');
  let bytes = 0; let minimum = Infinity; let maximum = 0;
  try {
    write({record: 'header', version: 1});
    write({record: 'types', slot: 'live', id: 'default', value: TYPES});
    for (let n = 0; n < count; n++) {
      const raw = rawDocument(n); const size = Buffer.byteLength(JSON.stringify(raw));
      bytes += size; minimum = Math.min(minimum, size); maximum = Math.max(maximum, size);
      write({record: 'docs', slot: 'live', id: `doc-${n}`, value: {raw, snapshotTime: '2026-01-02T12:00:00Z', locale: raw._metadata.locale}});
    }
    // Full-sync history: 100 operations per batch, constants match actual replies.
    for (let n = 0; n < 1000; n++) write({record: 'journals', id: `journal-${n}`, value: {ts: '2026-01-02T12:00:00Z', took: 1, errors: false, status: 'done', items: Array.from({length: 100}, (_, j) => ({index: {Status: 201, _index: 'default', _id: `doc-${(n * 100 + j) % count}`, Result: 'created'}}))}});
    write({record: 'end'});
  } finally { closeSync(fd); }
  const logFd = openSync(join(folder, 'logs', 'requests.ndjson'), 'w');
  try {
    for (let n = 0; n < 500; n++) writeSync(logFd, JSON.stringify({n: n + 1, ts: '2026-01-02T12:00:00Z', method: 'POST', url: '/_stream', status: 200, headers: {'content-type': 'application/x-ndjson', authorization: 'Basic'}, reqBody: truncate(JSON.stringify({index: {_id: `doc-${n}`}}) + '\n' + JSON.stringify(rawDocument(n))), resBody: {journalId: `journal-${n}`}}) + '\n');
  } finally { closeSync(logFd); }
  return {rawMiB: bytes / MiB, minKiB: minimum / 1024, maxKiB: maximum / 1024};
}
async function worker(folder, count) {
  const baseline = gcMemory(); let peakHeap = baseline.heapUsed; let peakRss = baseline.rss;
  const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
  // Synchronous loading cannot be sampled by an interval; sample parse boundaries.
  const parse = JSON.parse; JSON.parse = function (...args) { sample(); return parse.apply(this, args); };
  const started = performance.now(); let store;
  try { store = new Store({dataDir: folder, logger: quiet}); } finally { JSON.parse = parse; }
  const loadMs = performance.now() - started;
  assert.equal(Object.keys(store.state.docs).length, count);
  let schemas = [buildSchema(store.state.types.default, store, {logger: quiet}), buildSchema({}, store, {logger: quiet})];
  const log = new RequestLog(join(folder, 'logs'), quiet); log.load();
  const queriesStarted = performance.now();
  for (const source of ['{_Content(locale:ALL,limit:10){total items{_id _metadata{locale version}}}}', '{ArticlePage(where:{_fulltext:{match:"navigation"}},locale:ALL,limit:5){total items{Heading MainBody{html}}}}', '{PictureMedia(locale:ALL,limit:5){total items{_id _assetMetadata{mimeType}}}}']) {
    const result = await graphql({schema: schemas[0], source, contextValue: {auth: 'basic'}});
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    sample();
  }
  const queriesMs = performance.now() - queriesStarted;
  const loaded = gcMemory();
  const interval = setInterval(sample, 1);
  const saveStarted = performance.now();
  try { await store.flush(); } finally { clearInterval(interval); }
  const saveMs = performance.now() - saveStarted; sample();
  await new Promise(resolve => setImmediate(resolve));
  const retained = gcMemory();
  // Marginal retained heap: release each component, force GC, measure the delta.
  schemas = null; let previous = retained.heapUsed;
  const released = () => { const current = gcMemory().heapUsed; const delta = (previous - current) / MiB; previous = current; return delta; };
  const schemaMiB = released();
  for (const id in store.state.docs) { const record = store.state.docs[id]; delete record.raw; delete record.rawJson; }
  const rawMiB = released();
  for (const id in store.state.docs) { const record = store.state.docs[id]; delete record.normalized; delete record.searchable; delete record.skipped; }
  store.state.docs = {};
  const normalizedMiB = released();
  store.state.journals = {};
  const journalsMiB = released();
  log.recent = [];
  const requestLogMiB = released();
  return {docs: count, heapMiB: retained.heapUsed / MiB, rssMiB: retained.rss / MiB, heapPer1000MiB: (retained.heapUsed - baseline.heapUsed) / MiB * 1000 / count, rssPer1000MiB: (retained.rss - baseline.rss) / MiB * 1000 / count, peakHeapMiB: peakHeap / MiB, peakRssMiB: peakRss / MiB, loadMs, queriesMs, saveMs, rawMiB, normalizedMiB, schemaMiB, journalsMiB, requestLogMiB, baselineMiB: baseline.heapUsed / MiB, queriedHeapMiB: loaded.heapUsed / MiB};
}
if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(process.argv[3], Number(process.argv[4]))));
} else {
  const counts = process.argv.slice(2).map(Number);
  const rows = [];
  for (const count of counts.length ? counts : [5000, 20000]) {
    assert.ok(Number.isSafeInteger(count) && count > 0, 'N must be a positive integer');
    const folder = mkdtempSync(join(tmpdir(), 'graph-memory-bench-'));
    try {
      const input = fixture(folder, count);
      const result = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--worker', folder, String(count)], {encoding: 'utf8', windowsHide: true, maxBuffer: MiB});
      assert.equal(result.status, 0, result.stdout + result.stderr);
      rows.push({...JSON.parse(result.stdout), ...input});
    } finally {
      const inside = relative(resolve(tmpdir()), resolve(folder));
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
      rmSync(folder, {recursive: true, force: true});
    }
  }
  console.log('MiB = 1,048,576 bytes; per-1,000 values subtract the fresh-worker baseline. Peaks sampled at JSON parse boundaries, after queries, and during snapshot writes. Breakdown = marginal retained heap released with forced GC (normalized includes document maps/search paths).');
  for (const fields of [['docs', 'heapMiB', 'rssMiB', 'heapPer1000MiB', 'rssPer1000MiB', 'peakHeapMiB', 'peakRssMiB', 'loadMs', 'queriesMs', 'saveMs'], ['docs', 'rawMiB', 'normalizedMiB', 'schemaMiB', 'journalsMiB', 'requestLogMiB', 'baselineMiB', 'minKiB', 'maxKiB']]) {
    console.log('| ' + fields.join(' | ') + ' |'); console.log('| ' + fields.map(() => '---').join(' | ') + ' |');
    for (const row of rows) console.log('| ' + fields.map(field => field === 'docs' ? row[field] : row[field].toFixed(2)).join(' | ') + ' |');
  }
  console.log('JSON ' + JSON.stringify(rows));
}
