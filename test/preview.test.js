import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {gateway, success} from './helpers.js';
import {document, index, ID, MODEL} from './fixtures.js';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const BASIC = `Basic ${Buffer.from(`local:${SECRET}`).toString('base64')}`;
function token(claims = {}, {secret = SECRET, alg = 'HS256'} = {}) {
  const header = Buffer.from(JSON.stringify({alg, typ: 'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: 'graph', aud: 'graph', appKey: 'local', sub: 'Jane Doe', role: ['Editors'], exp: Math.floor(Date.now() / 1000) + 60, ...claims})).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('CMS preview HS256 token shows drafts, applies role/user ACL and resists header overrides', async t => {
  const {request, gql} = await gateway(t, {appKey: 'local', secret: SECRET});
  // CMS Basic uses the raw Base64 text as its password.
  await request('/api/content/v3/types', {method: 'PUT', body: MODEL, auth: BASIC});
  await request('/_stream', {method: 'POST', auth: BASIC, body: index() + index('draft', document({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']})) + index('userdraft', document({metadata: {status: 'Draft'}, _rbac: ['u:Jane Doe:Read']})) + index('private', document({metadata: {status: 'Draft'}, _rbac: ['r:Admins:Read']}))});
  const result = success(await gql('{_Content{items{_id} total}}', {}, {auth: `Bearer ${token()}`, headers: {'cg-roles': 'Admins'}}), '_Content');
  assert.equal(result.total, 3); assert.deepEqual(new Set(result.items.map(d => d._id)), new Set([ID, 'draft', 'userdraft']));
  assert.equal((await request('/_stream', {method: 'POST', body: '', auth: `Bearer ${token()}`})).status, 401);
  assert.equal((await request('/api/content/v3/types', {auth: `Basic ${Buffer.from('local:0123456789abcdef0123456789abcdef').toString('base64')}`})).status, 401);
});

test('preview rejects malformed JWT, tampered signatures, wrong issuer/audience/key and algorithms', async t => {
  const {request} = await gateway(t, {appKey: 'local', secret: SECRET});
  for (const jwt of ['invalid', token({iss: 'other'}), token({aud: 'other'}), token({appKey: 'other'}), token({}, {alg: 'none'}), token({}, {secret: Buffer.from('wrong').toString('base64')}), token({role: [17]})]) {
    assert.equal((await request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, auth: `Bearer ${jwt}`})).status, 401);
  }
});

test('expired preview is accepted and logged, singular role and audience array are accepted', async t => {
  const logs = [];
  const {request, gql} = await gateway(t, {appKey: 'local', secret: SECRET, logger: {log: m => logs.push(m), error: m => logs.push(m)}});
  await request('/_doc/draft', {method: 'POST', body: document({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']}), auth: BASIC});
  const result = success(await gql('{_Content{total}}', {}, {auth: `Bearer ${token({exp: 1, role: 'Editors', aud: ['graph']})}`}), '_Content');
  assert.equal(result.total, 1); assert.ok(logs.some(m => m.includes('Preview token expired')));
});

test('empty server secret decodes preview without signature verification, but still checks issuer/audience', async t => {
  const {request, gql} = await gateway(t);
  await request('/_doc/draft', {method: 'POST', body: document({metadata: {status: 'Draft'}, _rbac: ['r:Editors:Read']})});
  assert.equal(success(await gql('{_Content{total}}', {}, {auth: `Bearer ${token()}`}), '_Content').total, 1);
  assert.equal((await request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, auth: `Bearer ${token({iss: 'other'})}`})).status, 401);
});
