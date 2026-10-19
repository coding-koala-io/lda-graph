import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {documentHasType} from './content-sources.js';

export const ownValue = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
export function jobs(runtime, limit = 50) {
  const store = runtime.store;
  return Object.values(store.state.jobs).filter(job => job && typeof job === 'object').slice(-limit).reverse().map(job => {
    const details = Array.isArray(job.details) ? job.details.filter(detail => typeof detail?.id === 'string') : [];
    const journals = details.map(detail => ({id: detail.id.replace(/^stream\//, ''), ...ownValue(store.state.journals, detail.id.replace(/^stream\//, ''))}));
    const counts = {indexed: 0, deleted: 0, failed: 0};
    for (const journal of journals) for (const {index} of journal.items ?? []) {
      if (index.Status >= 400) counts.failed++;
      else if (index.Result === 'created' || index.Result === 'updated') counts.indexed++;
      else if (index.Result === 'deleted') counts.deleted++;
    }
    return {...job, ...counts, journals, status: store.jobStatus(job.id)?.status};
  });
}
export function stats(runtime) {
  const store = runtime.store; const model = store.state.types.default;
  const counts = new Map(); const statuses = {Published: 0, Draft: 0, other: 0};
  for (const {normalized: doc} of Object.values(store.state.docs)) {
    const meta = doc._metadata ?? {}; const status = String(meta.status ?? '');
    const group = status.toLowerCase() === 'published' ? 'Published' : status.toLowerCase() === 'draft' ? 'Draft' : 'other';
    statuses[group]++;
    const key = JSON.stringify([doc.__typename ?? '', meta.locale ?? '', status]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let storeBytes = 0;
  if (store.dataDir !== ':memory:') for (const file of ['store.ndjson', 'store.json']) {
    const path = join(store.dataDir, file); if (existsSync(path)) storeBytes += statSync(path).size;
  }
  const live = Object.keys(store.state.docs).length; const next = store.state.slots.new;
  const sources = Object.entries(store.state.types).map(([id, model]) => {
    const names = new Set(Object.keys(model.contentTypes ?? {}));
    return {id, contentTypes: names.size, docs: Object.values(store.state.docs).filter(record => documentHasType(record.normalized, names)).length};
  });
  return {id: runtime.tenant.id, docs: live, statuses, counts: [...counts].map(([key, count]) => ({type: JSON.parse(key)[0], locale: JSON.parse(key)[1], status: JSON.parse(key)[2], count})),
    sources, oldSlotExpires: store.previousSlotExpires(),
    slots: {live, new: next ? Object.keys(next.docs).length : null, old: store.state.slots.old ? Object.keys(store.state.slots.old.docs).length : null}, tombstones: Object.keys(store.state.tombstones).length + Object.keys(next?.tombstones ?? {}).length,
    contentTypes: Object.keys(model?.contentTypes ?? {}).length, propertyTypes: Object.keys(model?.propertyTypes ?? {}).length, languages: Array.isArray(model?.languages) ? model.languages : [],
    typesUpdated: store.state.metadata.liveTypesUpdated ?? null, typesMethod: store.state.metadata.liveTypesMethod ?? null,
    lastSync: jobs(runtime)[0] ?? null, lastRequest: runtime.log.recent.at(-1)?.ts ?? null, storeBytes};
}
export function documents(runtime, params, slot = 'live') {
  const q = (params.get('q') ?? '').toLowerCase();
  return Object.values(runtime.store.slot(slot).docs).map(({normalized: doc}) => ({id: doc._id, key: doc._metadata?.key, type: doc.__typename, locale: doc._metadata?.locale, status: doc._metadata?.status, displayName: doc._metadata?.displayName, version: doc._metadata?.version}))
    .filter(doc => ['type', 'locale', 'status'].every(key => !params.get(key) || doc[key] === params.get(key)) && (!q || [doc.displayName, doc.key, doc.id].some(value => String(value ?? '').toLowerCase().includes(q))));
}

/** Counts describe the exact state removed, across all slots. */
export function clearTenant(runtime, what) {
  if (!Array.isArray(what) || !what.length || what.some(value => !['content', 'types', 'jobs', 'requests', 'all'].includes(value))) throw new Error('what must be a non-empty array of content, types, jobs, requests or all');
  const all = what.includes('all'); const removed = {}; const state = runtime.store.state;
  for (const slot of [state, state.slots.new, state.slots.old].filter(Boolean)) {
    if (all || what.includes('content')) {
      removed.docs = (removed.docs ?? 0) + Object.keys(slot.docs).length;
      removed.tombstones = (removed.tombstones ?? 0) + Object.keys(slot.tombstones).length;
      slot.docs = {}; slot.tombstones = {};
    }
    if (all || what.includes('types')) {
      for (const model of Object.values(slot.types)) {
        removed.contentTypes = (removed.contentTypes ?? 0) + Object.keys(model?.contentTypes ?? {}).length;
        removed.propertyTypes = (removed.propertyTypes ?? 0) + Object.keys(model?.propertyTypes ?? {}).length;
      }
      removed.contentTypes ??= 0; removed.propertyTypes ??= 0;
      slot.types = {};
      delete slot.typesUpdated; delete slot.typesMethod;
    }
  }
  if (all || what.includes('content')) { delete state.slots.old; delete state.metadata.oldSlotSince; }
  if (all || what.includes('types')) {
    for (const name of ['liveTypesUpdated', 'newTypesUpdated', 'liveTypesMethod', 'newTypesMethod']) delete state.metadata[name];
  }
  if (all || what.includes('jobs')) { removed.jobs = Object.keys(state.jobs).length; removed.journals = Object.keys(state.journals).length; state.jobs = {}; state.journals = {}; }
  if (all || what.includes('requests')) Object.assign(removed, runtime.log.clear());
  if (all) { removed.webhooks = state.webhooks.length; removed.newSlots = state.slots.new ? 1 : 0; state.webhooks = []; state.slots = {}; state.metadata = {}; }
  runtime.store.changed(); runtime.rebuild(); return removed;
}
