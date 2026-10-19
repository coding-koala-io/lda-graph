import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/store.js';
import {syntheticDocument} from './bench-query.mjs';
const repo = resolve(import.meta.dirname, '..');
if (process.env.PERF_SHUTDOWN_CHILD === 'true') {
  const stores = []; const changed = Store.prototype.changed; const flush = Store.prototype.flush;
  Store.prototype.changed = function() { changed.call(this); clearTimeout(this.timer); this.timer = null; if (!stores.includes(this)) stores.push(this); };
  Store.prototype.flush = async function(options) { const start = performance.now(); const savedBefore = this.savedRevision; await flush.call(this, options); console.log('PERF_FLUSH ' + JSON.stringify({ms: performance.now() - start, savedBefore, savedAfter: this.savedRevision, docs: Object.keys(this.state.docs).length})); };
  process.on('message', async message => {
    if (message.clean) { for (const store of stores) await store.flush(); process.send({clean: true}); return; }
    process.emit(message.signal); process.disconnect();
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const n = Number(process.argv[2] ?? 60000); const results = [];
  for (const [signal, clean] of [['SIGINT', false], ['SIGTERM', false], ['SIGBREAK', false], ['SIGTERM', true]]) {
    const root = await mkdtemp(join(tmpdir(), 'graph-shutdown-bench-'));
    let child;
    try {
      child = spawn(process.execPath, ['--import', import.meta.url, join(repo, 'src/server.js')], {cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {...process.env, PERF_SHUTDOWN_CHILD: 'true', PORT: '0', HOST: '127.0.0.1', DATA_DIR: root, LOG_DIR: ':memory:', TENANTS_FILE: join(root, 'missing.json'), GRAPH_APP_KEY: '', GRAPH_SECRET: '', GRAPH_SINGLE_KEY: '', MEMORY_RECYCLE_MB: '0'}});
      let output = ''; let errors = ''; let resolveReady;
      const ready = new Promise(r => resolveReady = r); child.stdout.on('data', bytes => { output += bytes; const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) resolveReady(match[1]); }); child.stderr.on('data', bytes => errors += bytes);
      const exited = once(child, 'exit'); const base = await Promise.race([ready, exited.then(() => {throw new Error(errors || output);})]);
      const auth = 'Basic ' + Buffer.from('bench:bench').toString('base64');
      for (let start = 0; start < n; start += 500) {
        const lines = [];
        for (let i = start; i < Math.min(n, start + 500); i++) lines.push(JSON.stringify({index: {_id: 'doc-' + i}}), JSON.stringify(syntheticDocument(i)));
        const response = await fetch(base + '/_stream', {method: 'POST', headers: {Authorization: auth}, body: lines.join('\n') + '\n'}); if (!response.ok) throw new Error(await response.text()); await response.text();
      }
      if (clean) { const cleaned = once(child, 'message'); child.send({clean: true}); await cleaned; }
      const start = performance.now();
      // Windows child.kill() terminates immediately; use the same process signal events as service tests.
      if (process.platform === 'win32' || signal === 'SIGBREAK') child.send({signal}); else { child.disconnect(); child.kill(signal); }
      const [code] = await exited; if (code !== 0) throw new Error(errors + output);
      const shutdownMs = performance.now() - start;
      const flushes = [...output.matchAll(/PERF_FLUSH (.+)/g)].map(match => JSON.parse(match[1]));
      const lines = (await readFile(join(root, 'default/store.ndjson'), 'utf8')).trim().split('\n');
      if (JSON.parse(lines.at(-1)).record !== 'end' || lines.filter(line => line.startsWith('{"record":"docs"')).length !== n) throw new Error('Incomplete shutdown snapshot');
      results.push({signal, clean, shutdownMs, flush: flushes.at(-1), delivery: process.platform === 'win32' || signal === 'SIGBREAK' ? 'IPC process signal event' : 'OS signal'});
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
      const inside = relative(resolve(tmpdir()), resolve(root)); if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe benchmark cleanup');
      await rm(root, {recursive: true, force: true});
    }
  }
  await mkdir('perf-results', {recursive: true});
  await writeFile('perf-results/shutdown.json', JSON.stringify({n, results}, null, 2) + '\n');
}
