import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {gateway} from './helpers.js';

export const A = {id: 'site-a', name: 'Site A', appKey: 'app-a', secret: Buffer.alloc(32, 1).toString('base64'), singleKey: 'public-a'};
export const B = {id: 'site-b', name: 'Site B', appKey: 'app-b', secret: Buffer.alloc(32, 2).toString('base64'), singleKey: 'public-b'};
export const basic = (tenant, secret = tenant.secret) => `Basic ${Buffer.from(`${tenant.appKey}:${secret}`).toString('base64')}`;
export function preview(tenant, signer = tenant, claims = {}) {
  const header = Buffer.from(JSON.stringify({alg: 'HS256'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: 'graph', aud: 'graph', appKey: tenant.appKey, role: 'Editors', sub: 'editor', ...claims})).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(signer.secret, 'base64')).update(`${header}.${payload}`).digest('base64url');
  return `Bearer ${header}.${payload}.${signature}`;
}
export function scratch(t) {
  const root = resolve(tmpdir()); const folder = mkdtempSync(join(root, 'graph-tenants-'));
  t.after(() => { const target = resolve(folder); const inside = relative(root, target); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); rmSync(target, {recursive: true, force: true}); });
  return folder;
}
export async function tenants(t, options = {}) {
  const root = scratch(t); const file = join(root, 'tenants.json');
  writeFileSync(file, JSON.stringify({tenants: [A, B]}));
  const gatewayOptions = {tenantsFile: file, dataDir: join(root, 'data'), logDir: join(root, 'logs'), ...options};
  const gw = await gateway(t, gatewayOptions);
  return {...gw, root, file, options: gatewayOptions};
}
export const csrf = html => /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];
export const postForm = (gw, path, body, options = {}) => gw.request(path, {method: 'POST', body: new URLSearchParams(body).toString(), headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: gw.base, ...options.headers}, auth: null, redirect: 'manual', ...options});
export async function eventually(check, message) {
  const end = Date.now() + 3000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < end);
  assert.fail(message);
}
