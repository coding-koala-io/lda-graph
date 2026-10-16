import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {generateServiceXml, runtimePaths, initializeTenantFile, DEFAULT_RUNTIME_ROOT, WRAPPER_URL} from '../scripts/service-xml.js';
import {validateTenants} from '../src/tenants.js';
import {localAuthorities} from '../src/server.js';
import {quiet} from './helpers.js';
import {document} from './fixtures.js';

const repo = resolve(import.meta.dirname, '..');
import {hasPowerShell, runPowerShell, canonicalPath} from './powershell.js';
function scratch(t) {
  const folder = mkdtempSync(join(tmpdir(), 'graph-service-test-'));
  t.after(() => {
    const inside = relative(resolve(tmpdir()), resolve(folder));
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    rmSync(folder, {recursive: true, force: true});
  });
  return folder;
}
const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const element = (source, name) => decode(new RegExp(`<${name}>(.*?)</${name}>`).exec(source)[1]);

test('port 80 authorities accept implicit and explicit HTTP ports without allowing other hosts or ports', () => {
  for (const hostname of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    const authorities = localAuthorities(hostname, 80);
    for (const name of ['localhost', '127.0.0.1', ...(hostname.includes(':') ? ['[::1]'] : [])]) {
      assert.ok(authorities.has(name)); assert.ok(authorities.has(`${name}:80`));
      assert.ok(authorities.has(new URL(`http://${name}:80`).host), 'same-origin URL normalizes away port 80');
      assert.ok(!authorities.has(`${name}:8082`));
    }
    assert.ok(!authorities.has('attacker.example')); assert.ok(!authorities.has('localhost.attacker.example:80'));
  }
  const nondefault = localAuthorities('127.0.0.1', 19082);
  assert.ok(nondefault.has('localhost:19082')); assert.ok(!nondefault.has('localhost')); assert.ok(!nondefault.has('localhost:80'));
});

test('service XML: default runtime, absolute paths, quoted argument, escaped XML and all WinSW settings', () => {
  const defaults = runtimePaths();
  assert.equal(defaults.root, DEFAULT_RUNTIME_ROOT);
  assert.equal(defaults.tenantsFile, 'C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\Graph\\tenants.json');
  assert.equal(defaults.wrapper, 'C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\Graph\\service\\LdaGraph.exe');
  assert.equal(WRAPPER_URL, 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe');
  const options = {nodePath: 'C:\\Node & tools\\node.exe', repoRoot: "D:\\CMS & team's <repo>", runtimeRoot: "C:\\Runtime & team's <files>"};
  const result = generateServiceXml(options);
  assert.equal(element(result, 'executable'), options.nodePath);
  assert.equal(element(result, 'workingdirectory'), options.repoRoot);
  assert.equal(element(result, 'arguments'), `--max-old-space-size=8192 "${options.repoRoot}\\src\\server.js"`);
  assert.ok(result.includes('&amp;')); assert.ok(result.includes('&apos;')); assert.ok(result.includes('&lt;')); assert.ok(result.includes('&quot;'));
  const env = Object.fromEntries([...result.matchAll(/<env name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
  assert.deepEqual(env, {PORT: '8082', HOST: '127.0.0.1', TENANTS_FILE: options.runtimeRoot + '\\tenants.json', DATA_DIR: options.runtimeRoot + '\\data', LOG_DIR: options.runtimeRoot + '\\logs'});
  for (const [name, value] of Object.entries({id: 'LdaGraph', name: 'Local Developer Accelerator — Graph (development only)', startmode: 'Automatic', delayedAutoStart: 'true', resetfailure: '1 hour', stoptimeout: '15 sec', sizeThreshold: '10240', keepFiles: '5', domain: 'NT AUTHORITY', user: 'LocalService', logpath: options.runtimeRoot + '\\service\\logs'})) assert.equal(element(result, name), value);
  assert.equal((result.match(/<onfailure action="restart" delay="10 sec" \/>/g) ?? []).length, 3);
  assert.match(result, /<log mode="roll-by-size">/);
  assert.match(result, /<description>.+<\/description>/);
  const custom = generateServiceXml({...options, port: 19082, host: 'localhost', maxMemoryMB: 16384});
  assert.equal(element(custom, 'arguments'), `--max-old-space-size=16384 "${options.repoRoot}\\src\\server.js"`);
  assert.match(custom, /name="PORT" value="19082"/); assert.match(custom, /name="HOST" value="localhost"/);
});

test('service XML rejects relative paths, invalid ports and WinSW environment expansion in paths', () => {
  const options = {nodePath: 'C:\\Node\\node.exe', repoRoot: 'D:\\repo'};
  for (const port of [0, -1, 65536, 1.5, 'bad']) assert.throws(() => generateServiceXml({...options, port}), /Port/);
  for (const maxMemoryMB of [0, 1023, 65537, 8192.5, 'bad']) assert.throws(() => generateServiceXml({...options, maxMemoryMB}), /MaxMemoryMB/);
  for (const maxMemoryMB of [1024, 65536]) assert.match(generateServiceXml({...options, maxMemoryMB}), new RegExp(`--max-old-space-size=${maxMemoryMB} `));
  for (const key of ['nodePath', 'repoRoot', 'runtimeRoot']) {
    assert.throws(() => generateServiceXml({...options, [key]: 'relative'}), /absolute/);
    assert.throws(() => generateServiceXml({...options, [key]: 'C:\\path%TEMP%'}), /expansion/);
    assert.throws(() => generateServiceXml({...options, [key]: 'C:\\path\ninvalid'}), /control/);
  }
});

test('service initialization generates dashboard-compatible Default keys, snippet and preserves existing tenants/data/logs', t => {
  const root = scratch(t); const runtime = join(root, 'runtime');
  const snippet = initializeTenantFile(runtime, 19082);
  const config = JSON.parse(readFileSync(join(runtime, 'tenants.json'), 'utf8'));
  const [tenant] = validateTenants(config, quiet);
  assert.equal(tenant.id, 'default'); assert.equal(tenant.name, 'Default');
  assert.match(tenant.appKey, /^app-default-[a-f0-9]{8}$/); assert.match(tenant.singleKey, /^pub-default-[a-f0-9]{8}$/);
  assert.equal(Buffer.from(tenant.secret, 'base64').length, 32);
  assert.equal(Buffer.from(tenant.secret, 'base64').toString('base64'), tenant.secret);
  assert.deepEqual(snippet.Optimizely.ContentGraph, {GatewayAddress: 'http://localhost:19082', AppKey: tenant.appKey, Secret: tenant.secret, SingleKey: tenant.singleKey});
  const original = readFileSync(join(runtime, 'tenants.json'), 'utf8');
  for (const dir of ['data', 'logs']) { mkdirSync(join(runtime, dir)); writeFileSync(join(runtime, dir, 'keep.txt'), dir); }
  assert.equal(initializeTenantFile(runtime, 19083), null);
  assert.equal(readFileSync(join(runtime, 'tenants.json'), 'utf8'), original);
  for (const dir of ['data', 'logs']) assert.equal(readFileSync(join(runtime, dir, 'keep.txt'), 'utf8'), dir);
});

test('PowerShell plan with temp RuntimeRoot is read-only, preserves existing files and produces parseable XML', {skip: !hasPowerShell, timeout: 30000}, t => {
  const root = scratch(t);
  for (const existing of [false, true]) {
    const runtime = join(root, existing ? "existing & team's runtime" : "new & team's runtime");
    if (existing) { mkdirSync(runtime); writeFileSync(join(runtime, 'tenants.json'), 'hand-edited'); }
    const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts', 'service.ps1'), 'plan', '-Port', '19082', '-RuntimeRoot', runtime, '-ImportFrom', join(root, 'dev & source')], {encoding: 'utf8', windowsHide: true});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PLAN ONLY/); assert.ok(result.stdout.includes(canonicalPath(runtime)), result.stdout);
    assert.ok(result.stdout.includes(WRAPPER_URL)); assert.match(result.stdout, /SHA-256/); assert.match(result.stdout, /PID\/name/);
    assert.match(result.stdout, /19082 \(from -Port\)/); assert.match(result.stdout, /mismatch aborts/);
    assert.match(result.stdout, /MaxMemoryMB: 8192 \(default\)/);
    assert.match(result.stdout, /LocalService Modify/); assert.match(result.stdout, /20 seconds/); assert.match(result.stdout, /dev & source/);
    assert.equal(existsSync(runtime), existing);
    if (existing) { assert.deepEqual(readdirSync(runtime), ['tenants.json']); assert.equal(readFileSync(join(runtime, 'tenants.json'), 'utf8'), 'hand-edited'); }
    const xml = result.stdout.slice(result.stdout.indexOf('<?xml'));
    const verify = runPowerShell(['-NoProfile', '-Command', '$text = [Console]::In.ReadToEnd(); [xml]$doc = $text; if ($doc.service.id -ne "LdaGraph") { exit 1 }'], {input: xml, encoding: 'utf8', windowsHide: true});
    assert.equal(verify.status, 0, verify.stderr);
  }
  const runtime = join(root, 'configured-port'); const paths = runtimePaths(runtime);
  mkdirSync(paths.service, {recursive: true});
  const configuredXml = generateServiceXml({nodePath: process.execPath, repoRoot: repo, runtimeRoot: runtime, port: 19083, maxMemoryMB: 12288});
  writeFileSync(paths.xml, configuredXml);
  const preserved = runPowerShell(['-NoProfile', '-File', join(repo, 'scripts/service.ps1'), 'plan', '-RuntimeRoot', runtime], {encoding: 'utf8', windowsHide: true});
  assert.equal(preserved.status, 0, preserved.stdout + preserved.stderr);
  assert.match(preserved.stdout, /19083 \(kept from existing config\)/);
  assert.match(preserved.stdout, /name="PORT" value="19083"/);
  assert.match(preserved.stdout, /MaxMemoryMB: 12288 \(kept from existing config\)/);
  assert.match(preserved.stdout, /--max-old-space-size=12288 /);
  assert.equal(readFileSync(paths.xml, 'utf8'), configuredXml);
  const explicit = runPowerShell(['-NoProfile', '-File', join(repo, 'scripts/service.ps1'), 'plan', '-RuntimeRoot', runtime, '-MaxMemoryMB', '16384'], {encoding: 'utf8', windowsHide: true});
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
  assert.match(explicit.stdout, /MaxMemoryMB: 16384 \(from -MaxMemoryMB\)/);
  assert.match(explicit.stdout, /--max-old-space-size=16384 /);
  writeFileSync(paths.xml, configuredXml.replace('--max-old-space-size=12288 ', ''));
  const legacy = runPowerShell(['-NoProfile', '-File', join(repo, 'scripts/service.ps1'), 'plan', '-RuntimeRoot', runtime], {encoding: 'utf8', windowsHide: true});
  assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
  assert.match(legacy.stdout, /MaxMemoryMB: 8192 \(default\)/);
  for (const memory of ['1023', '65537']) {
    const invalidMemory = runPowerShell(['-NoProfile', '-File', join(repo, 'scripts/service.ps1'), 'plan', '-RuntimeRoot', runtime, '-MaxMemoryMB', memory], {encoding: 'utf8', windowsHide: true});
    assert.notEqual(invalidMemory.status, 0);
  }
  const script = readFileSync(join(repo, 'scripts/service.ps1'), 'utf8');
  assert.ok(!script.includes('??'), 'PowerShell 5.1 has no null-coalescing operator');
  const invalid = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts/service.ps1'), 'plan', '-Port', '0', '-RuntimeRoot', join(root, 'invalid')], {encoding: 'utf8', windowsHide: true});
  assert.notEqual(invalid.status, 0); assert.equal(existsSync(join(root, 'invalid')), false);
});

test('mocked PowerShell lifecycle: install, reuse, import, conflicts, controls, status, UAC handoff and retained data', {skip: !hasPowerShell, timeout: 30000}, t => {
  const root = scratch(t);
  const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'test/fixtures/service-harness.ps1'), '-RuntimeRoot', join(root, 'runtime & files')], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: mocked install/);
});

test('PowerShell plan preserves non-ASCII runtime paths in generated XML and restores console encoding', {skip: !hasPowerShell, timeout: 15000}, t => {
  const root = scratch(t); const runtime = join(root, 'caf\u00e9-\u6771\u4eac');
  const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'test/fixtures/service-harness.ps1'), '-RuntimeRoot', runtime, '-EncodingPlan'], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: UTF-8 plan/);
  assert.equal(existsSync(runtime), false);
});

test('service logs command tails the last 50 lines of wrapper, stdout and stderr without modifying a temp runtime', {skip: !hasPowerShell, timeout: 15000}, t => {
  const root = scratch(t); const runtime = join(root, 'runtime'); const service = join(runtime, 'service'); const logs = join(service, 'logs');
  mkdirSync(logs, {recursive: true});
  for (const [folder, suffix] of [[service, 'wrapper'], [logs, 'out'], [logs, 'err']]) {
    writeFileSync(join(folder, `LdaGraph.${suffix}.log`), Array.from({length: 60}, (_, index) => `${suffix}-line-${index + 1}`).join('\n'));
  }
  const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts/service.ps1'), 'logs', '-RuntimeRoot', runtime], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const suffix of ['wrapper', 'out', 'err']) {
    assert.ok(!result.stdout.includes(`${suffix}-line-10\n`) && !result.stdout.includes(`${suffix}-line-10\r\n`));
    assert.ok(result.stdout.includes(`${suffix}-line-11`)); assert.ok(result.stdout.includes(`${suffix}-line-60`));
  }
  assert.deepEqual(readdirSync(service).sort(), ['LdaGraph.wrapper.log', 'logs']);
  assert.deepEqual(readdirSync(logs).sort(), ['LdaGraph.err.log', 'LdaGraph.out.log']);
});

test('npm service entry points and documented install/upgrade/uninstall commands', () => {
  const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;
  for (const command of ['install', 'uninstall', 'status', 'restart', 'logs']) assert.ok(scripts[`service:${command}`].endsWith(`scripts/service.ps1 ${command}`));
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  assert.match(readme, /## Run as a Windows service/);
  for (const text of ['powershell -ExecutionPolicy Bypass -File scripts\\service.ps1 install', 'C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\Graph', 'UAC', 'appsettings.Development.json', 'git pull', 'npm run service:restart', 'npm run service:uninstall', 'service:logs', '-RuntimeRoot', '-ImportFrom', '-RemoveData']) assert.ok(readme.includes(text), text);
});

for (const signal of ['SIGBREAK', 'SIGINT', 'SIGTERM']) {
  test(`${signal} flushes pending tenant stores before subprocess exit`, {timeout: 20000}, async t => {
    const root = scratch(t); const dataDir = join(root, 'data');
    const tenantsFile = join(root, 'tenants.json');
    const entries = ['one', 'two'].map(id => ({id, name: id, appKey: id, singleKey: id + '-public', secret: Buffer.alloc(32, 1).toString('base64')}));
    writeFileSync(tenantsFile, JSON.stringify({tenants: entries}));
    // A preload only delays background persistence. The production CLI and signal handlers run unchanged.
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(repo, 'test/fixtures/service-signal-preload.js')).href, join(repo, 'src/server.js')], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {...process.env, PORT: '0', HOST: '127.0.0.1', TENANTS_FILE: tenantsFile, DATA_DIR: dataDir, LOG_DIR: join(root, 'logs'), GRAPH_APP_KEY: '', GRAPH_SECRET: '', GRAPH_SINGLE_KEY: '', ADMIN_USER: '', ADMIN_PASSWORD: ''}
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
    const deadline = Date.now() + 10000;
    let match;
    while (!(match = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout))) {
      assert.equal(child.exitCode, null, stdout + stderr);
      assert.ok(Date.now() < deadline, 'server did not announce an ephemeral port');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(stdout, /JavaScript heap limit: \d+ MiB/);
    const base = `http://127.0.0.1:${match[1]}`;
    for (const tenant of entries) {
      const response = await fetch(base + '/_doc/' + tenant.id, {method: 'POST', headers: {Authorization: 'Basic ' + Buffer.from(tenant.appKey + ':' + tenant.secret).toString('base64'), 'Content-Type': 'application/json'}, body: JSON.stringify(document())});
      assert.equal(response.status, 200, await response.text());
      assert.equal(existsSync(join(dataDir, tenant.id, 'store.ndjson')), false, 'shutdown must perform the save, not the debounce timer');
    }
    // Windows kill() force-terminates Node; IPC delivers the process signal event.
    // POSIX SIGINT/SIGTERM use real OS delivery. SIGBREAK is a Windows event only.
    if (process.platform === 'win32' || signal === 'SIGBREAK') child.send({signal});
    else { child.disconnect(); child.kill(signal); }
    const [code, termination] = await exited;
    assert.equal(code, 0, stdout + stderr); assert.equal(termination, null);
    for (const tenant of entries) {
      const records = readFileSync(join(dataDir, tenant.id, 'store.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
      const doc = records.find(record => record.record === 'docs' && record.id === tenant.id);
      assert.ok(doc, `${signal} must persist tenant ${tenant.id}`); assert.deepEqual(doc.value.raw, document());
      assert.equal(records.at(-1).record, 'end'); assert.equal(existsSync(join(dataDir, tenant.id, 'store.ndjson.tmp')), false);
    }
  });
}

test('without -RuntimeRoot the script follows the installed service to its runtime folder', () => {
  const script = readFileSync(new URL('../scripts/service.ps1', import.meta.url), 'utf8');
  const detect = script.indexOf("if (!$PSBoundParameters.ContainsKey('RuntimeRoot'))");
  assert.ok(detect > script.indexOf('$serviceId = '), 'detection runs after the service id is known');
  assert.ok(detect < script.indexOf('$RuntimeRoot = Get-CanonicalPath $RuntimeRoot'), 'detection runs before paths are derived');
  assert.match(script, /\$RuntimeRoot = Split-Path \(Split-Path \$installedExe -Parent\) -Parent/);
});

test('README upgrade path from the pre-rename service id, CONTRIBUTING DCO/licence grant and CLEAN-ROOM audit wording', () => {
  const legacy = readFileSync(join(repo, 'scripts/service.ps1'), 'utf8').match(/\$legacyServiceId = '([A-Za-z]+)'/)[1];
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  for (const text of [`## Upgrading from an older install (${legacy})`, 'lda adopt', `sc.exe stop ${legacy}`, `sc.exe delete ${legacy}`, 'scripts\\service.ps1 install -RuntimeRoot "<old runtime folder>"', 'the data folder is not touched']) assert.ok(readme.includes(text), text);
  const contributing = readFileSync(join(repo, 'CONTRIBUTING.md'), 'utf8');
  assert.ok(!contributing.includes('lawyer review'));
  for (const text of ['`git commit -s`', 'https://developercertificate.org/', 'Contributions are licensed to you and us under the same licence as this repository (Business Source License 1.1). By contributing you also grant Coding Koalas Pty Ltd a perpetual, worldwide, royalty-free licence to use, modify and relicense your contribution, including under other licence terms.']) assert.ok(contributing.includes(text), text);
  const cleanRoom = readFileSync(join(repo, 'CLEAN-ROOM.md'), 'utf8');
  assert.ok(!cleanRoom.includes('lawyer review'));
  assert.ok(!cleanRoom.includes('remains to be confirmed'));
  for (const text of ["The research ran under the author's own Optimizely CMS development setup.", '| 2026-10-16 | all commits in the published history | independent AI reviewer | clean |', 'Public repositories are published with a fresh history that starts at the first release.']) assert.ok(cleanRoom.includes(text), text);
});
