import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {product} from '../src/product.js';
import {generateTenant} from '../src/tenant-create.js';

export const SERVICE_ID = 'LdaGraph';
export const DEFAULT_RUNTIME_ROOT = 'C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\Graph';
export const WRAPPER_URL = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';

const pathsFor = value => path.win32.isAbsolute(value) && !value.startsWith('/') ? path.win32 : path;
const xml = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));

export function runtimePaths(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  const paths = pathsFor(runtimeRoot);
  if (!paths.isAbsolute(runtimeRoot)) throw new Error('RuntimeRoot must be an absolute path');
  const root = paths.normalize(runtimeRoot);
  const service = paths.join(root, 'service');
  return {root, tenantsFile: paths.join(root, 'tenants.json'), dataDir: paths.join(root, 'data'), logDir: paths.join(root, 'logs'), service,
    wrapper: paths.join(service, `${SERVICE_ID}.exe`), xml: paths.join(service, `${SERVICE_ID}.xml`), wrapperLogs: paths.join(service, 'logs')};
}

export function generateServiceXml({nodePath, repoRoot, runtimeRoot = DEFAULT_RUNTIME_ROOT, port = 8082, host = '127.0.0.1', maxMemoryMB = 8192}) {
  for (const [label, value] of Object.entries({nodePath, repoRoot})) {
    if (typeof value !== 'string' || !pathsFor(value).isAbsolute(value) || /[\x00-\x1f"%]/.test(value)) throw new Error(`${label} must be an absolute path without quotes, control characters or % expansion`);
  }
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be an integer from 1 to 65535');
  if (!Number.isInteger(Number(maxMemoryMB)) || Number(maxMemoryMB) < 1024 || Number(maxMemoryMB) > 65536) throw new Error('MaxMemoryMB must be an integer from 1024 to 65536');
  if (typeof host !== 'string' || !host || /[\x00-\x1f%]/.test(host)) throw new Error('Host must be nonempty without control characters or % expansion');
  if (/[\x00-\x1f"%]/.test(runtimeRoot)) throw new Error('RuntimeRoot cannot contain quotes, control characters or % expansion');
  const runtime = runtimePaths(runtimeRoot);
  const server = pathsFor(repoRoot).join(repoRoot, 'src', 'server.js');
  const env = {PORT: Number(port), HOST: host, TENANTS_FILE: runtime.tenantsFile, DATA_DIR: runtime.dataDir, LOG_DIR: runtime.logDir};
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${SERVICE_ID}</id>
  <name>Local Developer Accelerator — Graph (development only)</name>
  <description>LDA Local Graph — local development stand-in compatible with Optimizely Graph. Not for production. By Coding Koala.</description>
  <executable>${xml(nodePath)}</executable>
  <arguments>${xml(`--max-old-space-size=${Number(maxMemoryMB)} "${server}"`)}</arguments>
  <workingdirectory>${xml(repoRoot)}</workingdirectory>
${Object.entries(env).map(([name, value]) => `  <env name="${name}" value="${xml(value)}" />`).join('\n')}
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>${xml(runtime.wrapperLogs)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <serviceaccount>
    <domain>NT AUTHORITY</domain>
    <user>LocalService</user>
  </serviceaccount>
</service>
`;
}

/** Exclusive creation preserves existing credentials on repeated installs. */
export function initializeTenantFile(runtimeRoot, port = 8082) {
  const runtime = runtimePaths(runtimeRoot);
  if (existsSync(runtime.tenantsFile)) return null;
  const tenant = generateTenant('Default', []);
  mkdirSync(runtime.root, {recursive: true});
  writeFileSync(runtime.tenantsFile, JSON.stringify({dataVersion: product.dataVersion, tenants: [tenant]}, null, 2) + '\n', {flag: 'wx'});
  return {Optimizely: {ContentGraph: {GatewayAddress: `http://localhost:${port}`, AppKey: tenant.appKey, Secret: tenant.secret, SingleKey: tenant.singleKey}}};
}

// JSON on stdin avoids shell quoting/escaping paths and keeps PowerShell 5.1 simple.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    if (process.argv[2] === 'init') {
      const snippet = initializeTenantFile(options.runtimeRoot, options.port);
      if (snippet) console.log(JSON.stringify(snippet, null, 2));
    } else if (process.argv[2] === 'xml') process.stdout.write(generateServiceXml(options));
    else throw new Error('Expected xml or init command');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
