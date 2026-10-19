import {randomUUID} from 'node:crypto';
import {parseJson} from './http-utils.js';
import {extractText} from './extract.js';
import {documentHasType} from './content-sources.js';
const ownValue = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const wireJob = ({ts, ogJobId, ...job}) => job;
const wireJournal = ({ts, ...journal}) => journal;

/** CMS push API, operating only on the already-routed tenant. */
export async function handleProtocol({path, method, url, text, bytes, headers, store, rebuild, slot, source, send, diagnostic}) {
  if (path === '/api/content/v3/types') {
    if (method === 'GET') {
      const model = ownValue(store.slot(slot).types, source);
      return send(model ? 200 : 404, model ?? {message: 'Types not found'});
    }
    if (['PUT', 'POST'].includes(method)) {
      const model = parseJson(text);
      if (!model || typeof model !== 'object' || Array.isArray(model)) return send(400, {message: 'Types model must be an object'});
      store.setTypes(model, {slot, source, merge: method === 'POST'}); rebuild(); return send(200, {});
    }
  }
  if (path === '/api/content/v3/sources') {
    if (method === 'GET') {
      const sources = Object.keys(store.slot(slot).types).map(id => ({id, label: id, description: ''}));
      if (!url.searchParams.has('id')) return send(200, sources);
      const found = sources.find(s => s.id === source); return send(found ? 200 : 404, found ?? {message: 'Source not found'});
    }
    if (method === 'DELETE') {
      const target = store.slot(slot, true);
      const names = new Set(Object.keys(ownValue(target.types, source)?.contentTypes ?? {}));
      delete target.types[source];
      if (url.searchParams.get('mode') === 'reset') {
        if (source === 'default') { target.docs = {}; delete store.state.slots.old; delete store.state.metadata.oldSlotSince; }
        else for (const [id, record] of Object.entries(target.docs)) if (documentHasType(record.normalized, names)) store.delete(id, {slot});
      }
      store.changed(); rebuild(); return send(200, {});
    }
  }
  if (method === 'DELETE' && path === '/api/content/v2/data') { store.slot(slot, true).docs = {}; delete store.state.slots.old; delete store.state.metadata.oldSlotSince; store.changed(); return send(200, {}); }
  if (method === 'POST' && path === '/_stream') {
    const journalId = store.stream(text, slot); const journal = store.state.journals[journalId]; diagnostic.ops = journal.itemCount ?? journal.items.length; diagnostic.journal = journalId;
    return send(200, {journalId});
  }
  if (method === 'POST' && path.startsWith('/_doc/')) {
    const result = store.upsert(decodeURIComponent(path.slice(6)), parseJson(text), {slot: url.searchParams.get('version') === 'new' ? 'new' : slot, locale: url.searchParams.get('language_routing') ?? undefined, snapshotTime: headers.snapshottime});
    return send(200, {result: result.Result});
  }
  if (method === 'POST' && path === '/journal/indexing') { store.addJob(parseJson(text), headers['og-job-id']); return send(200, {}); }
  if (method === 'GET' && path.startsWith('/journal/indexing/')) {
    const status = path.endsWith('/status');
    const id = decodeURIComponent(path.slice('/journal/indexing/'.length).replace(/\/status$/, ''));
    const job = ownValue(store.state.jobs, id);
    const result = status ? store.jobStatus(id) : job && wireJob(job);
    return send(result ? 200 : 404, result ?? {message: 'Job not found'});
  }
  if (method === 'GET' && path.startsWith('/journal/stream/')) {
    const id = decodeURIComponent(path.slice('/journal/stream/'.length)).replace(/^stream\//, '');
    const journal = ownValue(store.state.journals, id);
    const result = journal && wireJournal(journal); return send(result ? 200 : 404, result ?? {message: 'Journal not found'});
  }
  if (method === 'DELETE' && path === '/account') {
    const locale = (url.searchParams.get('language_routing') ?? '').toLowerCase();
    for (const [id, record] of Object.entries(store.slot(slot).docs)) if ((record.normalized._metadata?.locale ?? '').toLowerCase() === locale) store.delete(id, {slot});
    return send(200, {});
  }
  if (method === 'POST' && path === '/extract') {
    const {text: extracted} = await extractText(bytes);
    return send(200, {type: 'text/plain', language: '', text: extracted});
  }
  if (method === 'POST' && path === '/clientlog') return send(204, null);
  if (path === '/api/webhooks') {
    if (method === 'GET') return send(200, store.state.webhooks);
    if (method === 'POST') {
      const body = parseJson(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, {message: 'Webhook must be an object'});
      const webhook = {...body, id: randomUUID()}; store.state.webhooks.push(webhook); store.changed(); return send(200, webhook);
    }
  }
  if (method === 'DELETE' && path.startsWith('/api/webhooks/')) {
    const id = decodeURIComponent(path.slice('/api/webhooks/'.length));
    store.state.webhooks = store.state.webhooks.filter(w => w.id !== id); store.changed(); return send(200, {});
  }
  return false;
}
