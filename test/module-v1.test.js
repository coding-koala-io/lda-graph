import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {product} from '../src/product.js';
import {aboutPage} from '../src/about.js';
import {escapeHtml} from '../src/html.js';
import {startServer} from '../src/server.js';
import {tenants, scratch, A, basic, csrf, postForm} from './tenant-helpers.js';
import {quiet} from './helpers.js';

const repo = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, repo), 'utf8');

test('Graph module identity, package and lock metadata use the v1 product', () => {
  const pkg = JSON.parse(read('package.json')); const lock = JSON.parse(read('package-lock.json'));
  assert.deepEqual(product, {key: 'graph', name: 'LDA Local Graph', suite: 'Local Developer Accelerator (LDA), compatible with Optimizely CMS 12 and 13', publisher: 'Coding Koalas Pty Ltd', version: pkg.version, dataVersion: 1, compatibleWith: 'Optimizely Graph'});
  assert.equal(pkg.name, 'lda-graph'); assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/); assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0'); assert.equal(pkg.author, `${product.publisher} (https://codingkoala.io)`);
  assert.equal(pkg.repository, 'github:coding-koala-io/lda-graph'); assert.equal(pkg.homepage, 'https://github.com/coding-koala-io/lda-graph#readme');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.description, `${product.name}: a local Graph service for development, compatible with Optimizely CMS 12 and 13. Part of Local Developer Accelerator. Free and open source (Apache 2.0). Development use only. Not affiliated with or endorsed by Optimizely. Built by Coding Koala.`);
  assert.equal(pkg.bugs, 'https://github.com/coding-koala-io/lda-graph/issues');
  assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name); assert.equal(lock.packages[''].license, pkg.license);
});

function chrome(html, {embedded = false} = {}) {
  assert.match(html, /<title>[^<]*· LDA Local Graph<\/title>/);
  assert.ok(html.includes('LDA Local Graph · Tenants'));
  assert.ok(html.includes('Development use only — not for production.'));
  const banner = /<aside class="development-banner"[^>]*>(.*?)<\/aside>/s.exec(html)[1];
  const footer = /<footer class="product-footer">(.*?)<\/footer>/s.exec(html)[1];
  assert.ok(banner.includes(embedded ? 'Local Developer Accelerator (LDA)' : product.suite));
  assert.ok(!banner.includes('Coding Koala'));
  assert.ok(footer.includes(`LDA Local Graph ${product.version} · ${embedded ? 'Development use only' : 'Apache 2.0'}`));
  assert.ok(footer.includes('href="/about"'));
  if (embedded) {
    assert.doesNotMatch(html, /Coding Koala|Optimizely/);
    for (const path of ['/about/privacy', '/about/licence', '/about/legal']) assert.ok(!footer.includes(`href="${path}"`));
  } else {
    assert.equal((html.match(/Built by\b/g) ?? []).length, 1, 'one builder line per screen');
    assert.equal((html.match(/Not affiliated with or endorsed by Optimizely\./g) ?? []).length, 1, 'one disclaimer per screen');
    assert.doesNotMatch(footer, /Optimizely®|No warranty/);
    for (const path of ['/about/privacy', '/about/licence']) assert.ok(footer.includes(`href="${path}"`));
    assert.ok(!footer.includes('href="/about/legal"'));
  }
}

test('every admin shell has product titles, banner and footer, including GraphiQL and confirmation', async t => {
  const gw = await tenants(t); const base = `/tenants/${A.id}`;
  for (const path of ['/', base, base + '/edit', '/explorer', `/explorer?tenant=${A.id}`, '/graphiql', `/graphiql?tenant=${A.id}`, `/app/graphiql?auth=${A.singleKey}`, '/app/graphiql?auth=missing', '/about', '/about/privacy', '/about/licence', '/about/legal']) {
    const response = await gw.request(path, {auth: null});
    const embedded = path.startsWith('/app/graphiql');
    assert.equal(response.status, path.endsWith('auth=missing') ? 404 : 200, path); chrome(response.data, {embedded});
    // GraphiQL can be shown inside the CMS frame, so its product links open in a new tab; other pages do not.
    for (const href of ['/', '/about']) assert.equal(response.data.includes(`href="${href}" target="_blank" rel="noopener noreferrer"`), embedded, `${path} ${href}`);
  }
  chrome((await gw.request('/content/v2', {auth: null, headers: {Accept: 'text/html'}})).data);
  const detail = (await gw.request(base, {auth: null})).data;
  const confirmation = await postForm(gw, base + '/confirm', {action: 'content', csrf: csrf(detail)});
  assert.equal(confirmation.status, 200); chrome(confirmation.data);
});

test('GraphiQL distinguishes navigation from CMS frames and keeps query and slot selection', async t => {
  const gw = await tenants(t);
  for (const [path, destination, embedded] of [
    [`/graphiql?tenant=${A.id}`, 'document', false],
    [`/graphiql?tenant=${A.id}`, 'iframe', true],
    [`/app/graphiql?auth=${A.singleKey}`, 'document', false],
    [`/app/graphiql?auth=${A.singleKey}`, 'iframe', true],
    [`/app/graphiql?auth=${A.singleKey}`, 'frame', true],
    [`/content/v2?tenant=${A.id}`, 'document', false],
    [`/content/v2?tenant=${A.id}`, 'iframe', true],
  ]) {
    const query = '{ _Content { total } }';
    const htmlQueryEndpoint = path.startsWith('/content/v2');
    const response = await gw.request(path + '&' + new URLSearchParams({slot: 'new', ...(!htmlQueryEndpoint ? {query} : {})}), {auth: null, headers: {Accept: 'text/html', 'Sec-Fetch-Dest': destination}});
    assert.equal(response.status, 200, `${path} ${destination}`); chrome(response.data, {embedded});
    assert.equal(response.headers.get('vary'), 'Sec-Fetch-Dest');
    assert.ok(response.data.includes(`const linkQuery=${htmlQueryEndpoint ? 'undefined' : JSON.stringify(query)}`));
    assert.ok(response.data.includes('"cg-query-new":"true"'));
    if (!embedded) assert.ok(response.data.includes('Built by <a href="https://codingkoala.io" target="_blank" rel="noopener noreferrer">Coding Koala</a>'));
  }
  chrome((await gw.request('/graphiql', {auth: null, headers: {'Sec-Fetch-Dest': 'iframe'}})).data, {embedded: true});
  for (const [destination, embedded] of [['document', false], ['iframe', true]]) {
    const response = await gw.request('/app/graphiql?auth=missing', {auth: null, headers: {'Sec-Fetch-Dest': destination}});
    assert.equal(response.status, 404); chrome(response.data, {embedded});
  }
});

test('about pages render the exact escaped root files with dashboard security rules', async t => {
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  const admin = 'Basic ' + Buffer.from('manager:password').toString('base64');
  for (const [path, file] of [['/about', null], ['/about/privacy', 'PRIVACY.md'], ['/about/licence', 'LICENSE.md'], ['/about/legal', 'LEGAL-NOTICE.md']]) {
    for (const auth of [null, basic(A)]) assert.equal((await gw.request(path, {auth})).status, 401);
    const response = await gw.request(path, {auth: admin}); assert.equal(response.status, 200); chrome(response.data);
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    if (file) assert.ok(response.data.includes(`<pre>${escapeHtml(read(file))}</pre>`));
    else {
      for (const text of [product.name, product.suite, product.version, '<dt>dataVersion</dt><dd>1</dd>', `<dt>Copyright</dt><dd>2026 ${product.publisher} (ACN 668 775 433).</dd>`, '<dt>Licence</dt><dd>Apache License 2.0, development tool, not for production use</dd>', 'Provided as is, without warranty.']) assert.ok(response.data.includes(text), text);
      assert.ok(response.data.includes('<dt>Built by</dt><dd><a href="https://codingkoala.io" target="_blank" rel="noopener noreferrer">Coding Koala</a></dd>'));
      assert.ok(response.data.includes('<dt>Source</dt><dd><a href="https://github.com/coding-koala-io/lda-graph" target="_blank" rel="noopener noreferrer">GitHub</a></dd>'));
      const footer = /<footer class="product-footer">(.*?)<\/footer>/s.exec(response.data)[1];
      assert.doesNotMatch(footer, /Coding Koala|Optimizely/);
    }
    assert.equal((await gw.request(path, {auth: admin, headers: {Origin: 'https://evil.example'}})).status, 403);
  }
});

test('legal files are reread on each request, escaped, and missing files return 404 text', async t => {
  const root = scratch(t); const base = pathToFileURL(root + '/');
  for (const [path, file] of [['/about/privacy', 'PRIVACY.md'], ['/about/licence', 'LICENSE.md'], ['/about/legal', 'LEGAL-NOTICE.md']]) {
    const missing = await aboutPage(path, base); assert.equal(missing.status, 404); assert.ok(missing.html.includes(`${file} not found`));
    for (const value of ['<script>alert("synthetic")</script>&', 'Updated synthetic legal text']) {
      writeFileSync(join(root, file), value);
      const result = await aboutPage(path, base); assert.equal(result.status, 200);
      assert.ok(result.html.includes(`<pre>${escapeHtml(value)}</pre>`));
      assert.ok(!result.html.includes('<script>alert('));
    }
  }
});

test('health always identifies Graph and its versions while keeping tenant diagnostics private and lazy', async t => {
  const gw = await tenants(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'password'});
  const admin = 'Basic ' + Buffer.from('manager:password').toString('base64');
  for (const auth of [null, basic(A), admin]) {
    const result = await gw.request('/health', {auth}); assert.equal(result.status, 200);
    assert.equal(result.data.product, product.key); assert.equal(result.data.version, product.version); assert.equal(result.data.dataVersion, product.dataVersion);
    if (auth === admin) { assert.ok(result.data.tenants); assert.ok(result.data.memory); }
    else assert.deepEqual(Object.keys(result.data).sort(), ['dataVersion', 'product', 'status', 'version']);
    assert.ok([...gw.server.tenants.runtimes.values()].every(runtime => !runtime.store));
  }
});

test('missing dataVersion reads as one, and the first save persists the supported version', async t => {
  const gw = await tenants(t);
  assert.equal(JSON.parse(readFileSync(gw.file, 'utf8')).dataVersion, undefined);
  await gw.server.tenants.edit(entries => entries);
  const data = JSON.parse(readFileSync(gw.file, 'utf8'));
  assert.equal(data.dataVersion, 1); assert.equal(data.tenants.length, 2);
});

test('newer data exits the production entry point with code three before writing or loading stores', t => {
  const root = scratch(t); const file = join(root, 'tenants.json'); const data = JSON.stringify({dataVersion: 2, tenants: [A]});
  writeFileSync(file, data);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {cwd: root, env: {...process.env, HOST: '127.0.0.1', PORT: '0', TENANTS_FILE: file, DATA_DIR: join(root, 'data'), LOG_DIR: join(root, 'logs')}, encoding: 'utf8', timeout: 15000, windowsHide: true});
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stderr.trim(), `Data in ${file} was written by a newer version (dataVersion 2). Upgrade LDA Local Graph or restore a backup.`);
  assert.equal(readFileSync(file, 'utf8'), data); assert.ok(!result.stdout.includes('listening at'));
});

test('a non-numeric or non-positive-integer dataVersion is refused with exit code three and a clear message', async t => {
  const root = scratch(t); const file = join(root, 'tenants.json');
  for (const value of [null, 0, -1, 1.5, '1', 'abc', true, [], {}]) {
    const data = JSON.stringify({dataVersion: value, tenants: [A]}); writeFileSync(file, data);
    await assert.rejects(startServer({port: 0, host: '127.0.0.1', tenantsFile: file, dataDir: ':memory:', logDir: ':memory:', logger: quiet}),
      error => error.exitCode === 3 && error.message === `Data in ${file} has an invalid dataVersion (${JSON.stringify(value)}).`, JSON.stringify(value));
    assert.equal(readFileSync(file, 'utf8'), data);
  }
  writeFileSync(file, JSON.stringify({dataVersion: 'abc', tenants: [A]}));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {cwd: root, env: {...process.env, HOST: '127.0.0.1', PORT: '0', TENANTS_FILE: file, DATA_DIR: join(root, 'data'), LOG_DIR: join(root, 'logs')}, encoding: 'utf8', timeout: 15000, windowsHide: true});
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stderr.trim(), `Data in ${file} has an invalid dataVersion ("abc").`);
});

test('startup identifies the product and warns only on non-loopback binds', async t => {
  const root = scratch(t);
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const messages = []; const warnings = [];
    const server = await startServer({port: 0, host, tenantsFile: join(root, 'absent.json'), dataDir: ':memory:', logDir: ':memory:', adminUser: 'manager', adminPassword: 'password', logger: {...quiet, log: value => messages.push(value), warn: value => warnings.push(value)}});
    try {
      assert.ok(messages.includes(`${product.name} ${product.version} listening at http://${host}:${server.address().port} (development use only)`));
      assert.equal(warnings.length, host === '127.0.0.1' ? 0 : 1);
      if (warnings.length) assert.match(warnings[0], /development only\.\nAnyone on the network can reach.*\nNever point a shared or production site at it\./);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('public legal documents, README installation and release guidance use final Graph terms', () => {
  const files = ['LICENSE.md', 'LEGAL-NOTICE.md', 'PRIVACY.md', 'CLEAN-ROOM.md', 'TAKEDOWN-AND-CONTACT.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
  for (const file of files) {
    const text = read(file); assert.ok(text.trim());
    assert.doesNotMatch(text, /\[LAWYER REVIEW|\[Product|\{\{|PolyForm|commercial use requires permission/i);
  }
  for (const file of [...files, 'README.md', 'SECURITY.md']) assert.doesNotMatch(read(file), /lawyer review|\[brackets\]|ADDRESS\]/i, file);
  // Release metadata is checked by format, so a version bump does not break the tests.
  const pkg = JSON.parse(read('package.json')), license = read('LICENSE.md');
  for (const text of ['Apache License', 'Version 2.0, January 2004', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION', 'END OF TERMS AND CONDITIONS']) assert.ok(license.includes(text), text);
  assert.doesNotMatch(license, /Business Source License|Change Date/);
  for (const text of ['Local Developer Accelerator (LDA) Local Graph', 'Copyright 2026 Coding Koalas Pty Ltd (ACN 668 775 433)', 'compatible with Optimizely CMS 12 and 13', 'Not affiliated with or endorsed by Optimizely.']) assert.ok(read('NOTICE').includes(text), text);
  const privacy = read('PRIVACY.md');
  for (const text of ['WinSW', 'cdn.jsdelivr.net', 'LDA CLI', 'privacy@codingkoala.io']) assert.ok(privacy.includes(text));
  assert.match(privacy, /Last updated: \d{4}-\d{2}-\d{2}\./);
  assert.doesNotMatch(privacy, /Ollama|Anthropic|visitor IDs|LLM API key/);
  const readme = read('README.md'); assert.ok(readme.startsWith('> **Development and research use only. Not designed or tested for production use.**'));
  for (const text of ['# LDA Local Graph', '## 2-minute quick start', 'releases/latest/download/install.ps1', 'lda install graph', '## Why developers use it', '## Getting started from source', 'Compatible with Optimizely CMS 12 and 13', 'not for production use', 'Apache License 2.0']) assert.ok(readme.toLowerCase().includes(text.toLowerCase()), text);
  for (const text of ['git flow release start X.Y.Z', 'npm test', 'git flow release finish X.Y.Z', 'git push origin main develop --tags', 'not changed for a release']) assert.ok(read('docs/RELEASING.md').includes(text));
  assert.doesNotMatch(readme, /\.tgz|Change Date|Business Source License/);
  const heading = read('CHANGELOG.md').split(/\r?\n/).find(line => line.startsWith(`## [${pkg.version}] - `));
  assert.ok(heading && /^## \[[^\]]+\] - (unreleased|\d{4}-\d{2}-\d{2})$/.test(heading), `CHANGELOG has a section for ${pkg.version} that is unreleased or dated`);
});
