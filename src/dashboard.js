/* Operate: extend the existing plain developer dashboard with a tenant directory,
 * readable tables and native forms. System type, white surfaces, blue links;
 * the first viewport identifies the tenant and exposes connection details.
 * Data and state lead every section. Destructive actions use a separate page.
 */
import {banner, footer, chromeStyle, productHeader} from './product-ui.js';
import {printSchema} from 'graphql';
import {randomBytes} from 'node:crypto';
import {escapeHtml as e} from './graphiql.js';
import {stats, documents, jobs} from './dashboard-data.js';
import {processMemory} from './process-memory.js';
export const tenantPath = id => `/tenants/${encodeURIComponent(id)}`;
export const pre = value => `<pre>${e(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
export const link = (href, text) => `<a href="${e(href)}">${e(text)}</a>`;
export const table = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map(head => `<th scope="col"${['Docs', 'Content types', 'Count', 'Journals', 'Indexed', 'Deleted', 'Failed', 'Ops', 'Duration', 'Store size'].includes(head) ? ' class="numeric"' : ''}>${e(head)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${heads.length}">No entries yet.</td></tr>`}</tbody></table></div>`;
export const hidden = (name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
const formattedBody = value => {
  if (typeof value !== 'string') return pre(value);
  try { return pre(JSON.parse(value)); } catch { /* NDJSON or plain text */ }
  const lines = value.split('\n').filter(line => line.trim());
  if (lines.length > 1 && lines.some(line => { try { return typeof JSON.parse(line) === 'object'; } catch { return false; } })) {
    return lines.map((line, n) => { let parsed = line; try { parsed = JSON.parse(line); } catch { /* preserve malformed/truncated line */ } return `<p class="muted">NDJSON · line ${n + 1}</p>${pre(parsed)}`; }).join('');
  }
  return pre(value);
};
const csrf = token => hidden('csrf', token);
export const number = value => `<span class="number">${e(Number(value).toLocaleString('en-US'))}</span>`;
const bytes = value => value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} bytes`;
export const badge = value => `<span class="badge ${value === 'Success' ? 'success' : value === 'Error' ? 'failure' : 'neutral'}">${e(value ?? '')}</span>`;
export const timestamp = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return e(value ?? 'Never');
  const iso = new Date(value).toISOString();
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  const relative = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
  return `<time datetime="${e(iso)}" title="${e(iso)}">${e(new Date(value).toLocaleString())} · ${relative}</time>`;
};
const masked = key => `<details><summary>•••••••• (reveal)</summary><code>${e(key)}</code></details>`;

export function page(title, body, flash = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · LDA Local Graph</title>
<style>${chromeStyle}body{font:16px/1.5 system-ui,sans-serif;max-width:1400px;margin:32px auto;padding:0 24px;color:#18242c;background:#fff}h1{overflow-wrap:anywhere;font-size:2rem;line-height:1.2}h2{margin-top:40px}h3{margin-top:24px}a{color:#07599e}a:hover{text-decoration-thickness:2px}nav{display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid #bcc7cf;padding:12px 0}table{border-collapse:collapse;width:100%}th,td{overflow-wrap:anywhere;padding:10px 12px;text-align:left;border-bottom:1px solid #d5dde3;vertical-align:top}th{background:#f1f5f7}tbody tr:hover{background:#f7fafc}.table-wrap{overflow:auto;margin:16px 0}pre{background:#f1f5f7;padding:16px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}code{overflow-wrap:anywhere}form{margin:16px 0}.fields{display:flex;flex-wrap:wrap;gap:16px;align-items:end}label{display:block}input,select,button{font:inherit;padding:8px;border:1px solid #8495a1;border-radius:4px;box-sizing:border-box}input{max-width:100%}button{background:#edf3f8;color:#16364f;cursor:pointer}button:hover{background:#dceaf4}button:disabled{opacity:.6;cursor:wait}:focus-visible{outline:3px solid #07599e;outline-offset:3px}.notice{background:#eaf4ed;padding:12px}.error{background:#fff0ef;color:#8c241b;padding:12px}.danger button{color:#8c241b}.muted{color:#4e606c}section{scroll-margin-top:100px}summary{cursor:pointer}dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px}dd{margin:0;overflow-wrap:anywhere}@media(max-width:650px){body{margin:20px auto;padding:0 16px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:12px}th,td{overflow-wrap:anywhere;padding:8px}.fields{display:block}.fields label{margin:12px 0}}
.number{font-variant-numeric:tabular-nums;white-space:nowrap}td:has(>.number),th.numeric{text-align:right}.tenant-directory td:nth-child(2){text-align:right}.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.875rem;font-weight:600}.badge.success{background:#e6f3e9;color:#235f32}.badge.failure{background:#fde9e8;color:#932b25}.badge.neutral{background:#edf0f2;color:#42535e}.section-nav{position:sticky;top:0;z-index:1;background:#fff}.tenant-cards{display:none}.tenant-card{border:1px solid #bcc7cf;border-radius:12px;padding:20px;margin:16px 0}.tenant-card h2{margin:0 0 4px}.tenant-card .keys-row{border-top:1px solid #d5dde3;padding-top:12px;margin-top:12px}.keys-row{display:flex;flex-wrap:wrap;gap:16px}.keys-row strong{min-width:3ch}.tenant-directory th.numeric{text-align:right}@media(max-width:1099px){.tenant-directory{display:none}.tenant-cards{display:block}.section-nav{gap:8px 16px}.section-nav a{padding:4px 0}}@media(pointer:coarse){button,summary,.tenant-card a,.section-nav a{min-height:44px;box-sizing:border-box}}
.connect-created{background:#eaf4ed;padding:16px;border:1px solid #235f32}a.button{display:inline-block;padding:8px 12px;border:1px solid #8495a1;border-radius:4px;background:#edf3f8;color:#16364f;text-decoration:none}a.button:hover{background:#dceaf4}</style></head><body>${banner}${productHeader}<h1>${e(title)}</h1>${flash ? `<p class="notice" role="status">${e(flash)}</p>` : ''}${body}
<script>function updateTime(t){const date=new Date(t.dateTime);const minutes=Math.max(0,Math.floor((Date.now()-date.getTime())/60000));const relative=minutes<1?'just now':minutes<60?minutes+' min ago':minutes<1440?Math.floor(minutes/60)+' hr ago':Math.floor(minutes/1440)+' days ago';t.textContent=date.toLocaleString()+' · '+relative}document.querySelectorAll('time[datetime]').forEach(updateTime);document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);b.textContent='Copied'}catch{b.textContent='Select and copy the snippet below'}}));document.querySelectorAll('[data-generate]').forEach(b=>b.addEventListener('click',()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));document.getElementById(b.dataset.generate).value=btoa(String.fromCharCode(...bytes))}));</script>${footer}</body></html>`;
}

export function tenantForm(tenant, token, error = '', editing = false) {
  if (!editing) return `<h2>New tenant</h2>${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<form method="post" action="/tenants">${csrf(token)}<div class="fields"><label>Name<br><input name="name" id="tenant-name" value="${e(tenant?.name ?? '')}" required minlength="1" maxlength="100"></label><button>Create tenant</button></div></form>`;
  return `<h2>${editing ? 'Edit tenant' : 'New tenant'}</h2>${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<form method="post" action="${editing ? tenantPath(tenant.id) + '/edit' : '/tenants'}">${csrf(token)}<div class="fields">${(editing ? ['id', 'name', 'appKey', 'singleKey', 'secret'] : ['name']).map(key => `<label>${e(key)}<br><input name="${key}" id="tenant-${key}" value="${e(tenant?.[key] ?? '')}"  ${key === 'name' ? (editing ? '' : 'required minlength="1" maxlength="100"') : 'required'} ${key === 'id' ? 'pattern="[a-z0-9][a-z0-9-]{0,62}" maxlength="63"' : ['appKey', 'singleKey'].includes(key) ? 'pattern="[A-Za-z0-9._~\\-]{1,200}" maxlength="200"' : ''}></label>`).join('')}${editing ? '<button type="button" data-generate="tenant-secret">Generate secret</button>' : ''}<button>${editing ? 'Save tenant' : 'Create tenant'}</button></div></form>`;
}

/** Env-mode setup is an explicit save, never an automatic key rotation. */

export function defaultKeysHtml(registry, token, error = '', values = {}) {
  const current = registry.entries[0];
  const proposed = {...current, appKey: current.appKey || `default-${randomBytes(12).toString('hex')}`, singleKey: current.singleKey || `default-public-${randomBytes(12).toString('hex')}`, secret: current.secret || randomBytes(32).toString('base64'), ...values, id: 'default'};
  return `<h2>Give the default instance explicit keys first</h2><p class="error">Saving these keys creates <code>${e(registry.file)}</code> and turns on strict authentication. Update the running CMS appsettings to match these values; its previous permissive credentials will stop working.</p>${tenantForm(proposed, token, error, true).replace('<h2>Edit tenant</h2>', '').replace('name="id"', 'name="id" readonly')}`;
}

export function memoryHtml(memory = processMemory()) {
  return `<section aria-label="Process memory"><h2>Process memory</h2><p>Heap used: ${e(bytes(memory.heapUsed))} · Heap limit: ${e(bytes(memory.heapLimit))} · RSS: ${e(bytes(memory.rss))}</p>${memory.heapUsed > memory.heapLimit * 0.75 ? '<p class="error" role="alert">Memory warning: heap usage exceeds 75% of the heap limit.</p>' : ''}</section>`;
}

export function dashboardHtml(registry, token, flash = '', error = '', values = {}) {
  const accounts = registry.entries.map(tenant => ({tenant, s: stats(registry.get(tenant.id)), base: tenantPath(tenant.id)}));
  const actions = ({tenant, base}) => `${link(base, 'Open')} · ${link('/graphiql?tenant=' + encodeURIComponent(tenant.id), 'GraphiQL')}`;
  const keys = tenant => `<div class="keys-row"><strong>Keys</strong><div>AppKey ${masked(tenant.appKey)}</div><div>SingleKey ${masked(tenant.singleKey)}</div></div>`;
  const sync = s => s.lastSync ? `${timestamp(s.lastSync.ts)} ${badge(s.lastSync.status)}` : 'Never';
  const rows = accounts.map(account => {
    const {tenant, s, base} = account;
    return [`${link(base, tenant.name)}<br><code>${e(tenant.id)}</code>${keys(tenant)}`, `${number(s.docs)} live documents<br><span class="muted">Published / Draft / other</span><br>${number(s.statuses.Published)} / ${number(s.statuses.Draft)} / ${number(s.statuses.other)}`, number(s.contentTypes), e(s.languages.join(', ')), sync(s), timestamp(s.lastRequest), `<span class="number">${e(bytes(s.storeBytes))}</span>`, actions(account)];
  });
  const cards = accounts.map(account => {
    const {tenant, s, base} = account;
    return `<article class="tenant-card"><h2>${link(base, tenant.name)}</h2><code>${e(tenant.id)}</code><dl><dt>Docs</dt><dd>${number(s.docs)} live documents</dd><dt>Published / Draft / other</dt><dd>${number(s.statuses.Published)} / ${number(s.statuses.Draft)} / ${number(s.statuses.other)}</dd><dt>Content types</dt><dd>${number(s.contentTypes)}</dd><dt>Languages</dt><dd>${e(s.languages.join(', ')) || 'None'}</dd><dt>Last full sync</dt><dd>${sync(s)}</dd><dt>Last request</dt><dd>${timestamp(s.lastRequest)}</dd><dt>Store size</dt><dd>${e(bytes(s.storeBytes))}</dd></dl>${keys(tenant)}<p>${actions(account)}</p></article>`;
  }).join('');
  return page('Local Optimizely Graph', `<p class="muted">Isolated CMS accounts on this gateway. Published / Draft / other counts reflect live documents.</p><p>Tenant configuration: <code>${e(registry.file)}</code> · ${link('/explorer', 'Explore content')}</p>${memoryHtml()}<div class="tenant-directory">${table(['Name / ID / Keys', 'Docs', 'Content types', 'Languages', 'Last full sync', 'Last request', 'Store size', 'Actions'], rows)}</div><div class="tenant-cards">${cards || '<p>No tenants yet.</p>'}</div>${registry.defaultNeedsKeys ? defaultKeysHtml(registry, token, error) : tenantForm(values, token, error)}`, flash);
}

export function pickerHtml(registry) {
  return page('Choose a tenant for GraphiQL', `<ul>${registry.entries.map(tenant => `<li>${link('/graphiql?tenant=' + encodeURIComponent(tenant.id), tenant.name + ' (' + tenant.id + ')')}</li>`).join('')}</ul>`);
}

export const countTable = s => table(['Type', 'Locale', 'Status', 'Count'], s.counts.map(row => [e(row.type), e(row.locale), badge(row.status), number(row.count)]));
const sourceTable = s => table(['Source ID', 'Content types', 'Docs'], s.sources.map(source => [e(source.id), number(source.contentTypes), number(source.docs)]));

export function tenantHtml(runtime, registry, token, host, params) {
  const tenant = runtime.tenant; const base = tenantPath(tenant.id); const s = stats(runtime);
  const snippet = {Optimizely: {ContentGraph: {GatewayAddress: `http://${host}`, AppKey: tenant.appKey, Secret: tenant.secret, SingleKey: tenant.singleKey}}};
  const filtered = documents(runtime, params); const requestedPage = Number(params.get('page') ?? 1); const lastPage = Math.max(1, Math.ceil(filtered.length / 50));
  const current = Number.isFinite(requestedPage) ? Math.max(1, Math.min(lastPage, Math.trunc(requestedPage))) : 1;
  const pageLink = n => { const query = new URLSearchParams(params); query.set('page', n); query.delete('flash'); return base + '?' + query + '#documents'; };
  const docRows = filtered.slice((current - 1) * 50, current * 50).map(doc => [link(`${base}/documents/${encodeURIComponent(doc.id)}`, doc.displayName ?? doc.id), e(doc.id), e(doc.key), e(doc.type), e(doc.locale), badge(doc.status), e(doc.version)]);
  const jobRows = jobs(runtime).map(job => [link(`${base}/sync/${encodeURIComponent(job.id)}`, job.ogJobId ?? job.id), timestamp(job.ts), number(job.journals.length), number(job.indexed), number(job.deleted), number(job.failed), badge(job.status)]);
  const requests = runtime.log.recent.slice(-200).reverse().map(r => [timestamp(r.ts), e(r.method), link(`${base}/request/${r.n}`, r.url), number(r.status), `<span class="number">${e(r.ms + 'ms')}</span>`, e(r.root ?? ''), e(r.queryName ?? ''), r.ops == null ? '' : number(r.ops)]);
  const danger = [['content', 'Clear content'], ['types', 'Clear content types'], ['jobs', 'Clear sync history'], ['requests', 'Clear request log'], ['all', 'Reset everything'], ['delete', 'Delete tenant']].map(([action, label]) => `<form method="post" action="${base}/confirm">${csrf(token)}${hidden('action', action)}<button>${label}</button></form>`).join('');
  const sdl = printSchema(runtime.schemas.live);
  return page(tenant.name, `<p class="muted">Tenant <code>${e(tenant.id)}</code> · ${link('/graphiql?tenant=' + encodeURIComponent(tenant.id), 'Open GraphiQL')} · ${link('/explorer?tenant=' + encodeURIComponent(tenant.id), 'Explore content')} · ${link(base + '/edit', 'Edit keys and name')}</p>
<nav class="section-nav" aria-label="Tenant sections">${['Connect', 'Overview', 'Sync jobs', 'Documents', 'Requests', 'Schema', 'Danger zone'].map(name => link('#' + name.toLowerCase().replaceAll(' ', '-'), name)).join('')}</nav>
<section id="connect"${params.get('created') === '1' ? ' class="connect-created"' : ''}><h2>Connect</h2><p>Paste into <code>appsettings.Development.json</code>.</p><button data-copy="settings">Copy appsettings.json</button><pre id="settings">${e(JSON.stringify(snippet, null, 2))}</pre></section>
<section id="overview"><h2>Overview</h2><p id="live-counts" aria-live="polite">${e(overviewText(s))}</p><div id="count-table">${countTable(s)}</div><p id="types-summary">Types model: ${number(s.contentTypes)} content types · ${number(s.propertyTypes)} property types · languages: ${e(s.languages.join(', '))} · last types PUT/POST: ${timestamp(s.typesUpdated)} ${e(s.typesMethod ?? '')}</p><h3>Sources</h3><div id="source-table">${sourceTable(s)}</div></section>
<section id="sync-jobs"><h2>Sync jobs</h2>${table(['og-job-id', 'Time', 'Journals', 'Indexed', 'Deleted', 'Failed', 'Status'], jobRows)}</section>
<section id="documents"><h2>Documents</h2><form method="get" action="${base}#documents"><div class="fields">${['type', 'locale', 'status', 'q'].map(key => `<label>${key === 'q' ? 'Display name, key or ID' : e(key)}<br><input name="${key}" value="${e(params.get(key) ?? '')}"></label>`).join('')}<button>Filter documents</button></div></form><p>${filtered.length.toLocaleString('en-US')} matching documents · page ${current.toLocaleString('en-US')} of ${lastPage.toLocaleString('en-US')}</p>${table(['Display name', 'ID', 'Key', 'Type', 'Locale', 'Status', 'Version'], docRows)}<p>${current > 1 ? link(pageLink(current - 1), 'Previous 50') : ''} ${current < lastPage ? link(pageLink(current + 1), 'Next 50') : ''}</p></section>
<section id="requests"><h2>Requests</h2>${table(['Time', 'Method', 'Path', 'Status', 'Duration', 'GraphQL root', 'Query name', 'Ops'], requests)}</section>
<section id="schema"><h2>Schema</h2><label>Search SDL <input id="schema-search" type="search"></label><pre id="sdl">${sdl.split('\n').map(line => `<span class="sdl-line">${e(line)}\n</span>`).join('')}</pre></section>
<section id="danger-zone" class="danger"><h2>Danger zone</h2><p>Every action requires typing this tenant ID on the next page.</p>${danger}${registry.legacyFiles().some(name => /^store\.(json|ndjson)$/.test(name)) ? `<form method="post" action="${base}/import">${csrf(token)}<button>Import legacy store</button></form><p>Import requires an empty tenant.</p>` : ''}</section>
<script>document.getElementById('schema-search').addEventListener('input',event=>{const q=event.target.value.toLowerCase();document.querySelectorAll('.sdl-line').forEach(line=>line.hidden=!line.textContent.toLowerCase().includes(q))});
const statsUrl=${JSON.stringify(base + '/stats')};
async function refreshCounts(){
  try {
    const response=await fetch(statsUrl);if(!response.ok)throw Error();const s=await response.json();
    const format=value=>value.toLocaleString('en-US');
    document.getElementById('live-counts').textContent=format(s.docs)+' live documents \u00b7 new slot: '+(s.slots.new===null?'inactive':format(s.slots.new)+' documents')+(s.slots.old===null?'':' \u00b7 previous (revertable): '+format(s.slots.old)+' docs')+' \u00b7 '+format(s.tombstones)+' tombstones';
    const time=document.createElement('time');
    if(s.typesUpdated){time.dateTime=s.typesUpdated;time.title=s.typesUpdated;updateTime(time)}else{time.textContent='Never'}
    document.getElementById('types-summary').replaceChildren('Types model: '+format(s.contentTypes)+' content types \u00b7 '+format(s.propertyTypes)+' property types \u00b7 languages: '+s.languages.join(', ')+' \u00b7 last types PUT/POST: ',time,' '+(s.typesMethod??''));
    const sources=document.querySelector('#source-table tbody');sources.replaceChildren();
    for(const source of s.sources){
      const tr=document.createElement('tr');
      for(const value of [source.id,source.contentTypes,source.docs]){
        const td=document.createElement('td');
        if(typeof value==='number'){const count=document.createElement('span');count.className='number';count.textContent=format(value);td.append(count)}
        else td.textContent=value;
        tr.append(td);
      }
      sources.append(tr);
    }
    if(!s.sources.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.textContent='No entries yet.';tr.append(td);sources.append(tr)}
    const tbody=document.querySelector('#count-table tbody');tbody.replaceChildren();
    for(const row of s.counts){
      const tr=document.createElement('tr');
      for(const [index,value] of [row.type,row.locale,row.status,row.count].entries()){
        const td=document.createElement('td');
        if(index===2){const badge=document.createElement('span');badge.className='badge '+(value==='Success'?'success':value==='Error'?'failure':'neutral');badge.textContent=value;td.append(badge)}
        else if(typeof value==='number'){const number=document.createElement('span');number.className='number';number.textContent=format(value);td.append(number)}
        else td.textContent=value;
        tr.append(td);
      }
      tbody.append(tr);
    }
  }catch{document.getElementById('live-counts').textContent='Counts could not refresh. Refresh the page to retry.'}
}

setInterval(refreshCounts,5000);</script>`, params.get('flash'));
}

function overviewText(s) { return `${s.docs.toLocaleString('en-US')} live documents · new slot: ${s.slots.new === null ? 'inactive' : s.slots.new.toLocaleString('en-US') + ' documents'}${s.slots.old === null ? '' : ' · previous (revertable): ' + s.slots.old.toLocaleString('en-US') + ' docs'} · ${s.tombstones.toLocaleString('en-US')} tombstones`; }

export function documentHtml(runtime, record, slot = 'live') {
  const doc = record.normalized; const key = doc._metadata?.key;
  const query = `{ _Content(where: { _metadata: { key: { eq: ${JSON.stringify(String(key ?? ''))} } } }, variation: {include: ALL}) { items { _id _metadata { key displayName locale status version } } total } }`;
  const versions = Object.values(runtime.store.slot(slot).docs).filter(other => key && other.normalized._metadata?.key === key).map(other => {
    const value = other.normalized; return [link(tenantPath(runtime.tenant.id) + '/documents/' + encodeURIComponent(value._id) + (slot === 'new' ? '?slot=new' : ''), value._id), e(value._metadata?.locale), badge(value._metadata?.status), e(value._metadata?.version)];
  });
  return page(doc._metadata?.displayName ?? doc._id, `<p>${link(tenantPath(runtime.tenant.id), 'Back to tenant')} · ${link('/graphiql?' + new URLSearchParams({tenant: runtime.tenant.id, query, ...(slot === 'new' ? {slot: 'new'} : {})}), 'Query in GraphiQL')}</p><h2>Raw document (as received)</h2>${pre(record.raw)}<h2>Normalized document</h2>${pre(doc)}<h2>Versions of the same key</h2>${table(['ID', 'Locale', 'Status', 'Version'], versions)}`);
}

export function requestHtml(runtime, entry) {
  const body = (label, value, truncated) => `<h2>${label}${truncated ? ' (truncated at 64 KB)' : ''}</h2>${formattedBody(value ?? '(body logging disabled or empty)')}`;
  return page(`Request ${entry.n}`, `<p>${link(tenantPath(runtime.tenant.id) + '#requests', 'Back to requests')}</p>${pre({method: entry.method, path: entry.url, status: entry.status, ms: entry.ms, ts: entry.ts, root: entry.root, queryName: entry.queryName, ops: entry.ops})}<h2>Headers</h2>${pre(entry.headers)}${body('Request body', entry.reqBody, entry.reqTruncated)}${body('Response body', entry.resBody, entry.resTruncated)}`);
}

export function journalHtml(runtime, id, journal) {
  return `<h3>${e(id)}</h3>${table(['ID', 'Status', 'Result', 'Error'], (journal.items ?? []).map(({index}) => [e(index._id), e(index.Status), e(index.Result), e(index.Error ? `${index.Error.Type}: ${index.Error.Reason}` : '')]))}`;
}

export function jobHtml(runtime, job) {
  return page(`Sync job ${job.ogJobId ?? job.id}`, `<p>${link(tenantPath(runtime.tenant.id) + '#sync-jobs', 'Back to sync jobs')}</p><dl><dt>Time</dt><dd>${timestamp(job.ts)}</dd><dt>Status</dt><dd>${badge(job.status)}</dd><dt>Indexed</dt><dd>${number(job.indexed)}</dd><dt>Deleted</dt><dd>${number(job.deleted)}</dd><dt>Failed</dt><dd>${number(job.failed)}</dd></dl>${job.journals.map(journal => journalHtml(runtime, journal.id, journal)).join('')}`);
}

export function confirmationHtml(tenant, token, action, error = '') {
  const names = {content: 'Clear content', types: 'Clear content types', jobs: 'Clear sync history', requests: 'Clear request log', all: 'Reset everything', delete: 'Delete tenant'};
  const help = {content: 'All documents and tombstones in live, new and previous slots will be removed. Run CMS Full Synchronization again.', types: 'Types models in live, new and previous slots will be removed and schemas reset. CMS re-pushes on startup or full synchronization.', jobs: 'All journals and jobs will be removed.', requests: 'The request history and rotated log files will be removed.', all: 'Content, types, sync history, requests, webhooks, new and previous slots will be removed.', delete: 'The tenant will be removed from tenants.json.'};
  return page(`${names[action]} · ${tenant.name}`, `${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<p>${e(help[action])}</p><form method="post" action="${tenantPath(tenant.id)}/${action === 'delete' ? 'delete' : 'clear'}">${csrf(token)}${hidden('action', action)}<label>Type <code>${e(tenant.id)}</code> to confirm<br><input name="confirm" required autocomplete="off"></label>${action === 'delete' ? '<label><input type="checkbox" name="deleteFolders" value="yes"> Also delete data and logs folders</label>' : ''}<p><button>${e(names[action])}</button> ${link(tenantPath(tenant.id), 'Cancel')}</p></form>`);
}
