import {printSchema} from 'graphql';
import {constantEqual} from './tenants.js';
import {generateTenant} from './tenant-create.js';
import {parseJson} from './http-utils.js';
import {stats, jobs, documents, clearTenant, ownValue} from './dashboard-data.js';
import {dashboardHtml, tenantHtml, tenantForm, tenantPath, page, documentHtml, requestHtml, jobHtml, journalHtml, confirmationHtml, defaultKeysHtml} from './dashboard.js';

const actions = new Set(['content', 'types', 'jobs', 'requests', 'all', 'delete']);
/** Admin routes run only after host/origin and independent admin authentication. */
export async function handleDashboard({path, method, url, text, headers, registry, token, send, redirect, host, diagnostic, runtime, legacyReset}) {
  const html = (body, status = 200) => send(status, body, 'text/html; charset=utf-8');
  const form = () => Object.fromEntries(new URLSearchParams(text));
  const checkCsrf = values => {
    if (!values.csrf || !constantEqual(values.csrf, token)) { send(403, {message: 'Invalid or missing CSRF token'}); return false; }
    return true;
  };
  if (method === 'GET' && path === '/') return html(dashboardHtml(registry, token, url.searchParams.get('flash')));
  if (path === '/tenants' && method === 'POST') {
    const values = form(); if (!checkCsrf(values)) return true;
    try {
      let tenant;
      await registry.edit(entries => {
        tenant = generateTenant(values.name, entries, undefined, id => registry.folderExists(id));
        return [...entries, tenant];
      });
      return redirect(tenantPath(tenant.id) + '?created=1&flash=' + encodeURIComponent('Instance created — copy these settings into the CMS appsettings.Development.json') + '#connect');
    } catch (error) { return html(dashboardHtml(registry, token, '', error.message, values), 400); }
  }
  if (!runtime) return false;
  const base = tenantPath(runtime.tenant.id); const route = path.slice(base.length) || '/';
  const slot = ['cg-query-new', 'cg-use-new'].some(name => headers[name]?.toLowerCase() === 'true') || url.searchParams.get('slot') === 'new' ? 'new' : 'live';
  const store = runtime.store;
  if (method === 'GET') {
    if (route === '/') return html(tenantHtml(runtime, registry, token, host, url.searchParams));
    if (route === '/stats') return send(200, stats(runtime));
    if (route === '/edit') return html(page('Edit tenant', registry.defaultNeedsKeys && runtime.tenant.id === 'default' ? defaultKeysHtml(registry, token) : tenantForm(runtime.tenant, token, '', true)));
    if (route === '/docs') return send(200, documents(runtime, url.searchParams, slot));
    if (route.startsWith('/docs/') || route.startsWith('/documents/')) {
      const id = decodeURIComponent(route.slice(route.startsWith('/docs/') ? 6 : 11));
      const record = ownValue(store.slot(slot).docs, id);
      if (!record) return send(404, {message: 'Document not found'});
      return route.startsWith('/documents/') ? html(documentHtml(runtime, record, slot)) : send(200, {raw: record.raw, normalized: record.normalized});
    }
    if (route === '/types') return send(200, store.slot(slot).types.default ?? {});
    if (route === '/schema') return send(200, printSchema(runtime.schemas[slot]), 'text/plain; charset=utf-8');
    if (route === '/jobs') return send(200, jobs(runtime, 200));
    if (route.startsWith('/journals/')) {
      const id = decodeURIComponent(route.slice(10)); const journal = ownValue(store.state.journals, id);
      if (!journal) return send(404, {message: 'Journal not found'});
      return url.searchParams.get('view') === 'html' ? html(page('Journal ' + id, journalHtml(runtime, id, journal))) : send(200, journal);
    }
    if (route.startsWith('/sync/')) {
      const job = jobs(runtime).find(job => job.id === decodeURIComponent(route.slice(6)));
      return job ? html(jobHtml(runtime, job)) : send(404, {message: 'Job not found'});
    }
    if (route === '/requests') {
      const value = Number(url.searchParams.get('limit') ?? 50);
      const limit = Number.isFinite(value) ? Math.max(0, Math.min(500, Math.trunc(value))) : 50;
      return send(200, limit ? runtime.log.recent.slice(-limit) : []);
    }
    if (route.startsWith('/requests/') || route.startsWith('/request/')) {
      const n = Number(route.split('/')[2]); const entry = runtime.log.recent.find(entry => entry.n === n);
      if (!entry) return send(404, {message: 'Request not found'});
      return route.startsWith('/request/') ? html(requestHtml(runtime, entry)) : send(200, entry);
    }
  }
  if (method === 'POST') {
    if (route === '/clear' && /^application\/json(?:;|$)/i.test(headers['content-type'] ?? '')) {
      const removed = clearTenant(runtime, parseJson(text)?.what);
      if ('requests' in removed) diagnostic.suppressTenantLog = true;
      return send(200, {removed});
    }
    if (route === '/reset' && legacyReset && /^application\/json(?:;|$)/i.test(headers['content-type'] ?? 'application/json')) {
      clearTenant(runtime, ['all']); diagnostic.suppressTenantLog = true; return send(200, {});
    }
    const values = form(); if (!checkCsrf(values)) return true;
    if (route === '/edit') {
      const oldId = runtime.tenant.id;
      try {
        await registry.edit(entries => entries.map(entry => entry.id === oldId ? Object.fromEntries(['id', 'name', 'appKey', 'singleKey', 'secret'].map(key => [key, values[key] ?? ''])) : entry), {initializeDefault: registry.defaultNeedsKeys && oldId === 'default', renameFrom: oldId});
        return redirect(tenantPath(values.id) + '?flash=' + encodeURIComponent(values.id === oldId ? 'Tenant configuration updated' : 'Tenant ID changed; data and logs folders moved'));
      } catch (error) { return html(page('Edit tenant', registry.defaultNeedsKeys && oldId === 'default' ? defaultKeysHtml(registry, token, error.message, values) : tenantForm({...runtime.tenant, ...values, id: oldId}, token, error.message, true)), 400); }
    }
    if (route === '/import') {
      try { await registry.importLegacy(runtime.tenant.id); return redirect(base + '?flash=' + encodeURIComponent('Root-level legacy store imported')); }
      catch (error) { return html(page('Import failed', `<p class="error">${escapeText(error.message)}</p>`), 400); }
    }
    if (!actions.has(values.action)) return send(400, {message: 'Unknown action'});
    if (route === '/confirm') return html(confirmationHtml(runtime.tenant, token, values.action));
    if (route === '/clear' || route === '/delete') {
      if ((route === '/delete') !== (values.action === 'delete')) return send(400, {message: 'Action does not match route'});
      if (values.confirm !== runtime.tenant.id) return html(confirmationHtml(runtime.tenant, token, values.action, 'Tenant ID does not match. Type the exact tenant ID to confirm.'), 400);
      if (values.action === 'delete') {
        const id = runtime.tenant.id; let removed = {};
        runtime.busy = true;
        try {
          await registry.edit(entries => entries.filter(entry => entry.id !== id));
          if (values.deleteFolders === 'yes') { removed = clearTenant(runtime, ['all']); await registry.deleteFolders(id, runtime); }
        } finally { runtime.busy = false; }
        diagnostic.suppressTenantLog = true;
        return redirect('/?flash=' + encodeURIComponent(`Tenant ${id} removed; ${values.deleteFolders === 'yes' ? 'data and logs folders deleted; ' + removalText(removed) : 'data and logs folders retained'}`));
      }
      const removed = clearTenant(runtime, [values.action]);
      if ('requests' in removed) diagnostic.suppressTenantLog = true;
      return redirect(base + '?flash=' + encodeURIComponent('Removed ' + removalText(removed)));
    }
  }
  return false;
}
const removalText = removed => Object.entries(removed).map(([key, value]) => `${value.toLocaleString('en-US')} ${{contentTypes: 'content types', propertyTypes: 'property types'}[key] ?? key}`).join(', ');
const escapeText = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
