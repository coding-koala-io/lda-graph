import {spawn} from 'node:child_process';
import {resolve, join} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {effectiveModel} from '../src/model.js';
import {pathToFileURL} from 'node:url';

export function syntheticDocument(i) {
  return {__typename: `Bench${i % 20}`, _metadata: {key: `key-${i}`, types: [`Bench${i % 20}`, '_Content', '_Item'], locale: i % 2 ? 'sv' : 'en', status: 'Published', displayName: `Article ${i}`, lastModified: new Date(1700000000000 + i * 1000).toISOString(), url: {default: `/articles/${i}`, hierarchical: `/site/articles/${i}`, internal: `internal-${i}`, base: `/base/${i}`}}, _rbac: ['r:Everyone:Read'],
    Heading___searchable: `Article ${i} about ${i % 3 ? 'gardening' : 'koalas'}`, Tags: ['News', `Group${i % 7}`],
    MainBody: {__typename: 'SearchableRichText', html: `<p>Explore <strong>${i % 3 ? 'gardening' : 'koalas'}</strong> in Australia &amp; learn about nature.</p><ul><li>Local stories number ${i}</li><li>Rich text with café and trees.</li></ul>`}};
}
export const benchModel = () => effectiveModel({languages: ['en', 'sv'], contentTypes: Object.fromEntries(Array.from({length: 20}, (_, i) => [`Bench${i}`, {contentType: ['_Content'], properties: {Heading: {type: 'String', searchable: true}, MainBody: {type: 'SearchableRichText'}, Tags: {type: '[String]'}}}]))});
export function workloads(n) {
  const i = Math.floor(n / 2);
  const fields = 'total cursor items {_id _score _metadata {key locale lastModified}}';
  return {
    key: `{_Content(locale:ALL where:{_metadata:{key:{eq:"key-${i}"}}}){${fields}}}`,
    url: `{_Content(locale:ALL where:{_metadata:{url:{default:{eq:"/articles/${i}"}}}}){${fields}}}`,
    typed: `{Bench0(locale:ALL limit:50 orderBy:{_metadata:{lastModified:DESC}}){${fields}}}`,
    facets: `{_Content(locale:ALL limit:0){total facets{_metadata{status(limit:10){name count}}}}}`,
    fulltext: `{_Content(locale:ALL where:{_fulltext:{match:"koala"}} limit:50){${fields}}}`,
    cms: `{_Content(locale:ALL where:{_fulltext:{match:"koala"}} orderBy:{_ranking:RELEVANCE,_metadata:{displayName:ASC}} limit:50){${fields}}}`,
  };
}
export async function runBenchmark({root = resolve(import.meta.dirname, '..'), n = 60000, samples = 12, rounds = 4, output} = {}) {
  root = resolve(root);
  const child = spawn(process.execPath, ['--expose-gc', join(root, 'src/server.js')], {cwd: root, windowsHide: true, env: {...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: ':memory:', LOG_DIR: ':memory:', TENANTS_FILE: join(root, '__benchmark_missing_tenants__.json'), GRAPH_APP_KEY: '', GRAPH_SECRET: '', GRAPH_SINGLE_KEY: '', ADMIN_USER: '', ADMIN_PASSWORD: '', MEMORY_RECYCLE_MB: '0'}, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; let stdout = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-20000); });
  let base;
  try {
    base = await new Promise((resolveBase, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timed out: ' + stderr)), 20000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
      child.stdout.on('data', data => { stdout = (stdout + data).slice(-20000); const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (match) { clearTimeout(timeout); resolveBase(match[1]); } });
    });
    const auth = 'Basic ' + Buffer.from('bench:bench').toString('base64');
    const request = async (path, body) => {
      const response = await fetch(base + path, {method: 'POST', headers: {Authorization: auth, 'Content-Type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body)});
      const value = await response.json(); if (!response.ok || value.errors) throw new Error(JSON.stringify(value)); return value;
    };
    await fetch(base + '/api/content/v3/types', {method: 'PUT', headers: {Authorization: auth}, body: JSON.stringify(benchModel())}).then(async r => {if (!r.ok) throw new Error(await r.text());});
    for (let start = 0; start < n; start += 500) {
      const lines = [];
      for (let i = start; i < Math.min(n, start + 500); i++) lines.push(JSON.stringify({index: {_id: `doc-${i}`}}), JSON.stringify(syntheticDocument(i)));
      const journal = await request('/_stream', lines.join('\n') + '\n');
      const pushed = await fetch(base + '/journal/stream/' + journal.journalId, {headers: {Authorization: auth}}).then(r => r.json());
      if (pushed.errors) throw new Error('Seed failed: ' + JSON.stringify(pushed));
    }
    const result = {root, n, samples, concurrentSamples: 8 * rounds, node: process.version, at: new Date().toISOString(), rows: {}, hashes: {}};
    const percentile = (values, p) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    for (const [name, query] of Object.entries(workloads(n))) {
      let payload;
      const run = async () => { const start = performance.now(); payload = await request('/content/v2?cache=false', {query}); return performance.now() - start; };
      for (let i = 0; i < 3; i++) await run();
      const idle = []; for (let i = 0; i < samples; i++) idle.push(await run());
      const concurrent = [];
      for (let i = 0; i < rounds; i++) concurrent.push(...await Promise.all(Array.from({length: 8}, run)));
      result.rows[name] = {idle: {p50: percentile(idle, .5), p95: percentile(idle, .95)}, concurrent: {p50: percentile(concurrent, .5), p95: percentile(concurrent, .95)}};
      // Correlation IDs are random per request in both versions; compare the complete data payload.
      result.hashes[name] = createHash('sha256').update(JSON.stringify(payload.data)).digest('hex');
      console.log(name, JSON.stringify(result.rows[name]));
    }
    if (output) { await mkdir(resolve(output, '..'), {recursive: true}); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
    return result;
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolveExit => child.once('exit', resolveExit)); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  await runBenchmark({root: arg('--root'), n: Number(arg('--docs') ?? 60000), samples: Number(arg('--samples') ?? 12), rounds: Number(arg('--rounds') ?? 4), output: arg('--output')});
}
