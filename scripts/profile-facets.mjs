// Profile the exact benchmark GraphQL selection, excluding seed/warmup samples
// from analysis using the monotonic timestamps in the adjacent phase JSON.
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';
import {syntheticDocument, benchModel, workloads} from './bench-query.mjs';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(arg('--root') ?? '.');
const output = arg('--output') ?? 'perf-results/facets.phase.json';
const {Store} = await import(pathToFileURL(join(root, 'src/store.js')));
const {buildSchema} = await import(pathToFileURL(join(root, 'src/schema.js')));
const {graphql} = await import(pathToFileURL(join(root, 'node_modules/graphql/index.js')));
const store = new Store({dataDir: ':memory:', logger: {log() {}, error() {}}});
const model = benchModel();
for (let i = 0; i < 60000; i++) store.upsert(`doc-${i}`, syntheticDocument(i));
const schema = buildSchema(model, store);
const run = async () => {
  const result = await graphql({schema, source: workloads(60000).facets, contextValue: {auth: 'basic'}});
  if (result.errors) throw result.errors[0];
  return result.data;
};
for (let i = 0; i < 3; i++) await run();
const start = Number(process.hrtime.bigint() / 1000n);
let data;
for (let i = 0; i < 40; i++) data = await run();
const end = Number(process.hrtime.bigint() / 1000n);
await mkdir(dirname(resolve(output)), {recursive: true});
await writeFile(output, JSON.stringify({root, start, end, iterations: 40, ms: (end - start) / 1000, data}, null, 2));
store.dispose?.();
console.log(JSON.stringify({root, ms: (end - start) / 1000, data}));
