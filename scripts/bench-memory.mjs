import {Store} from '../src/store.js';
import {cachedFulltext, compileWhere, autocomplete} from '../src/query-engine.js';
import {syntheticDocument} from './bench-query.mjs';
import {getIndex} from '../src/indexes.js';
import {writeFile} from 'node:fs/promises';
if (!global.gc) throw new Error('Run with --expose-gc');
const n = Number(process.argv[2] ?? 60000);
const store = new Store({dataDir: ':memory:'});
for (let i = 0; i < n; i++) store.upsert('doc-' + i, syntheticDocument(i));
getIndex(store.state.docs);
global.gc(); const baselineHeap = process.memoryUsage().heapUsed;
const predicate = compileWhere({Heading: {match: 'koala'}, MainBody: {html: {phrase: 'learn about'}}});
for (const record of Object.values(store.state.docs)) { cachedFulltext(record); predicate(record.normalized, record); }
autocomplete({records: Object.values(store.state.docs).map(record => ({record, doc: record.normalized}))}, 'Heading', {value: 'article'});
global.gc(); const cachedHeap = process.memoryUsage().heapUsed;
const result = {n, baselineHeap, cachedHeap, delta: cachedHeap - baselineHeap, percent: (cachedHeap - baselineHeap) / baselineHeap * 100, docsRetained: Object.keys(store.state.docs).length};
console.log(JSON.stringify(result, null, 2));
await writeFile('perf-results/memory.json', JSON.stringify(result, null, 2) + '\n');
store.dispose();
