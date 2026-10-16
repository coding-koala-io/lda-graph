import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, unlinkSync, mkdirSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {Store} from '../src/store.js';
import {configuration} from '../src/server.js';
import {gateway, success, quiet, BASIC} from './helpers.js';
import {MODEL, document} from './fixtures.js';

function scratch(t) {
  const root = resolve(tmpdir()); const folder = mkdtempSync(join(root, 'graph-cors-'));
  t.after(() => {
    const target = resolve(folder); const inside = relative(root, target);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    rmSync(target, {recursive: true, force: true});
  });
  return folder;
}
function preview(secret = 'local') {
  const header = Buffer.from(JSON.stringify({alg: 'HS256'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: 'graph', aud: 'graph', appKey: 'local', sub: 'editor', role: 'Editors'})).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${header}.${payload}`).digest('base64url');
  return `Bearer ${header}.${payload}.${signature}`;
}
function noCors(response) {
  for (const [name] of response.headers) assert.ok(!name.startsWith('access-control-'), name);
  assert.equal(response.headers.get('vary'), null);
}
// fetch/Undici ignores Host overrides; use node:http to exercise rebinding.
function requestWithHost(base, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(base + path, {headers: {Authorization: BASIC, ...headers}}, response => {
      response.resume();
      response.on('end', () => resolve({status: response.statusCode, headers: new Headers(response.headers)}));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('CORS scope, origin allowlist and Host checks protect admin routes', async t => {
  assert.equal(configuration({CORS_ORIGINS: 'https://app.example,https://other.example'}).corsOrigins, 'https://app.example,https://other.example');
  const {request, server, base, seed} = await gateway(t); await seed();
  const Origin = 'http://localhost:3000';
  const protectedPaths = ['/graphiql', '/', '/_stream', '/_doc/x', '/api/content/v3/types', '/api/webhooks', '/journal/indexing', '/account', '/extract', '/clientlog', '/__debug/docs', '/__debug/reset', '/missing'];
  const state = structuredClone(server.store.state);
  for (const path of protectedPaths) {
    for (const method of ['OPTIONS', 'GET', 'POST']) {
      const response = await request(path, {method, headers: {Origin}, ...(method === 'POST' ? {body: {}} : {})});
      assert.equal(response.status, 403, `${method} ${path}`); noCors(response);
    }
  }
  assert.deepEqual(server.store.state, state);
  for (const path of ['/content/v2']) {
    const response = await request(path, {method: 'OPTIONS', auth: null, headers: {Origin}});
    assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), Origin);
  }
  for (const auth of [BASIC, 'bAsIc invalid']) {
    const response = await request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, auth, headers: {Origin}});
    assert.equal(response.status, 403);
  }
  for (const auth of ['epi-single public', preview(), null]) {
    const response = await request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, auth, headers: {Origin}});
    assert.equal(response.status, 200); assert.equal(response.data.errors, undefined);
    assert.equal(response.data.data._Content.total, 1);
    for (const method of ['POST', 'GET']) {
      const mutation = 'mutation{deployNewAccountVersion}';
      const response = await request(method === 'GET' ? `/content/v2?query=${encodeURIComponent(mutation)}` : '/content/v2', {method, ...(method === 'POST' ? {body: {query: mutation}} : {}), auth, headers: {Origin}});
      assert.equal(response.status, 403);
    }
  }
  assert.deepEqual(server.store.state, state);
  const port = server.address().port;
  for (const authority of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    const response = await requestWithHost(base, '/api/content/v3/types', {Host: authority, Origin: `http://${authority}`});
    assert.equal(response.status, 200); noCors(response);
    assert.equal((await request('/content/v2', {method: 'POST', body: {query: '{_Content{total}}'}, headers: {Host: authority, Origin: base}})).status, 200);
  }
  for (const Host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost', `localhost:${port}@evil.example`]) {
    for (const path of ['/content/v2', '/__debug/docs', '/']) {
      const response = await requestWithHost(base, path, {Host, Origin: `http://${Host}`});
      assert.equal(response.status, 403); noCors(response);
    }
  }
  const configured = await gateway(t, {corsOrigins: ' https://app.example, https://other.example '});
  for (const path of ['/content/v2']) {
    assert.equal((await configured.request(path, {method: 'OPTIONS', auth: null, headers: {Origin: 'https://app.example'}})).status, 204);
    for (const origin of [Origin, 'null', 'invalid', 'https://app.example.evil']) {
      const response = await configured.request(path, {method: 'OPTIONS', auth: null, headers: {Origin: origin}});
      assert.equal(response.status, 403); noCors(response);
    }
  }
  assert.equal((await configured.request('/content/v2', {method: 'POST', auth: null, body: {query: '{_Content{total}}'}, headers: {Origin: configured.base}})).status, 200);
  const remote = await gateway(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'admin-password'});
  assert.equal((await requestWithHost(remote.base, '/health', {Host: 'remote.example'})).status, 200);
});

test('root logging preserves GraphQL directive variable errors', async t => {
  const lines = []; const {gql, seed} = await gateway(t, {logger: {log: m => lines.push(m), error: m => lines.push(m)}}); await seed();
  for (const directive of ['include', 'skip']) {
    const query = `query($active:Boolean!){_Content @${directive}(if:$active){total}}`;
    for (const variables of [{}, {active: null}, {active: 'true'}, {active: 1}, {active: []}]) {
      const response = await gql(query, variables);
      assert.ok(response.errors?.length, JSON.stringify(variables));
      assert.match(response.errors[0].message, /Variable.*active/);
      assert.equal(response.data, undefined);
    }
    const invalid = await gql(`{_Content @${directive}(if:"bad"){total}}`);
    assert.ok(invalid.errors?.length); assert.equal(invalid.data, undefined);
  }
  const response = await gql('query($active:Boolean! = true){...Root} fragment Root on Query{alias:_Content @include(if:$active){total}}');
  assert.equal(response.errors, undefined); assert.equal(response.data.alias.total, 1);
  assert.ok(lines.some(line => /root=_Content/.test(line)));
  assert.equal(success(await gql('{_Content{total}}'), '_Content').total, 1);
});

test('legacy migration cannot resurrect stale data after corruption or missing NDJSON', async t => {
  const dataDir = scratch(t); const legacy = join(dataDir, 'store.json'); const ndjson = join(dataDir, 'store.ndjson');
  const stale = JSON.stringify({types: {default: MODEL}, docs: {stale: {raw: document()}}, slots: {}});
  writeFileSync(legacy, stale);
  const store = new Store({dataDir, logger: quiet}); assert.ok(store.state.docs.stale);
  store.delete('stale'); store.upsert('current', document());
  // A failed atomic promotion must leave the legacy source intact.
  mkdirSync(ndjson);
  await assert.rejects(store.flush());
  assert.equal(readFileSync(legacy, 'utf8'), stale);
  assert.equal(readdirSync(dataDir).some(file => file.startsWith('store.json.migrated-')), false);
  rmdirSync(ndjson); await store.flush();
  assert.equal(existsSync(legacy), false);
  const markers = readdirSync(dataDir).filter(file => file.startsWith('store.json.migrated-'));
  assert.equal(markers.length, 1); assert.equal(readFileSync(join(dataDir, markers[0]), 'utf8'), stale);
  writeFileSync(legacy, stale);
  const restored = new Store({dataDir, logger: quiet});
  assert.ok(restored.state.docs.current); assert.equal(restored.state.docs.stale, undefined);
  writeFileSync(ndjson, '{"record":"header","version":1}\n{"record":"docs"');
  assert.deepEqual(new Store({dataDir, logger: quiet}).state.docs, {});
  assert.equal(existsSync(ndjson), false);
  assert.deepEqual(new Store({dataDir, logger: quiet}).state.docs, {}, 'Quarantined modern store prevents fallback');
  for (const file of readdirSync(dataDir).filter(file => file.endsWith('.ndjson'))) unlinkSync(join(dataDir, file));
  assert.deepEqual(new Store({dataDir, logger: quiet}).state.docs, {}, 'Migration marker alone prevents fallback');
  const quarantineOnly = scratch(t);
  writeFileSync(join(quarantineOnly, 'store.json'), stale);
  writeFileSync(join(quarantineOnly, 'store.ndjson'), 'broken');
  assert.deepEqual(new Store({dataDir: quarantineOnly, logger: quiet}).state.docs, {});
  assert.deepEqual(new Store({dataDir: quarantineOnly, logger: quiet}).state.docs, {}, 'Quarantine alone prevents fallback');
});

test('model output coercion repairs bad fields without GraphQL errors and warns once', async t => {
  const warnings = []; const {request, gql, server} = await gateway(t, {logger: {log() {}, error: m => warnings.push(m)}});
  const model = structuredClone(MODEL);
  for (const [field, type] of Object.entries({Numbers: '[Int!]', Flags: '[Boolean]', Matrix: '[[Float]]', Dates: '[DateTime]', Stats: 'Stats', StatsList: '[Stats]'})) model.contentTypes.ArticlePage.properties[field] = {type};
  model.propertyTypes.Stats = {properties: {count: {type: 'Int'}, flag: {type: 'Boolean'}, title: {type: 'String'}}};
  assert.equal((await request('/api/content/v3/types', {method: 'PUT', body: model})).status, 200);
  const first = document({'Number$$Int': '12', 'Rating$$Float': '1.25e2', 'Visible$$Boolean': 'false', 'Heading$$String___searchable': {label: 'object'}, 'Tags$$String': 'solo', MainBody: 'bad object', ContentArea: [7, {__typename: 'TeaserBlock', Heading: 5}], Numbers: ['2', 'bad', 3.5, {}, true, '2147483648', null, -4], Flags: ['true', 'false', 'no', 1, false], Matrix: [[1, '2.5', 'bad'], '3'], Stats: {count: 'bad', flag: 'true', title: {a: 1}}, StatsList: [1, {count: '4', flag: 'bad', title: true}]});
  assert.equal((await request('/_doc/coerce', {method: 'POST', body: first})).status, 200);
  const query = '{ArticlePage(ids:["coerce"]){item{Number Rating Visible Heading Tags MainBody{html} ContentArea{... on TeaserBlock{Heading}} Numbers Flags Matrix Stats{count flag title} StatsList{count flag title}}}}';
  const item = success(await gql(query), 'ArticlePage').item;
  assert.deepEqual(item, {Number: 12, Rating: 125, Visible: false, Heading: '{"label":"object"}', Tags: ['solo'], MainBody: null, ContentArea: [{Heading: '5'}], Numbers: [2, null, -4], Flags: [true, false, false], Matrix: [[1, 2.5], [3]], Stats: {count: null, flag: true, title: '{"a":1}'}, StatsList: [{count: 4, flag: null, title: 'true'}]});
  const warningCount = warnings.length;
  assert.ok(warnings.some(message => message.includes('document coerce, field Stats.count')));
  assert.equal(new Set(warnings).size, warningCount);
  success(await gql(query), 'ArticlePage'); assert.equal(warnings.length, warningCount);
  assert.equal(server.store.state.docs.coerce.raw['Number$$Int'], '12', 'Coercion does not rewrite raw data');
  for (const [i, number] of ['bad', '', 'Infinity', 'NaN', {}, [], true, '1.5', '2147483648', '-2147483649'].entries()) {
    await request(`/_doc/invalid-${i}`, {method: 'POST', body: document({'Number$$Int': number, 'Rating$$Float': number, 'Visible$$Boolean': number, MainBody: 42})});
    const value = success(await gql(`{ArticlePage(ids:["invalid-${i}"]){item{Number Rating Visible MainBody{html}}}}`), 'ArticlePage').item;
    assert.equal(value.Number, null);
    assert.equal(value.Rating, typeof number === 'string' && number.trim() && Number.isFinite(Number(number)) ? Number(number) : null);
    assert.equal(value.Visible, typeof number === 'boolean' ? number : null); assert.equal(value.MainBody, null);
  }
  await request('/_doc/scalar-list', {method: 'POST', body: document({Numbers: '9', Flags: 'true', StatsList: {count: '8'}})});
  assert.deepEqual(success(await gql('{ArticlePage(ids:["scalar-list"]){item{Numbers Flags StatsList{count}}}}'), 'ArticlePage').item, {Numbers: [9], Flags: [true], StatsList: [{count: 8}]});
  await request('/_doc/bad-dates', {method: 'POST', body: document({Dates: [{toString: null}, '2026-10-13T00:00:00Z']})});
  assert.deepEqual(success(await gql('{ArticlePage(ids:["bad-dates"]){item{Dates}}}'), 'ArticlePage').item.Dates, ['2026-10-13T00:00:00Z']);
});

test('non-loopback dashboard and GraphiQL require separate admin Basic', async t => {
  const secret = Buffer.from('test secret').toString('base64');
  const admin = `Basic ${Buffer.from('manager:admin-password').toString('base64')}`;
  const remote = await gateway(t, {host: '0.0.0.0', appKey: 'local', secret, adminUser: 'manager', adminPassword: 'admin-password'});
  for (const path of ['/', '/graphiql', '/content/v2']) {
    for (const auth of [null, 'epi-single public', preview(secret), BASIC]) {
      const response = await remote.request(path, {auth, headers: {Accept: 'text/html'}});
      assert.equal(response.status, 401, `${path} ${auth}`);
    }
    const response = await remote.request(path, {auth: admin, headers: {Accept: 'text/html'}});
    assert.equal(response.status, 200); assert.match(response.data, /<!doctype html>/i);
  }
  const unconfigured = await gateway(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'admin-password'});
  for (const path of ['/', '/graphiql']) {
    assert.equal((await unconfigured.request(path, {auth: null})).status, 401);
    assert.equal((await unconfigured.request(path, {auth: admin})).status, 200);
  }
  const local = await gateway(t);
  for (const path of ['/', '/graphiql']) assert.equal((await local.request(path, {auth: null})).status, 200);
});

test('numeric facet range filters narrow results and preserve other range choices', async t => {
  const {request, gql} = await gateway(t);
  const model = structuredClone(MODEL); model.contentTypes.ArticlePage.properties.Number.type = '[Int]';
  await request('/api/content/v3/types', {method: 'PUT', body: model});
  for (const [id, number, tag] of [['neg', -1, 'A'], ['zero', 0, 'A'], ['nine', 9, 'B'], ['ten', 10, 'A'], ['nineteen', 19, 'B'], ['twenty', 20, 'B'], ['multi', [1, 9, 21], 'A']]) {
    await request(`/_doc/${id}`, {method: 'POST', body: document({'Number$$Int': number, 'Tags$$String': [tag]})});
  }
  const query = `query($names:[String],$tags:[String],$active:Boolean! = true,$ranges:[RangeInput]){
    ArticlePage(orderBy:{_id:ASC},limit:1){total cursor items{_id} autocomplete{Tags(value:"")} ...Choices}
  } fragment Choices on ArticlePageOutput{facets{ranges:Number(filters:$names,ranges:$ranges,orderType:VALUE,orderBy:ASC) @include(if:$active){name count} Tags(filters:$tags,orderType:VALUE,orderBy:ASC){name count}}}`;
  const ranges = [{to: 0}, {from: 0, to: 10}, {from: 10, to: 20}, {from: 20}];
  const result = success(await gql(query, {names: ['0-10'], ranges}), 'ArticlePage');
  assert.equal(result.total, 3); assert.equal(result.items[0]._id, 'multi'); assert.ok(result.cursor);
  assert.deepEqual(result.facets.ranges, [{name: '*-0', count: 1}, {name: '0-10', count: 3}, {name: '10-20', count: 2}, {name: '20-*', count: 2}]);
  assert.deepEqual(result.facets.Tags, [{name: 'A', count: 2}, {name: 'B', count: 1}]);
  assert.deepEqual(result.autocomplete.Tags, ['A', 'B']);
  const narrowed = success(await gql(query, {names: ['0-10'], tags: ['B'], ranges}), 'ArticlePage');
  assert.equal(narrowed.total, 1); assert.equal(narrowed.items[0]._id, 'nine');
  assert.deepEqual(narrowed.facets.ranges, [{name: '0-10', count: 1}, {name: '10-20', count: 1}, {name: '20-*', count: 1}]);
  assert.deepEqual(narrowed.facets.Tags, result.facets.Tags);
  assert.equal(success(await gql(query, {names: ['0-10', '20-*'], ranges}), 'ArticlePage').total, 4);
  assert.equal(success(await gql(query, {names: ['*-0'], ranges}), 'ArticlePage').total, 1);
  assert.equal(success(await gql(query, {names: ['unknown'], ranges}), 'ArticlePage').total, 0);
  assert.equal(success(await gql(query, {names: ['0-10'], ranges, active: false}), 'ArticlePage').total, 7);
});

test('README documents scoped CORS, origins, migration and output coercion', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const pattern of [/CORS_ORIGINS.*\*/, /CORS.*only.*POST.*OPTIONS.*\/content\/v2/i, /cross-origin.*Basic.*403/i, /cross-origin.*mutations.*403/i, /Host.*DNS rebinding/i, /store\.json\.migrated-/, /quarantined.*legacy/i, /output coercion/i, /non-finite.*null/i, /scalar.*array/i, /warning.*document.*field/i, /non-loopback.*dashboard.*GraphiQL/i]) assert.match(readme, pattern);
});
