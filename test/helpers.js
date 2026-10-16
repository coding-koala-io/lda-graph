import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';
import {MODEL, index} from './fixtures.js';
import {REQUESTS, JOB_ID} from './synthetic-fixtures.js';

export const BASIC = `Basic ${Buffer.from('local:local').toString('base64')}`;
export const quiet = {log() {}, error() {}};
export async function gateway(t, options = {}) {
  const server = createServer({dataDir: ':memory:', logDir: ':memory:', logger: quiet, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, {method = 'GET', body, headers = {}, auth = BASIC, redirect = 'follow'} = {}) {
    const response = await fetch(base + path, {method, redirect, headers: {...(auth ? {Authorization: auth} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...headers}, ...(body !== undefined ? {body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)} : {})});
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
    return {status: response.status, data, headers: response.headers};
  }
  async function gql(query, variables = {}, options = {}) {
    const {operationName, ...requestOptions} = options;
    const result = await request('/content/v2?cache=false', {method: 'POST', body: {query, variables, ...(operationName ? {operationName} : {})}, ...requestOptions});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function seed() {
    assert.equal((await request('/api/content/v3/types', {method: 'PUT', body: MODEL})).status, 200);
    assert.equal((await request('/_stream', {method: 'POST', body: index(), headers: {'Content-Type': 'application/x-ndjson'}})).status, 200);
  }
  return {server, base, request, gql, seed};
}
export function success(result, root) {
  assert.equal(Object.hasOwn(result, 'errors'), false, JSON.stringify(result.errors));
  assert.deepEqual(Object.keys(result.data), [root]);
  assert.match(result.extensions.correlationId, /^[a-f0-9-]{36}$/);
  return result.data[root];
}

export async function replaySynthetic(request, options = {}) {
  let journalId;
  for (const fixture of REQUESTS) {
    const url = typeof fixture.url === 'function' ? fixture.url(journalId) : fixture.url;
    const body = typeof fixture.body === 'function' ? fixture.body(journalId) : fixture.body;
    const headers = url === '/_stream' ? {'Content-Type': 'application/x-ndjson'} : {};
    const response = await request(url, {method: fixture.method, headers, ...options, ...(body !== undefined ? {body} : {})});
    assert.equal(response.status, fixture.status ?? 200, `${fixture.method} ${url}: ${JSON.stringify(response.data)}`);
    if (url === '/_stream') {
      assert.deepEqual(Object.keys(response.data), ['journalId']);
      assert.match(response.data.journalId, /^[a-f0-9-]{36}$/);
      journalId = response.data.journalId;
      const journal = (await request('/journal/stream/' + journalId, options)).data;
      assert.equal(journal.errors, false); assert.equal(journal.status, 'done');
      assert.deepEqual(journal.items.map(item => item.index.Result), fixture.results);
      assert.ok(journal.items.every(item => item.index.Status >= 200 && item.index.Status < 300));
    }
    if (url === '/content/v2') {
      assert.equal(success(response.data, '_Content').item._metadata.lastModified, '2026-01-02T12:00:00.000Z');
    }
    if (url.endsWith('/status')) assert.deepEqual(response.data, {
      id: JOB_ID, status: 'Success', failingJournals: [], error: null,
      totalJournalIds: 1, succeededJournalIds: 1, failedJournalIds: 0, queuedJournalIds: 0});
    if (url.startsWith('/journal/stream/')) { assert.equal(response.data.errors, false); assert.equal(response.data.items.length, 11); }
  }
  return journalId;
}
