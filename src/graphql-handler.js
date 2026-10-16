import {randomUUID} from 'node:crypto';
import {parse, validate, execute, getOperationAST, getVariableValues} from 'graphql';
import {collectFields} from 'graphql/execution/collectFields.js';
import {parseJson} from './http-utils.js';

export async function handleGraphql({method, text, url, crossOrigin, schemas, querySlot, queryHeaders, auth, send, diagnostic}) {
  const body = method === 'POST' ? parseJson(text) : {query: url.searchParams.get('query'), variables: url.searchParams.get('variables'), operationName: url.searchParams.get('operationName')};
  const correlationId = randomUUID();
  const reply = result => send(200, {...result, extensions: {...result.extensions, correlationId}});
  if (!body || typeof body.query !== 'string') return reply({errors: [{message: 'A GraphQL query string is required'}]});
  let variables;
  try {
    variables = (typeof body.variables === 'string' ? JSON.parse(body.variables) : body.variables) ?? {};
    if (typeof variables !== 'object' || Array.isArray(variables)) throw new Error('Variables must be an object');
  } catch (error) { return reply({errors: [{message: `Invalid variables: ${error.message}`}]}); }
  let document;
  try { document = parse(body.query); } catch (error) { return reply({errors: [error.toJSON()]}); }
  const operation = getOperationAST(document, body.operationName);
  if (crossOrigin && operation?.operation === 'mutation') return send(403, {message: 'Cross-origin mutations are forbidden'});
  const errors = validate(schemas[querySlot], document);
  if (errors.length) return reply({errors: errors.map(error => error.toJSON())});
  // Logging must never change GraphQL's validation/coercion response.
  try { if (operation) {
    const fragments = Object.fromEntries(document.definitions.filter(d => d.kind === 'FragmentDefinition').map(d => [d.name.value, d]));
    const root = operation.operation === 'mutation' ? schemas[querySlot].getMutationType() : schemas[querySlot].getQueryType();
    const coerced = getVariableValues(schemas[querySlot], operation.variableDefinitions ?? [], variables);
    if (!coerced.errors) {
      const fields = collectFields(schemas[querySlot], fragments, coerced.coerced, root, operation.selectionSet);
      diagnostic.root = [...new Set([...fields.values()].map(nodes => nodes[0].name.value))].join(',');
    }
  } } catch { /* best-effort diagnostic only */ }
  const result = await execute({schema: schemas[querySlot], document, variableValues: variables, operationName: body.operationName ?? undefined, contextValue: {headers: queryHeaders, auth, slot: querySlot, variables}});
  return reply(result);
}
