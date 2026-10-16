import {cp, mkdir, readFile, writeFile, stat, rm, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve, join, dirname, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {product} from '../src/product.js';

const repo = resolve(import.meta.dirname, '..');
export const archiveTool = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
export const releaseFiles = ['src', 'scripts/service.ps1', 'scripts/service-xml.js', 'package.json', 'LICENSE.md', 'README.md', 'LEGAL-NOTICE.md', 'PRIVACY.md', 'CHANGELOG.md', 'CLEAN-ROOM.md', 'TAKEDOWN-AND-CONTACT.md', 'CONTRIBUTING.md', 'docs/protocol.md', 'docs/RELEASING.md'];

export function releaseMetadata(bytes, {commit = null, builtAt = new Date().toISOString()} = {}) {
  const file = `lda-${product.key}-${product.version}.zip`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {manifest: {module: product.key, product: product.name, version: product.version, minNode: '24', dataVersion: product.dataVersion, file, sha256, size: bytes.length, commit, builtAt}, sums: `${sha256}  ${file}\n`};
}

/** Release commit: LDA_RELEASE_COMMIT when set (CI passes the tagged commit), otherwise git rev-parse HEAD, otherwise null. */
export function gitCommit(root = repo) {
  if ('LDA_RELEASE_COMMIT' in process.env) return process.env.LDA_RELEASE_COMMIT && process.env.LDA_RELEASE_COMMIT !== 'none' ? process.env.LDA_RELEASE_COMMIT : null;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', windowsHide: true});
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export async function registryAvailable() {
  try {
    const response = await fetch('https://registry.npmjs.org/graphql', {signal: AbortSignal.timeout(5000)});
    await response.body?.cancel();
    if (!response.ok) throw new Error(`npm registry responded ${response.status}`);
    return true;
  } catch (error) {
    // HTTP errors are reachable registries, and must not bypass npm ci.
    if (error.message.startsWith('npm registry responded')) throw error;
    return false;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

export async function buildRelease({offlineSmoke = false, outputDir = join(repo, 'dist')} = {}) {
  const dist = resolve(outputDir); const stage = join(dist, 'stage');
  // Never recursively clear a computed directory outside this build's output root.
  const inside = relative(dist, stage);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe stage path');
  await rm(stage, {recursive: true, force: true}); await mkdir(stage, {recursive: true});
  for (const file of releaseFiles) {
    await mkdir(dirname(join(stage, file)), {recursive: true});
    await cp(join(repo, file), join(stage, file), {recursive: true});
  }
  let lock;
  try { lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lock) await cp(join(repo, 'package-lock.json'), join(stage, 'package-lock.json'));
  const pkg = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length) {
    if (offlineSmoke && !await registryAvailable()) {
      console.log('SKIP npm ci only: npm registry unavailable; packaging smoke uses installed runtime dependencies.');
      if (!lock?.packages) throw new Error('Offline packaging smoke requires a lockfile');
      for (const [path, dependency] of Object.entries(lock.packages)) {
        if (!path || dependency.dev || dependency.devOptional) continue;
        if (!path.startsWith('node_modules/') || path.split('/').includes('..')) throw new Error('Unsafe dependency path');
        try { await access(join(repo, path)); }
        catch (error) { if (dependency.optional && error.code === 'ENOENT') continue; throw error; }
        await mkdir(dirname(join(stage, path)), {recursive: true});
        await cp(join(repo, path), join(stage, path), {recursive: true});
      }
    } else {
      const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    }
  }
  const file = `lda-${product.key}-${product.version}.zip`; const archive = join(dist, file);
  await rm(archive, {force: true});
  if (process.platform === 'win32') run(archiveTool, ['-a', '-c', '-f', archive, '-C', stage, '.'], repo);
  else run('zip', ['-r', archive, '.'], stage);
  const {manifest, sums} = releaseMetadata(await readFile(archive), {commit: gitCommit()});
  await writeFile(join(dist, 'SHA256SUMS'), sums);
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if ((await stat(archive)).size !== manifest.size) throw new Error('Archive size changed during packaging');
  console.log(`Built ${archive}`); return {dist, stage, archive, manifest};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await buildRelease({offlineSmoke: process.env.LDA_PACKAGING_SMOKE === 'true'}); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
