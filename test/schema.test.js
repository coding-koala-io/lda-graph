import test from 'node:test';
import assert from 'node:assert/strict';
import {graphql, validateSchema, printSchema} from 'graphql';
import {buildSchema} from '../src/schema.js';
import {Store} from '../src/store.js';
import {MODEL, document, ID} from './fixtures.js';
import {quiet, gateway, success} from './helpers.js';

test('transitive content interfaces and abstract roots with no implementer are valid', () => {
  const store = new Store({dataDir: ':memory:'});
  const schema = buildSchema(MODEL, store, {logger: quiet});
  assert.deepEqual(validateSchema(schema), []);
  assert.deepEqual(schema.getType('ArticlePage').getInterfaces().map(t => t.name), ['_IPage', '_IContent', '_IItem', 'IData']);
  assert.ok(schema.getPossibleTypes(schema.getType('_IImage')).length);
  assert.ok(schema.getType('IContentMetadata'));
});

test('odd names, duplicates, reserved introspection names, unknown refs and nullable required data', async () => {
  const store = new Store({dataDir: ':memory:'});
  const model = structuredClone(MODEL);
  model.contentTypes['Odd-name'] = {contentType: ['_Page'], properties: {'invalid field': {type: 'Mystery!'}, Required: {type: 'String!'}}};
  model.contentTypes.Odd_name = {properties: {duplicate: {type: 'String'}}};
  model.contentTypes['123'] = {abstract: true, properties: {}};
  model.contentTypes.__Reserved = {properties: {__bad: {type: 'JSON'}}};
  const errors = [];
  const schema = buildSchema(model, store, {logger: {error: m => errors.push(m)}});
  assert.deepEqual(errors, []); assert.deepEqual(validateSchema(schema), []);
  assert.ok(schema.getQueryType().getFields().Odd_name);
  store.upsert('odd', document({__typename: 'Odd-name', metadata: {types: ['Odd-name', '_Content']}, 'invalid field$$Mystery': {value: 42}}));
  const response = await graphql({schema, source: '{Odd_name{items{invalid_field Required}}}', contextValue: {auth: 'basic'}});
  assert.equal(response.errors, undefined); assert.deepEqual(JSON.parse(JSON.stringify(response.data.Odd_name.items)), [{invalid_field: {value: 42}, Required: null}]);
});

test('invalid interface overrides preserve previous schema and log rejection', () => {
  const store = new Store({dataDir: ':memory:'});
  const previous = buildSchema(MODEL, store, {logger: quiet});
  const broken = structuredClone(MODEL);
  broken.contentTypes._Page.properties.Heading = {type: 'String'};
  broken.contentTypes.ArticlePage.properties.Heading = {type: 'Int'};
  const errors = [];
  const next = buildSchema(broken, store, {previous, logger: {error: m => errors.push(m)}});
  assert.equal(next, previous); assert.equal(errors.length, 1);
  assert.match(errors[0], /Schema rebuild rejected/);
  assert.doesNotThrow(() => buildSchema({contentTypes: {Invalid: {abstract: true, properties: null}}, propertyTypes: {}}, store, {logger: quiet}));
});

test('unknown __typename resolves fallback; missing metadata typename defaults to InstanceMetadata', async t => {
  const {request, gql, seed} = await gateway(t); await seed();
  await request('/_doc/unknown', {method: 'POST', body: document({__typename: 'NotInSchema', metadata: {__typename: 'NotMetadata'}})});
  await request('/_doc/default', {method: 'POST', body: document({metadata: {__typename: undefined}})});
  const result = success(await gql('{_Content(orderBy:{_id:ASC}){items{_id __typename _metadata{__typename displayName}}}}'), '_Content');
  assert.equal(result.items.find(d => d._id === 'unknown').__typename, '_ContentGeneric');
  assert.equal(result.items.find(d => d._id === 'unknown')._metadata.__typename, '_ContentMetadataGeneric');
  assert.equal(result.items.find(d => d._id === 'default')._metadata.__typename, 'InstanceMetadata');
  assert.equal(result.items.find(d => d._id === ID).__typename, 'ArticlePage');
});

test('self-referential property types and abstract property interfaces build without recursion errors', () => {
  const store = new Store({dataDir: ':memory:'});
  const model = structuredClone(MODEL);
  model.propertyTypes.Node = {abstract: true, properties: {label: {type: 'String'}, child: {type: 'INode'}}};
  model.propertyTypes.Branch = {base: 'Node', properties: {count: {type: 'Int'}}};
  model.contentTypes.ArticlePage.properties.Tree = {type: 'INode'};
  const errors = [];
  const schema = buildSchema(model, store, {logger: {error: m => errors.push(m)}});
  assert.deepEqual(errors, []); assert.deepEqual(validateSchema(schema), []);
  assert.match(printSchema(schema), /interface INode/);
});
