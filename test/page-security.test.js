import test from 'node:test';
import assert from 'node:assert/strict';
import {A, basic, tenants} from './tenant-helpers.js';
import {mergeFrameAncestors} from '../src/page-security.js';

const framed = response => {
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
};

test('admin HTML pages send X-Frame-Options SAMEORIGIN and frame-ancestors self', async t => {
  const gw = await tenants(t); const base = '/tenants/' + A.id;
  for (const path of ['/', base, base + '/edit', '/graphiql', '/graphiql?tenant=' + A.id, '/explorer?tenant=' + A.id, '/explorer']) {
    const response = await gw.request(path, {auth: null});
    assert.equal(response.status, 200, path); assert.match(response.headers.get('content-type'), /text\/html/, path); framed(response);
  }
  // The HTML GraphiQL on the query endpoint is an admin page too.
  framed(await gw.request('/content/v2', {auth: null, headers: {Accept: 'text/html'}}));
});

test('/app/graphiql stays embeddable by the CMS; JSON API responses carry no framing headers', async t => {
  const gw = await tenants(t);
  for (const path of ['/app/graphiql?auth=' + A.singleKey, '/app/graphiql?auth=unknown']) {
    const response = await gw.request(path, {auth: null});
    assert.equal(response.headers.get('x-frame-options'), null, path);
    assert.equal(response.headers.get('content-security-policy'), null, path);
  }
  for (const response of [await gw.request('/health', {auth: null}), await gw.request('/tenants/' + A.id + '/stats', {auth: null}),
    await gw.request('/content/v2', {method: 'POST', auth: basic(A), body: {query: '{_Content{total}}'}})]) {
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('x-frame-options'), null); assert.equal(response.headers.get('content-security-policy'), null);
  }
});

test('frame-ancestors merges into an existing CSP without loosening it', () => {
  assert.equal(mergeFrameAncestors(undefined, "'self'"), "frame-ancestors 'self'");
  assert.equal(mergeFrameAncestors("default-src 'self';", "'self'"), "default-src 'self'; frame-ancestors 'self'");
  assert.equal(mergeFrameAncestors("default-src 'none'; frame-ancestors 'none'", "'self'"), "default-src 'none'; frame-ancestors 'none'");
});
