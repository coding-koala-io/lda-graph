import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, success} from './helpers.js';
import {document, index, ID, KEY, GUID} from './fixtures.js';
import {matchFilter} from '../src/query-engine.js';
import {normalizeDocument, comparable} from '../src/normalize.js';

test('string operators, Unicode prefixes, wildcards, equality and GUID normalization', () => {
  const cases = [
    ['Quick Article', {eq: 'Quick Article'}, true], ['Quick Article', {eq: 'quick article'}, true],
    ['Published', {notEq: 'published'}, false], ['Published', {in: ['published']}, true], ['Published', {notIn: ['published']}, false],
    ['Quick Article', {notEq: 'other'}, true], ['Quick Article', {in: ['other', 'Quick Article']}, true],
    ['Quick Article', {notIn: ['Quick Article']}, false], ['Quick Article', {contains: 'ART'}, true],
    ['Quick Article', {startsWith: 'QUICK'}, true], ['Quick Article', {endsWith: 'ICLE'}, true],
    ['Quick Article', {like: '%ART_cl%'}, true], ['a.b', {like: 'a.b'}, true], ['axb', {like: 'a.b'}, false],
    ['Résumé Article', {match: 'rés art'}, true], ['foo', {match: 'oo'}, false],
    ['Quick Article', {wildcard: '*Art*'}, true], [GUID.toUpperCase(), {eq: KEY}, true],
    [['News', 'Technology'], {eq: 'News'}, true], [[], {exist: false}, true],
    [null, {exist: true}, false], [0, {exist: true}, true], [false, {eq: false}, true],
    ['x', {eq: null}, true],
  ];
  for (const [value, filter, expected] of cases) assert.equal(matchFilter(value, filter).match, expected, JSON.stringify({value, filter}));
  assert.equal(comparable('AB-CD'), 'AB-CD');
  assert.equal(matchFilter('Quick quick Article', {match: 'qui art', boost: 10}).score, 20);
});

test('numeric/date comparisons, factor and decay wire inputs', () => {
  assert.equal(matchFilter(7, {gt: 6, gte: 7, lt: 8, lte: 7}).match, true);
  assert.equal(matchFilter(7, {in: [7, 8]}).match, true);
  assert.equal(matchFilter(7, {notIn: [7]}).match, false);
  assert.equal(matchFilter('2026-10-13T00:00:00Z', {gt: '2026-10-12T00:00:00-02:00'}).match, true);
  assert.equal(matchFilter('2026-10-13T00:00:00Z', {lt: '2026-10-12T00:00:00Z'}).match, false);
  assert.equal(matchFilter(4, {factor: {value: 2, modifier: 'SQUARE'}}).score, 64);
  assert.equal(matchFilter('2026-10-13T00:00:00Z', {decay: {origin: '2026-10-12T00:00:00Z', scale: 1, rate: 0.5}}).score, 0.5);
});

test('nested where, logical list coercion, lists and skipped fields', async t => {
  const {gql, seed} = await gateway(t); await seed();
  const cases = [
    ['{_and:{Tags:{eq:"News"},Number:{gte:7,lte:7}},_not:{Visible:{eq:false}}}', 1],
    ['{_or:[{Number:{lt:1}},{Rating:{gt:1}}]}', 1],
    ['{_not:[{Tags:{eq:"News"}}]}', 0],
    ['{Related:{url:{default:{contains:"RELATED"}}}}', 1],
    ['{ContentArea:{_metadata:{key:{eq:"blockkey"}}}}', 1],
    ['{ContentArea:{_metadata:{key:{eq:"missing"}}}}', 0],
    ['{Unindexed:{eq:"secret unsearchable"}}', 0],
    ['{Heading:{exist:true}}', 1],
    ['{_modified:{gte:"2026-10-13T00:00:00Z"}}', 1],
    ['{_metadata:{key:{eq:null}}}', 1],
  ];
  for (const [where, total] of cases) assert.equal(success(await gql(`{ArticlePage(where:${where}){total}}`), 'ArticlePage').total, total, where);
});

test('fulltext extracts marked fields and rich HTML; boost, relevance and highlighting', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('less', document({metadata: {displayName___searchable: 'Other'}, _itemMetadata: {displayName___searchable: 'Other'}, 'Heading$$String___searchable': 'nothing', MainBody: {__typename: 'SearchableRichText', 'html$$String': '<b>quick</b>'}}))});
  const result = success(await gql('{ArticlePage(where:{_fulltext:{match:"quick",boost:3}},orderBy:{_ranking:RELEVANCE}){items{_id _score _track _fulltext(highlight:{startToken:"[",endToken:"]"})}}}'), 'ArticlePage');
  assert.equal(result.items[0]._id, ID); assert.ok(result.items[0]._score > result.items[1]._score); assert.equal(result.items[0]._track, null);
  assert.ok(result.items[0]._fulltext.some(s => s.includes('[Quick]')));
  assert.ok(result.items[0]._fulltext.every(s => !s.includes('<p>')));
  const unhighlighted = success(await gql('{ArticlePage(where:{_fulltext:{match:"rés"}}){items{_fulltext(highlight:{enabled:false})}}}'), 'ArticlePage');
  assert.ok(unhighlighted.items[0]._fulltext.some(s => s.includes('Résumé')));
  for (const query of ['secret', 'unsearchable', 'Stored']) assert.equal(success(await gql(`{ArticlePage(where:{_fulltext:{match:"${query}"}}){total}}`), 'ArticlePage').total, 0);
});

test('ordering retains caller field positions, variables, score threshold and stable ties', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('alphabet', document({metadata: {displayName___searchable: 'A'}, _itemMetadata: {}, 'Heading$$String___searchable': 'quick', MainBody: null})) + index('recent', document({metadata: {displayName___searchable: 'Z', lastModified: '2026-10-14T00:00:00Z'}, _itemMetadata: {}, 'Heading$$String___searchable': 'quick', MainBody: null}))});
  const order = 'query($order:ArticlePageOrderByInput){ArticlePage(where:{_fulltext:{match:"quick"}},orderBy:$order){items{_id}}}';
  const rankFirst = success(await gql(order, {order: {_ranking: 'RELEVANCE', _metadata: {displayName: 'ASC'}}}), 'ArticlePage');
  assert.equal(rankFirst.items[0]._id, ID);
  const nameFirst = success(await gql(order, {order: {_metadata: {displayName: 'ASC'}, _ranking: 'RELEVANCE'}}), 'ArticlePage');
  assert.equal(nameFirst.items[0]._id, 'alphabet');
  assert.equal(success(await gql('{ArticlePage(where:{_fulltext:{match:"quick"}},orderBy:{_metadata:{displayName:ASC},_ranking:RELEVANCE}){items{_id}}}'), 'ArticlePage').items[0]._id, 'alphabet');
  assert.equal(success(await gql('{ArticlePage{items{_id}}}'), 'ArticlePage').items[0]._id, 'recent');
  assert.equal(success(await gql('{ArticlePage(where:{_fulltext:{match:"quick"}},orderBy:{_minimumScore:2}){total}}'), 'ArticlePage').total, 1);
  assert.equal(success(await gql('{ArticlePage(orderBy:{Number:ASC}){items{_id}}}'), 'ArticlePage').items[0]._id, ID);
});

test('number/date/bool/list facets, distinct counts, sort, ranges and word autocomplete', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('two', document({'Number$$Int': 12, 'Visible$$Boolean': false, 'Tags$$String': ['News', 'News'], metadata: {displayName___searchable: 'An Article', lastModified: '2026-10-14T00:00:00Z'}}))});
  const result = success(await gql('{ArticlePage(limit:1){facets{Tags(orderType:VALUE,orderBy:ASC,limit:10){name count} Visible{ name count } Number(ranges:[{from:0,to:10},{from:10,to:20}]){name count} _metadata{lastModified(unit:DAY,value:1,orderType:VALUE,orderBy:ASC){name count}}} autocomplete{_metadata{displayName(value:"Art",limit:10)}}}}'), 'ArticlePage');
  assert.deepEqual(result.facets.Tags, [{name: 'News', count: 2}, {name: 'Technology', count: 1}]);
  assert.deepEqual(result.facets.Number, [{name: '0-10', count: 1}, {name: '10-20', count: 1}]);
  assert.deepEqual(result.facets._metadata.lastModified, [{name: '2026-10-13T00:00:00.000Z', count: 1}, {name: '2026-10-14T00:00:00.000Z', count: 1}]);
  assert.equal(result.facets.Visible.length, 2); assert.equal(result.autocomplete._metadata.displayName.length, 2);
});

test('normalization recursively blocks searchable descendants inside skip objects', () => {
  const record = normalizeDocument({'Object$$JSON___skip': {'nested$$String___searchable': 'hidden'}, Some: [{__typename: 'SearchableRichText', 'html$$String': '<p>found</p>'}]}, 'id');
  assert.deepEqual(record.searchable, ['Some.html']); assert.ok(record.skipped.includes('Object.nested')); assert.equal(record.normalized.Some[0].__typename, 'SearchableRichText');
});

test('null predicates do not broaden OR branches and skipped fields cannot autocomplete', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('other', document({metadata: {displayName___searchable: 'Other'}}))});
  const result = success(await gql('query($key:String){ArticlePage(where:{_or:[{_metadata:{key:{eq:$key}}},{_metadata:{displayName:{eq:"Quick Article"}}}]}){items{_id}}}', {key: null}), 'ArticlePage');
  assert.deepEqual(result.items.map(d => d._id), [ID]);
  const skipped = success(await gql('{ArticlePage{autocomplete{Unindexed(value:"secret")}facets{Unindexed{name count}}}}'), 'ArticlePage');
  assert.deepEqual(skipped.autocomplete.Unindexed, []); assert.deepEqual(skipped.facets.Unindexed, []);
});

test('default orderBy variables retain priority when omitted in the request', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_stream', {method: 'POST', body: index('first', document({metadata: {displayName___searchable: 'A', lastModified: '2000-01-01T00:00:00Z'}}))});
  const result = success(await gql('query($order:ArticlePageOrderByInput={_metadata:{displayName:ASC}}){ArticlePage(orderBy:$order){items{_id}}}'), 'ArticlePage');
  assert.equal(result.items[0]._id, 'first');
});
