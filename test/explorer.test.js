import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL, document, KEY} from './fixtures.js';
import {gateway, success} from './helpers.js';
import {A, B, basic, tenants} from './tenant-helpers.js';

async function seeded(t) {
  const gw = await tenants(t); const rt = gw.server.tenants.get(A.id);
  await gw.request('/api/content/v3/types', {method: 'PUT', auth: basic(A), body: MODEL});
  for (let n = 0; n < 55; n++) rt.store.upsert('article-' + n, document({metadata: {key: 'article-key-' + n, displayName: 'Article ' + String(n).padStart(2, '0'), locale: n < 5 ? 'sv' : 'en'}}));
  rt.store.upsert('teaser', document({__typename: 'TeaserBlock', metadata: {key: 'teaserkey', displayName: 'Teaser one', types: ['TeaserBlock', '_Component', '_Content']}}));
  rt.store.upsert('xss', document({metadata: {key: KEY, displayName: 'Hostile', status: 'Draft'}, 'Heading$$String___searchable': '<script>alert(1)</script> zanzibar', Related: {__typename: 'ContentReference', 'key$$String': 'teaserkey'}}));
  return {gw, rt};
}

test('explorer picker lists instances with counts and a single instance redirects to it', async t => {
  const {gw} = await seeded(t);
  const picker = (await gw.request('/explorer', {auth: null})).data;
  assert.match(picker, /Content explorer/); assert.ok(picker.includes('/explorer?tenant=site-a')); assert.ok(picker.includes('/explorer?tenant=site-b')); assert.ok(picker.includes('>57<'));
  for (const html of [(await gw.request('/', {auth: null})).data, (await gw.request('/tenants/' + A.id, {auth: null})).data]) assert.ok(html.includes('Explore content'));
  await gw.server.tenants.edit(entries => entries.filter(entry => entry.id === B.id));
  const single = await gw.request('/explorer', {auth: null, redirect: 'manual'});
  assert.equal(single.status, 303); assert.equal(single.headers.get('location'), '/explorer?tenant=site-b');
  assert.equal((await gw.request('/explorer?tenant=missing', {auth: null})).status, 404);
});

test('explorer type counts are sorted by count and items page 50 at a time with locale and status filters', async t => {
  const {gw} = await seeded(t);
  const types = (await gw.request('/explorer?tenant=' + A.id, {auth: null})).data;
  assert.ok(types.indexOf('ArticlePage') < types.indexOf('TeaserBlock')); assert.ok(types.includes('>56<')); assert.ok(types.includes('StandardPage'));
  assert.ok(types.includes('name="q"')); assert.ok(types.includes('/graphiql?tenant=site-a')); assert.ok(!types.includes('slot=new'));
  const first = (await gw.request('/explorer?tenant=site-a&type=ArticlePage', {auth: null})).data;
  assert.match(first, /56 items · page 1 of 2/); assert.ok(first.includes('Article 00')); assert.ok(!first.includes('Article 54')); assert.ok(first.includes('Next 50'));
  const second = (await gw.request('/explorer?tenant=site-a&type=ArticlePage&page=2', {auth: null})).data;
  assert.ok(second.includes('Article 54')); assert.ok(second.includes('Previous 50')); assert.ok(!second.includes('Article 00'));
  const swedish = (await gw.request('/explorer?tenant=site-a&type=ArticlePage&locale=sv', {auth: null})).data;
  assert.match(swedish, /5 items · page 1 of 1/); assert.ok(swedish.includes('<option value="sv" selected>'));
  assert.match((await gw.request('/explorer?tenant=site-a&type=ArticlePage&status=Draft', {auth: null})).data, /1 items · page 1 of 1/);
});

test('explorer search uses GraphQL fulltext with all statuses and the new slot toggle appears only with a new slot', async t => {
  const {gw, rt} = await seeded(t);
  const found = (await gw.request('/explorer?tenant=site-a&q=zanzibar', {auth: null})).data;
  assert.match(found, /1 matching items/); assert.ok(found.includes('Hostile')); assert.ok(found.includes('ArticlePage')); assert.ok(found.includes('Draft'));
  assert.match((await gw.request('/explorer?tenant=site-a&q=nothingmatches', {auth: null})).data, /0 matching items/);
  assert.equal(rt.log.recent.filter(entry => entry.url.startsWith('/content/v2')).length, 0);
  rt.store.mutate('deployNewAccountVersion'); rt.store.upsert('pending', document({metadata: {displayName: 'Pending item'}}), {slot: 'new'});
  const live = (await gw.request('/explorer?tenant=site-a', {auth: null})).data; assert.ok(live.includes('slot=new'));
  const next = (await gw.request('/explorer?tenant=site-a&slot=new&type=ArticlePage', {auth: null})).data;
  assert.ok(next.includes('Pending item')); assert.match(next, /1 items/);
});

test('explorer detail escapes values, links references and opens a working GraphiQL query by key', async t => {
  const {gw} = await seeded(t);
  const html = (await gw.request('/explorer?tenant=site-a&id=xss', {auth: null})).data;
  assert.ok(!html.includes('<script>alert(1)</script>')); assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; zanzibar'));
  for (const label of ['Metadata', 'Properties', 'Raw JSON', 'Open in GraphiQL']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('&amp;id=teaser')); assert.ok(html.includes('&lt;p&gt;Résumé quick content&lt;/p&gt;'));
  const href = /<a class="button" href="([^"]+)">Open in GraphiQL/.exec(html)[1].replaceAll('&amp;', '&');
  const query = new URL(href, gw.base).searchParams.get('query'); assert.ok(query.includes(KEY)); assert.ok(href.includes(KEY));
  const items = success(await gw.gql(query, {}, {auth: basic(A)}), 'ArticlePage').items;
  assert.deepEqual(items.map(item => item._id), ['xss']); assert.ok(items[0].MainBody.html);
  assert.equal((await gw.request('/explorer?tenant=site-a&id=missing', {auth: null})).status, 404);
});

test('explorer is an admin route: non-loopback without admin credentials gets 401', async t => {
  const admin = `Basic ${Buffer.from('manager:admin-password').toString('base64')}`;
  const remote = await gateway(t, {host: '0.0.0.0', adminUser: 'manager', adminPassword: 'admin-password'});
  for (const auth of [null, 'epi-single public']) {
    const response = await remote.request('/explorer?tenant=default', {auth});
    assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal((await remote.request('/explorer?tenant=default', {auth: admin})).status, 200);
});
