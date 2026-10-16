import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, mkdtempSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname, relative, isAbsolute, resolve, posix} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {releaseMetadata, releaseFiles, archiveTool, gitCommit} from '../scripts/build-release.mjs';
import {releaseNotes} from '../scripts/release-notes.mjs';
import {product} from '../src/product.js';

const repo = fileURLToPath(new URL('../', import.meta.url));

/** Relative .md links (anchors and web/mail links ignored) in README.md and LEGAL-NOTICE.md under root. */
function relativeDocLinks(root) {
  const links = [];
  for (const file of ['README.md', 'LEGAL-NOTICE.md']) {
    for (const [, target] of readFileSync(join(root, file), 'utf8').matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && target.endsWith('.md')) links.push({file, target: posix.normalize(posix.join(posix.dirname(file), target))});
    }
  }
  return links;
}

test('release metadata hashes exact archive bytes and records all manifest fields without git', () => {
  const bytes = Buffer.from('synthetic archive bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = releaseMetadata(bytes, {commit: 'synthetic-commit', builtAt: '2026-10-16T00:00:00.000Z'});
  assert.deepEqual(result.manifest, {module: 'graph', product: 'LDA Local Graph', version: product.version, minNode: '24', dataVersion: 1, file: `lda-graph-${product.version}.zip`, sha256, size: bytes.length, commit: 'synthetic-commit', builtAt: '2026-10-16T00:00:00.000Z'});
  assert.equal(result.sums, `${sha256}  lda-graph-${product.version}.zip\n`);
  assert.equal(releaseMetadata(bytes).manifest.commit, null);
  assert.notEqual(releaseMetadata(Buffer.from('different')).manifest.sha256, sha256);
});

test('release notes select only the requested version and fail when absent, unreleased or undated', t => {
  const changelog = '# Changelog\n\n## [2.0.0] - 2027-01-02\n\nNew\n\n## [1.0.0] - 2026-10-16\n\nOriginal\n\n## [0.9.0] - unreleased\n\nDraft\n\n## [0.8.0]\n\nUndated\n\n## [0.7.0] - soon\n\nBad\n';
  assert.equal(releaseNotes(changelog, '2.0.0'), '## [2.0.0] - 2027-01-02\n\nNew\n');
  assert.equal(releaseNotes(changelog, '1.0.0'), '## [1.0.0] - 2026-10-16\n\nOriginal\n');
  assert.throws(() => releaseNotes(changelog, '3.0.0'), /Missing CHANGELOG/);
  for (const version of ['0.9.0', '0.8.0', '0.7.0']) assert.throws(() => releaseNotes(changelog, version), error => error.message.startsWith(`CHANGELOG section for ${version} is not dated`) && error.message.includes('YYYY-MM-DD'));
  // The command fails with exit code 1 and a clear message, and writes no notes file.
  const folder = mkdtempSync(join(tmpdir(), 'graph-release-notes-'));
  t.after(() => rmSync(folder, {recursive: true, force: true}));
  writeFileSync(join(folder, 'CHANGELOG.md'), `# Changelog\n\n## [${product.version}] - unreleased\n\nPending\n`);
  const failed = spawnSync(process.execPath, [join(repo, 'scripts/release-notes.mjs')], {cwd: folder, encoding: 'utf8', windowsHide: true});
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.stderr.trim(), `CHANGELOG section for ${product.version} is not dated ("## [${product.version}] - unreleased"). Change its heading to "## [${product.version}] - YYYY-MM-DD" before releasing.`);
  assert.ok(!existsSync(join(folder, 'release-notes.md')));
  writeFileSync(join(folder, 'CHANGELOG.md'), `# Changelog\n\n## [${product.version}] - 2026-10-16\n\nShipped\n`);
  const passed = spawnSync(process.execPath, [join(repo, 'scripts/release-notes.mjs')], {cwd: folder, encoding: 'utf8', windowsHide: true});
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(readFileSync(join(folder, 'release-notes.md'), 'utf8'), `## [${product.version}] - 2026-10-16\n\nShipped\n`);
});

test('release commit comes from LDA_RELEASE_COMMIT, otherwise git rev-parse HEAD, otherwise null', t => {
  const saved = process.env.LDA_RELEASE_COMMIT;
  t.after(() => { if (saved === undefined) delete process.env.LDA_RELEASE_COMMIT; else process.env.LDA_RELEASE_COMMIT = saved; });
  process.env.LDA_RELEASE_COMMIT = 'a'.repeat(40); assert.equal(gitCommit(), 'a'.repeat(40));
  process.env.LDA_RELEASE_COMMIT = ''; assert.equal(gitCommit(), null);
  delete process.env.LDA_RELEASE_COMMIT;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8', windowsHide: true});
  assert.equal(gitCommit(), head.status === 0 ? head.stdout.trim() : null);
  const outside = mkdtempSync(join(tmpdir(), 'graph-no-git-'));
  t.after(() => rmSync(outside, {recursive: true, force: true}));
  if (spawnSync('git', ['rev-parse', 'HEAD'], {cwd: outside, windowsHide: true}).status !== 0) assert.equal(gitCommit(outside), null);
  const build = readFileSync(join(repo, 'scripts/build-release.mjs'), 'utf8');
  assert.ok(!build.includes('LDA_BUILD_COMMIT') && !build.includes('GITHUB_SHA'));
  assert.ok(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8').includes('LDA_RELEASE_COMMIT: ${{ github.sha }}'));
});

test('release files include every document that README.md and LEGAL-NOTICE.md link to', () => {
  for (const file of ['TAKEDOWN-AND-CONTACT.md', 'CONTRIBUTING.md']) assert.ok(releaseFiles.includes(file), file);
  const links = relativeDocLinks(repo);
  assert.ok(links.some(link => link.target === 'TAKEDOWN-AND-CONTACT.md'));
  for (const {file, target} of links) {
    assert.ok(releaseFiles.some(entry => target === entry || target.startsWith(entry + '/')), `${file} links to ${target}, which is not packaged`);
  }
});

test('Windows workflows test supported branches, validate tags, build and publish all release artifacts', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  for (const text of ['develop', 'main', 'feature/**', 'release/**', 'hotfix/**', 'pull_request:', 'windows-latest', 'actions/setup-node@v4', "node-version: '24'", 'npm ci', 'npm test', 'contents: read']) assert.ok(ci.includes(text), text);
  assert.ok(!ci.includes('npm install'), 'CI installs exactly the committed lockfile');
  const release = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
  for (const text of ["tags: ['v*']", 'contents: write', 'windows-latest', 'npm test', 'npm run release:build', '$env:GITHUB_REF_NAME -cne "v$version"', 'scripts/release-notes.mjs', 'gh release create', '"dist/lda-graph-$version.zip" dist/SHA256SUMS dist/manifest.json', '--title "LDA Local Graph $version"', '--notes-file release-notes.md', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}']) assert.ok(release.includes(text), text);
  assert.ok(readFileSync(join(repo, '.gitignore'), 'utf8').split(/\r?\n/).includes('dist/'));
});

test('release build ZIP starts from an empty folder and serves the correct health metadata', {timeout: 240000}, async t => {
  // Keep the standalone entry point in the workspace: this seat cannot traverse AppData.
  const dist = join(repo, 'dist'); mkdirSync(dist, {recursive: true});
  const root = mkdtempSync(join(dist, 'smoke-')); const unpacked = join(root, 'unpacked release'); mkdirSync(unpacked);
  let child; let exited; let build; let buildExit;
  t.after(async () => {
    for (const [process, exit] of [[child, exited], [build, buildExit]]) {
      if (process && process.exitCode === null && process.signalCode === null) { process.kill(); await exit; }
    }
    const inside = relative(dist, root); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    rmSync(root, {recursive: true, force: true});
  });
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  build = spawn(process.execPath, [npmCli, 'run', 'release:build'], {cwd: repo, env: {...process.env, LDA_PACKAGING_SMOKE: 'true'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; build.stdout.on('data', chunk => { output += chunk; }); build.stderr.on('data', chunk => { output += chunk; });
  buildExit = once(build, 'exit');
  const [code] = await buildExit; assert.equal(code, 0, output);
  if (output.includes('SKIP npm ci only:')) t.diagnostic('npm registry unavailable: skipped npm ci only; archive and runtime smoke checks still run.');
  const manifest = JSON.parse(readFileSync(join(repo, 'dist/manifest.json'), 'utf8'));
  const zip = readFileSync(join(repo, 'dist', manifest.file));
  assert.deepEqual(zip.subarray(0, 2), Buffer.from('PK'));
  assert.equal(manifest.sha256, createHash('sha256').update(zip).digest('hex')); assert.equal(manifest.size, zip.length);
  assert.equal(readFileSync(join(repo, 'dist/SHA256SUMS'), 'utf8'), `${manifest.sha256}  ${manifest.file}\n`);
  assert.equal(manifest.module, product.key); assert.equal(manifest.product, product.name); assert.equal(manifest.version, product.version); assert.equal(manifest.dataVersion, 1); assert.equal(manifest.minNode, '24');
  assert.ok(Number.isFinite(Date.parse(manifest.builtAt)));
  const extract = spawnSync(archiveTool, ['-xf', join(repo, 'dist', manifest.file), '-C', unpacked], {encoding: 'utf8', windowsHide: true});
  assert.equal(extract.status, 0, extract.error?.message ?? extract.stderr);
  for (const file of [...releaseFiles, 'package-lock.json', 'node_modules/graphql/package.json']) assert.ok(existsSync(join(unpacked, file)), file);
  for (const file of ['test', '.git', 'data', 'logs', 'tenants.json']) assert.ok(!existsSync(join(unpacked, file)), file);
  assert.deepEqual(readdirSync(join(unpacked, 'docs')).sort(), ['RELEASING.md', 'protocol.md']);
  for (const {file, target} of relativeDocLinks(unpacked)) {
    const inside = relative(unpacked, resolve(unpacked, target));
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && existsSync(join(unpacked, target)), `packaged ${file} links to missing ${target}`);
  }
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  for (const [path, dependency] of Object.entries(lock.packages)) if (dependency.dev) assert.ok(!existsSync(join(unpacked, path)), path);
  assert.ok(!readdirSync(unpacked).some(name => name.endsWith('-research')));
  child = spawn(process.execPath, ['src/server.js'], {cwd: unpacked, env: {...process.env, PORT: '0', HOST: '127.0.0.1', TENANTS_FILE: join(unpacked, 'tenants.json'), DATA_DIR: join(unpacked, 'data'), LOG_DIR: join(unpacked, 'logs'), ADMIN_USER: '', ADMIN_PASSWORD: '', GRAPH_APP_KEY: '', GRAPH_SECRET: '', GRAPH_SINGLE_KEY: ''}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  exited = once(child, 'exit');
  const deadline = Date.now() + 15000; let match;
  while (!(match = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout))) {
    assert.equal(child.exitCode, null, stdout + stderr); assert.ok(Date.now() < deadline, stdout + stderr || 'Packaged server did not start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const response = await fetch(`http://127.0.0.1:${match[1]}/health`);
  assert.equal(response.status, 200); const health = await response.json();
  assert.equal(health.product, 'graph'); assert.equal(health.version, product.version); assert.equal(health.dataVersion, 1); assert.equal(health.status, 'ok');
  const legal = await fetch(`http://127.0.0.1:${match[1]}/about/licence`); assert.equal(legal.status, 200); assert.ok((await legal.text()).includes('Business Source License 1.1'));
});
