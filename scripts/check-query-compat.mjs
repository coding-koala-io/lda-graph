import assert from 'node:assert/strict';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/store.js';
import * as current from '../src/query-engine.js';
import {syntheticDocument} from './bench-query.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
const baseline = process.argv[2]; if (!baseline) throw new Error('Pass the read-only baseline checkout path');
const {Store: BaselineStore} = await import(pathToFileURL(join(resolve(baseline), 'src/store.js')));
const prior = await import(pathToFileURL(join(resolve(baseline), 'src/query-engine.js')));
const quiet = {log() {}, error() {}};
const stores = [new Store({dataDir: ':memory:', logger: quiet}), new BaselineStore({dataDir: ':memory:', logger: quiet})];
for (let i = 0; i < 400; i++) {
  const doc = syntheticDocument(i);
  doc.Nested = [{a: 'red', b: 'no'}, {a: 'blue', b: 'yes'}];
  if (i % 7 === 0) doc._deleted = true;
  if (i % 9 === 0) doc._metadata.variation = 'test';
  if (i % 11 === 0) doc._metadata.status = 'Draft';
  if (i % 13 === 0) doc._rbac = ['r:Editors:Read'];
  if (i % 17 === 0) { doc._metadata___skip = {...doc._metadata}; delete doc._metadata; }
  const id = i % 3 ? 'doc-' + i : String(i);
  for (const store of stores) store.upsert(id, doc);
}
const clauses = [undefined, {}, {_and: []}, {_or: []}, {_not: []}, {_metadata: {key: {eq: 'KEY-1'}}}, {_metadata: {url: {default: {in: ['/articles/1', '/articles/2']}}}}, {_and: [{_metadata: {key: {in: ['key-1', 'key-2']}}}, {_metadata: {url: {default: {eq: '/articles/2'}}}}]}, {_or: [{_metadata: {key: {eq: 'key-1'}}}, {_fulltext: {match: 'koala', boost: 2}}]}, {_not: [{_metadata: {key: {eq: 'key-1'}}}]}, {_fulltext: {match: 'koala article'}}, {_fulltext: {phrase: 'learn about'}}, {_fulltext: {wildcard: 'ko* ar?icle'}}, {_fulltext: {fuzzy: 'koalla'}}, {Heading: {match: 'koala', boost: 3}}, {Nested: {a: {eq: 'red'}, b: {eq: 'yes'}}}, {_metadata: {key: {eq: null, in: null}}}, {_fulltext: {exist: true}}, {_fulltext: {contains: 'Australia'}}, {_fulltext: {eq: 'Article 1'}}, {_metadata: {url: {default: {in: []}}}}];
let comparisons = 0;
for (const auth of ['basic', 'single', 'preview']) for (const type of ['_Content', 'Bench0', 'Bench1']) for (const where of clauses) for (const orderBy of [undefined, {_metadata: {lastModified: 'DESC'}}, {_ranking: 'RELEVANCE', _metadata: {displayName: 'ASC'}}, {_ranking: 'DOC'}]) {
  const args = {where, orderBy, locale: ['all'], limit: 7, variation: {include: 'ALL'}};
  const context = {auth, headers: {'cg-roles': 'Editors'}};
  const now = current.evaluateQuery(stores[0], type, args, context); const before = prior.evaluateQuery(stores[1], type, args, context);
  const wire = result => JSON.stringify({items: result.items, total: result.total, cursor: result.cursor, item: result.item});
  assert.equal(wire(now), wire(before), JSON.stringify({auth, type, args}));
  assert.equal(JSON.stringify(current.facets(now, 'Tags', {limit: 10})), JSON.stringify(prior.facets(before, 'Tags', {limit: 10})));
  assert.equal(JSON.stringify(current.autocomplete(now, 'Heading', {value: 'art'})), JSON.stringify(prior.autocomplete(before, 'Heading', {value: 'art'})));
  assert.equal(JSON.stringify(now.items.map(d => current.highlights(d))), JSON.stringify(before.items.map(d => prior.highlights(d))));
  comparisons++;
}
for (const store of stores) { store.mutate('deployNewAccountVersion'); store.upsert('staged', syntheticDocument(1), {slot: 'new'}); store.mutate('useNewAccountVersion'); }
for (const slot of ['live', 'new']) assert.equal(JSON.stringify(current.evaluateQuery(stores[0], '_Content', {}, {auth: 'basic', slot}).items), JSON.stringify(prior.evaluateQuery(stores[1], '_Content', {}, {auth: 'basic', slot}).items));
for (const store of stores) { store.mutate('useOldAccountVersion'); store.delete('doc-1', {hard: false}); store.delete('doc-2'); }
for (const ids of [[], ['doc-1'], ['KEY-17'], ['doc-2', 'KEY-1', 'KEY-4']]) {
  assert.equal(JSON.stringify(current.evaluateQuery(stores[0], '_Content', {ids}, {auth: 'basic', headers: {'cg-include-deleted': 'true'}}).items), JSON.stringify(prior.evaluateQuery(stores[1], '_Content', {ids}, {auth: 'basic', headers: {'cg-include-deleted': 'true'}}).items));
  comparisons++;
}
stores[0].dispose();
const result = {baseline: resolve(baseline), comparisons, result: 'identical JSON query data, facets, autocomplete and highlights; random correlation IDs excluded'};
console.log(JSON.stringify(result)); await mkdir('perf-results', {recursive: true}); await writeFile('perf-results/compatibility.json', JSON.stringify(result, null, 2) + '\n');
