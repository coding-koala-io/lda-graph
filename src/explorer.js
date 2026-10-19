/* Content explorer: a read-only, server-rendered browser for one tenant's slot.
 * Counts and listings come from the store; full-text search runs the tenant's own GraphQL schema.
 */
import {graphql, getNamedType, isLeafType, isObjectType, isInterfaceType, isNonNullType} from 'graphql';
import {escapeHtml as e} from './graphiql.js';
import {page, pre, link, table, hidden, number, badge, timestamp, tenantPath} from './dashboard.js';
import {stats, ownValue} from './dashboard-data.js';

const PAGE_SIZE = 50;
const SYSTEM = new Set(['_id', '__typename', '_metadata', '_itemMetadata', '_rbac', '_modified', '_deleted']);
const SEARCH = `query ExplorerSearch($q: String, $limit: Int, $skip: Int) {
  _Content(where: {_fulltext: {match: $q}}, variation: {include: ALL}, orderBy: {_ranking: RELEVANCE}, limit: $limit, skip: $skip) {
    total items { _id __typename _metadata { displayName locale status version lastModified } }
  }
}`;
const url = (params, changes = {}) => {
  const query = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) { if (value == null || value === '') query.delete(key); else query.set(key, value); }
  return '/explorer?' + query;
};
const pageNumber = (params, total) => {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE)); const value = Math.trunc(Number(params.get('page') ?? 1));
  return {current: Number.isFinite(value) ? Math.max(1, Math.min(last, value)) : 1, last};
};
const pager = (params, {current, last}) => `<p>${current > 1 ? link(url(params, {page: current - 1}), 'Previous 50') : ''} ${current < last ? link(url(params, {page: current + 1}), 'Next 50') : ''}</p>`;
const select = (name, label, values, current) => `<label>${e(label)}<br><select name="${name}"><option value="">All</option>${values.map(value => `<option value="${e(value)}"${value === current ? ' selected' : ''}>${e(value || '(none)')}</option>`).join('')}</select></label>`;
const summary = doc => ({id: doc._id, type: doc.__typename ?? '', displayName: doc._metadata?.displayName, locale: doc._metadata?.locale ?? '', status: doc._metadata?.status ?? '', version: doc._metadata?.version, lastModified: doc._metadata?.lastModified});
const itemRow = (base, doc, withType) => [link(url(base, {id: doc.id}), doc.displayName ?? doc.id), ...(withType ? [e(doc.type)] : []), e(doc.locale), badge(doc.status), e(doc.version ?? ''), timestamp(doc.lastModified)];

export function explorerPickerHtml(registry) {
  const rows = registry.entries.map(tenant => [link('/explorer?tenant=' + encodeURIComponent(tenant.id), tenant.name), `<code>${e(tenant.id)}</code>`, registry.get(tenant.id, false).store ? number(stats(registry.get(tenant.id, false)).docs) : 'not loaded']);
  return page('Content explorer', `<p>${link('/', 'Dashboard')} · ${link('/graphiql', 'GraphiQL')}</p><p>Choose an instance to browse.</p>${table(['Instance', 'ID', 'Count'], rows)}`);
}

export async function explorerHtml(runtime, params) {
  const tenant = runtime.tenant; const hasNew = Boolean(runtime.store.state.slots.new);
  const slot = hasNew && params.get('slot') === 'new' ? 'new' : 'live';
  const base = {tenant: tenant.id, ...(slot === 'new' ? {slot: 'new'} : {})};
  const docs = runtime.store.slot(slot).docs;
  const graphiqlUrl = '/graphiql?' + new URLSearchParams(base);
  const toggle = hasNew ? `<p>Slot: ${slot === 'live' ? '<strong>live</strong>' : link(url({tenant: tenant.id}), 'live')} · ${slot === 'new' ? '<strong>new</strong>' : link(url({tenant: tenant.id, slot: 'new'}), 'new')}</p>` : '';
  const search = `<form method="get" action="/explorer"><div class="fields">${hidden('tenant', tenant.id)}${slot === 'new' ? hidden('slot', 'new') : ''}<label>Search all content<br><input type="search" name="q" value="${e(params.get('q') ?? '')}"></label><button>Search</button></div></form>`;
  const header = `<p>${link('/', 'Dashboard')} · ${link(tenantPath(tenant.id), tenant.name + ' dashboard')} · ${link(graphiqlUrl, 'GraphiQL')} · ${link(url(base), 'All content types')}</p>${toggle}${search}`;
  const title = text => `${text} · ${tenant.name}${slot === 'new' ? ' (new slot)' : ''}`;

  const id = params.get('id');
  if (id != null) {
    const record = ownValue(docs, id);
    if (!record) return {status: 404, html: page(title('Item not found'), `${header}<p class="error">No item with ID <code>${e(id)}</code> in the ${slot} slot.</p>`)};
    return {status: 200, html: page(title(record.normalized._metadata?.displayName ?? id), header + detailHtml(runtime, record, docs, base, slot))};
  }

  const q = params.get('q')?.trim();
  if (q) {
    const requested = Number(params.get('page') ?? 1);
    const skip = (Number.isFinite(requested) && requested > 1 ? Math.trunc(requested) - 1 : 0) * PAGE_SIZE;
    const result = await graphql({schema: runtime.schemas[slot], source: SEARCH, variableValues: {q, limit: PAGE_SIZE, skip}, contextValue: {headers: {}, auth: 'basic', slot, variables: {q, limit: PAGE_SIZE, skip}}});
    if (result.errors?.length) return {status: 200, html: page(title('Search'), `${header}<p class="error" role="alert">${e(result.errors.map(error => error.message).join('; '))}</p>`)};
    const found = result.data._Content; const paging = pageNumber(params, found.total ?? 0);
    const rows = (found.items ?? []).filter(Boolean).map(item => itemRow(base, summary(item), true));
    return {status: 200, html: page(title(`Search: ${q}`), `${header}<p>${(found.total ?? 0).toLocaleString('en-US')} matching items (all statuses) · page ${paging.current} of ${paging.last}</p>${table(['Display name', 'Type', 'Locale', 'Status', 'Version', 'Last modified'], rows)}${pager({...base, q}, paging)}`)};
  }

  const all = Object.values(docs).map(record => summary(record.normalized));
  const type = params.get('type');
  if (type) {
    const ofType = all.filter(doc => doc.type === type);
    const locale = params.get('locale') ?? ''; const status = params.get('status') ?? '';
    const filtered = ofType.filter(doc => (!locale || doc.locale === locale) && (!status || doc.status === status))
      .sort((a, b) => String(a.displayName ?? a.id).localeCompare(String(b.displayName ?? b.id)) || a.id.localeCompare(b.id));
    const paging = pageNumber(params, filtered.length); const listParams = {...base, type, ...(locale ? {locale} : {}), ...(status ? {status} : {})};
    const distinct = key => [...new Set(ofType.map(doc => doc[key]))].sort();
    const filters = `<form method="get" action="/explorer"><div class="fields">${hidden('tenant', tenant.id)}${slot === 'new' ? hidden('slot', 'new') : ''}${hidden('type', type)}${select('locale', 'Locale', distinct('locale'), locale)}${select('status', 'Status', distinct('status'), status)}<button>Filter</button></div></form>`;
    const rows = filtered.slice((paging.current - 1) * PAGE_SIZE, paging.current * PAGE_SIZE).map(doc => itemRow(base, doc, false));
    return {status: 200, html: page(title(type), `${header}${filters}<p>${filtered.length.toLocaleString('en-US')} items · page ${paging.current} of ${paging.last}</p>${table(['Display name', 'Locale', 'Status', 'Version', 'Last modified'], rows)}${pager(listParams, paging)}`)};
  }

  const counts = new Map();
  const definitions = new Map();
  const models = runtime.store.slot(slot).types;
  for (const model of [models.default, ...Object.entries(models).filter(([id]) => id !== 'default').map(([, model]) => model)]) {
    for (const [name, definition] of Object.entries(model?.contentTypes ?? {})) if (!definitions.has(name)) definitions.set(name, definition);
  }
  for (const [name, definition] of definitions) if (!definition?.abstract) counts.set(name, 0);
  for (const doc of all) counts.set(doc.type, (counts.get(doc.type) ?? 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => [count ? link(url(base, {type: name}), name || '(no type)') : e(name), number(count)]);
  return {status: 200, html: page(title('Content explorer'), `${header}<p>${all.length.toLocaleString('en-US')} items in the ${slot} slot.</p>${table(['Content type', 'Count'], rows)}`)};
}

function detailHtml(runtime, record, docs, base, slot) {
  const doc = record.normalized; const meta = doc._metadata ?? {};
  const byKey = key => {
    const matches = Object.values(docs).filter(other => other.normalized._metadata?.key === key);
    return (matches.find(other => other.normalized._metadata?.locale === meta.locale) ?? matches[0])?.normalized._id;
  };
  const target = value => {
    if (typeof value?.item === 'string' && ownValue(docs, value.item)) return value.item;
    return typeof value?.key === 'string' ? byKey(value.key) : undefined;
  };
  const render = (value, depth = 0) => {
    if (value == null) return '<span class="muted">null</span>';
    if (typeof value !== 'object') return `<span class="value">${e(value)}</span>`;
    if (Array.isArray(value)) return value.length ? `<ol>${value.map(item => `<li>${render(item, depth + 1)}</li>`).join('')}</ol>` : '<span class="muted">empty list</span>';
    if (value.__typename === 'ContentReference' || (('key' in value || 'item' in value) && 'url' in value)) {
      const id = target(value); const text = value.key ?? value.item ?? value.url?.default ?? 'reference';
      return `Reference ${id ? link(url(base, {id}), text) : `<code>${e(text)}</code>`}${value.url?.default ? ` <span class="muted">${e(value.url.default)}</span>` : ''}`;
    }
    if (typeof value.html === 'string') return `<span class="muted">${e(value.__typename ?? 'Rich text')}</span><pre>${e(value.html)}</pre>`;
    if (depth > 3) return pre(value);
    const entries = Object.entries(value).filter(([key]) => key !== '__typename');
    return `${value.__typename ? `<span class="muted">${e(value.__typename)}</span>` : ''}<dl>${entries.map(([key, child]) => `<dt>${e(key)}</dt><dd>${render(child, depth + 1)}</dd>`).join('')}</dl>`;
  };
  const metadata = [['_id', doc._id], ['Type', doc.__typename], ...Object.entries(meta).filter(([key]) => key !== '__typename'), ['_rbac', doc._rbac], ['_modified', doc._modified], ['_deleted', doc._deleted]];
  const properties = Object.entries(doc).filter(([key]) => !SYSTEM.has(key));
  const query = graphiqlQuery(runtime.schemas[slot], doc);
  const graphiql = '/graphiql?' + new URLSearchParams({tenant: runtime.tenant.id, query, ...(slot === 'new' ? {slot: 'new'} : {})});
  return `<p><a class="button" href="${e(graphiql)}">Open in GraphiQL</a> · ${link(url(base, {type: doc.__typename}), 'All ' + (doc.__typename ?? 'items'))}</p>
<h2>Metadata</h2>${table(['Field', 'Value'], metadata.map(([key, value]) => [e(key), value != null && typeof value === 'object' ? `<code>${e(JSON.stringify(value))}</code>` : e(value ?? '')]))}
<h2>Properties</h2>${properties.length ? `<dl>${properties.map(([key, value]) => `<dt>${e(key)}</dt><dd>${render(value)}</dd>`).join('')}</dl>` : '<p>No properties.</p>'}
<h2>Raw JSON</h2>${pre(record.raw)}`;
}

/** A ready query for one item by key and locale, selecting its typed fields a few levels deep. */
export function graphiqlQuery(schema, doc) {
  const fields = schema.getQueryType().getFields();
  const root = doc.__typename && fields[doc.__typename] ? doc.__typename : '_Content';
  const itemType = getNamedType(fields[root].type.getFields().items.type);
  const selection = (type, depth) => {
    const named = getNamedType(type);
    if (isLeafType(named)) return '';
    if (depth > 2 || !(isObjectType(named) || isInterfaceType(named))) return ' { __typename }';
    const children = Object.values(named.getFields()).filter(field => !['_fulltext', '_track', '_link', '_score'].includes(field.name) && !field.args.some(arg => isNonNullType(arg.type)));
    return ` { ${children.map(field => field.name + selection(field.type, depth + 1)).join(' ') || '__typename'} }`;
  };
  const where = [`key: { eq: ${JSON.stringify(String(doc._metadata?.key ?? ''))} }`, ...(doc._metadata?.locale ? [`locale: { eq: ${JSON.stringify(doc._metadata.locale)} }`] : [])].join(', ');
  return `{\n  ${root}(where: { _metadata: { ${where} } }, variation: { include: ALL }) {\n    total\n    items${selection(itemType, 0)}\n  }\n}`;
}
