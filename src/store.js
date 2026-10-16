import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, renameSync, openSync, readSync, closeSync, promises as fs} from 'node:fs';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {normalizeDocument, valuesAt} from './normalize.js';
import {compactJournal} from './journal.js';

const emptySlot = () => ({types: {}, docs: {}, tombstones: {}});
const own = (object, key) => Object.hasOwn(object, key);
const objectMap = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const assign = (object, key, value) => Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});
const emptyState = () => ({...emptySlot(), journals: {}, jobs: {}, webhooks: [], slots: {}, metadata: {}});

function* fileLines(file) {
  const fd = openSync(file, 'r'); const buffer = Buffer.alloc(65536); const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
      pending += decoder.write(buffer.subarray(0, count));
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { yield pending.slice(0, end); pending = pending.slice(end + 1); }
    }
    pending += decoder.end();
    if (pending.trim()) yield pending;
  } finally { closeSync(fd); }
}

function restoreDocument(record, id) {
  const raw = record.raw ?? record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid stored document ${id}`);
  return normalizeDocument(raw, id, record.snapshotTime ?? record.normalized?._modified, record.locale ?? record.normalized?._metadata?.locale);
}

function restoreSlot(value) {
  const input = objectMap(value); const slot = emptySlot();
  slot.types = objectMap(input.types); slot.tombstones = objectMap(input.tombstones);
  for (const field of ['typesUpdated', 'typesMethod']) if (own(input, field)) slot[field] = input[field];
  for (const id in objectMap(input.docs)) if (own(input.docs, id)) {
    assign(slot.docs, id, restoreDocument(input.docs[id], id));
    delete input.docs[id];
  }
  return slot;
}

/** Single-process store with atomic, coalesced asynchronous persistence. */
export class Store {
  constructor({dataDir = './data', logger = console} = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.state = emptyState();
    this.timer = null;
    this.revision = 0;
    this.writing = null; this.pendingWrite = false;
    if (dataDir !== ':memory:') {
      const ndjson = join(dataDir, 'store.ndjson');
      const modernStoreSeen = existsSync(dataDir) && readdirSync(dataDir).some(file => file.startsWith('store.json.migrated') || /^store\.corrupt-.*\.ndjson$/.test(file));
      const file = existsSync(ndjson) || modernStoreSeen ? ndjson : join(dataDir, 'store.json');
      if (existsSync(file)) {
        try {
          let loaded;
          if (file === ndjson) {
            loaded = emptyState(); let header = false; let ended = false;
            for (const line of fileLines(file)) {
              if (!line.trim()) continue;
              const entry = JSON.parse(line);
              if (ended) throw new Error('Records after end marker');
              if (!header) {
                if (entry.record !== 'header' || entry.version !== 1) throw new Error('Invalid NDJSON header');
                header = true; continue;
              }
              if (entry.record === 'end') { ended = true; continue; }
              if (entry.slot !== undefined && !['live', 'new', 'old'].includes(entry.slot)) throw new Error('Invalid slot');
              const target = ['new', 'old'].includes(entry.slot) ? (loaded.slots[entry.slot] ??= emptySlot()) : loaded;
              if (entry.record === 'slot') {
                if (!['new', 'old'].includes(entry.slot)) throw new Error('Invalid slot');
                for (const field of ['typesUpdated', 'typesMethod']) if (own(entry, field)) target[field] = entry[field];
              }
              else if (['types', 'docs', 'tombstones'].includes(entry.record)) assign(target[entry.record], entry.id, entry.record === 'docs' ? restoreDocument(entry.value, entry.id) : entry.value);
              else if (['journals', 'jobs'].includes(entry.record)) assign(loaded[entry.record], entry.id, entry.record === 'journals' ? compactJournal(entry.value) : entry.value);
              else if (entry.record === 'webhook') loaded.webhooks.push(entry.value);
              else if (entry.record === 'metadata') loaded.metadata = objectMap(entry.value);
              else throw new Error(`Unknown record type ${entry.record}`);
            }
            if (!header || !ended) throw new Error('Incomplete NDJSON store');
          } else loaded = JSON.parse(readFileSync(file, 'utf8'));
          if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('Store must be an object');
          if (file === ndjson) this.state = loaded;
          else {
            this.state = {...emptyState(), ...restoreSlot(loaded), journals: objectMap(loaded.journals), jobs: objectMap(loaded.jobs), webhooks: Array.isArray(loaded.webhooks) ? loaded.webhooks : [], metadata: objectMap(loaded.metadata)};
            for (const id in this.state.journals) if (own(this.state.journals, id)) this.state.journals[id] = compactJournal(this.state.journals[id]);
            for (const slot of ['new', 'old']) if (loaded.slots?.[slot]) this.state.slots[slot] = restoreSlot(loaded.slots[slot]);
          }
          this.trim('journals', 1000); this.trim('jobs', 200);
        } catch (error) {
          this.logger.error(`Persistence warning: corrupt or partial ${file}; starting empty: ${error.message}`);
          try { renameSync(file, join(dataDir, `store.corrupt-${Date.now()}-${randomUUID()}.${file === ndjson ? 'ndjson' : 'json'}`)); }
          catch (renameError) { this.logger.error(`Could not quarantine corrupt store: ${renameError.message}`); }
          this.state = emptyState();
        }
      }
    }
  }
  slot(name = 'live', create = false) {
    if (name !== 'new') return this.state;
    if (!this.state.slots.new && create) this.state.slots.new = emptySlot();
    return this.state.slots.new ?? emptySlot();
  }
  changed() {
    this.revision++;
    if (this.dataDir === ':memory:') return;
    if (this.writing) { this.pendingWrite = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch(error => this.logger.error('Persistence failed:', error.message));
    }, 500);
    this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.dataDir === ':memory:') return Promise.resolve();
    this.pendingWrite = true;
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.pendingWrite) {
        this.pendingWrite = false;
        await this.writeSnapshot();
      }
    })().finally(() => { this.writing = null; });
    return this.writing;
  }
  async writeSnapshot() {
    // Iterate existing maps with bounded batches. If a request changes them
    // while I/O yields, discard this attempt and let flush coalesce a retry.
    // Only an unchanged revision may be atomically promoted to disk.
    const revision = this.revision;
    const state = this.state;
    await fs.mkdir(this.dataDir, {recursive: true});
    const target = join(this.dataDir, 'store.ndjson');
    const handle = await fs.open(`${target}.tmp`, 'w');
    let batch = ''; let size = 0;
    const writeLine = line => {
      batch += line; size += Buffer.byteLength(line);
      if (size >= 65536) { const pending = handle.writeFile(batch); batch = ''; size = 0; return pending; }
    };
    const write = entry => writeLine(JSON.stringify(entry) + '\n');
    try {
      await write({record: 'header', version: 1});
      for (const [slot, data] of [['live', state], ['new', state.slots.new], ['old', state.slots.old]]) {
        if (!data) continue;
        if (slot !== 'live') await write({record: 'slot', slot, typesUpdated: data.typesUpdated, typesMethod: data.typesMethod});
        for (const record of ['types', 'docs', 'tombstones']) for (const id in data[record]) if (own(data[record], id)) {
          const value = data[record][id];
          // Preserve version-1 NDJSON raw objects without parsing the raw string.
          const pending = record === 'docs'
            ? writeLine(JSON.stringify({record, slot, id}).slice(0, -1) + ',"value":{"raw":' + value.rawJson + ',' + JSON.stringify({snapshotTime: value.normalized._modified, locale: value.normalized._metadata?.locale}).slice(1) + '}\n')
            : write({record, slot, id, value});
          if (pending) await pending;
        }
      }
      for (const record of ['journals', 'jobs']) for (const id in state[record]) if (own(state[record], id)) { const pending = write({record, id, value: state[record][id]}); if (pending) await pending; }
      for (const value of state.webhooks) { const pending = write({record: 'webhook', value}); if (pending) await pending; }
      await write({record: 'metadata', value: state.metadata});
      await write({record: 'end'});
      if (batch) await handle.writeFile(batch);
    } finally { await handle.close(); }
    if (this.revision !== revision) { this.pendingWrite = true; return; }
    await fs.rename(`${target}.tmp`, target);
    const legacy = join(this.dataDir, 'store.json');
    try { await fs.rename(legacy, `${legacy}.migrated-${Date.now()}-${randomUUID()}`); }
    catch (error) {
      if (error.code !== 'ENOENT') this.logger.error(`Persistence warning: could not archive legacy store: ${error.message}`);
    }
  }
  setTypes(model, {slot = 'live', merge = false, source = 'default'} = {}) {
    const target = this.slot(slot, true);
    const old = own(target.types, source) ? target.types[source] : {};
    const next = merge ? {...old, ...model, contentTypes: {...old.contentTypes, ...model.contentTypes}, propertyTypes: {...old.propertyTypes, ...model.propertyTypes}} : structuredClone(model);
    Object.defineProperty(target.types, source, {value: next, enumerable: true, writable: true, configurable: true});
    this.state.metadata[`${slot}TypesUpdated`] = new Date().toISOString();
    this.state.metadata[`${slot}TypesMethod`] = merge ? 'POST' : 'PUT';
    this.changed();
  }
  upsert(id, raw, {slot = 'live', snapshotTime, locale} = {}) {
    if (typeof id !== 'string' || !id || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Index requires _id and an object document');
    const target = this.slot(slot, true);
    const old = own(target.docs, id) ? target.docs[id] : null;
    if (snapshotTime && (Date.parse(old?.normalized._modified) > Date.parse(snapshotTime) || Date.parse(own(target.tombstones, id) ? target.tombstones[id] : null) > Date.parse(snapshotTime))) return {Status: 200, _index: 'default', _id: id, Result: 'noop'};
    Object.defineProperty(target.docs, id, {value: normalizeDocument(raw, id, snapshotTime, locale), enumerable: true, writable: true, configurable: true});
    this.changed();
    return {Status: old ? 200 : 201, _index: 'default', _id: id, Result: old ? 'updated' : 'created'};
  }
  delete(id, {slot = 'live', hard = true, snapshotTime} = {}) {
    if (typeof id !== 'string' || !id) throw new Error('Delete requires _id');
    const target = this.slot(slot, true);
    const exists = own(target.docs, id);
    if (snapshotTime && (Date.parse(exists ? target.docs[id].normalized._modified : null) > Date.parse(snapshotTime) || Date.parse(own(target.tombstones, id) ? target.tombstones[id] : null) > Date.parse(snapshotTime))) return {Status: 200, _index: 'default', _id: id, Result: 'noop'};
    if (snapshotTime && Number.isFinite(Date.parse(snapshotTime))) assign(target.tombstones, id, snapshotTime);
    if (exists && hard) delete target.docs[id];
    else if (exists) {
      target.docs[id].normalized._deleted = true;
      const raw = target.docs[id].raw; raw._deleted = true;
      target.docs[id].rawJson = JSON.stringify(raw);
      if (snapshotTime) target.docs[id].normalized._modified = snapshotTime;
    }
    this.changed();
    return {Status: 200, _index: 'default', _id: id, Result: exists ? 'deleted' : 'not_found'};
  }
  stream(body, defaultSlot = 'live') {
    const started = performance.now();
    const lines = body.split('\n').filter(line => line.trim());
    const items = [];
    const isAction = line => {
      try { const obj = JSON.parse(line); return obj && ['index', 'delete', 'delete_by_paths'].some(k => own(obj, k)); } catch { return false; }
    };
    for (let i = 0; i < lines.length; i++) {
      let action;
      try {
        const obj = JSON.parse(lines[i]);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Action must be an object');
        const keys = Object.keys(obj);
        if (keys.length !== 1 || !['index', 'delete', 'delete_by_paths'].includes(keys[0])) throw new Error('Expected index, delete, or delete_by_paths action');
        const op = keys[0];
        action = obj[op];
        if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Action metadata must be an object');
        let source;
        if (op !== 'delete') {
          if (i + 1 >= lines.length || isAction(lines[i + 1])) throw new Error('Missing source line');
          source = JSON.parse(lines[++i]);
        }
        const slot = action.version === 'new' ? 'new' : defaultSlot;
        let result;
        if (op === 'index') result = this.upsert(action._id, source, {slot, snapshotTime: action._snapshotTime, locale: action.language_routing});
        else if (op === 'delete') result = this.delete(action._id, {slot, hard: action._hardDeleted !== false, snapshotTime: action._snapshotTime});
        else {
          if (!source || !Array.isArray(source.paths) || !source.paths.length || source.paths.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string')) throw new Error('delete_by_paths requires nonempty [path,value] pairs');
          let count = 0; let noops = 0;
          for (const [id, record] of Object.entries(this.slot(slot).docs)) {
            if (source.paths.every(([path, value]) => valuesAt(record.normalized, path).some(v => String(v) === String(value)))) {
              const deleted = this.delete(id, {slot, hard: action._hardDeleted !== false, snapshotTime: action._snapshotTime});
              if (deleted.Result === 'noop') noops++; else count++;
            }
          }
          result = {Status: 200, _index: 'default', _id: action._id ?? '', Result: count ? 'deleted' : noops ? 'noop' : 'not_found'};
        }
        items.push({index: result});
      } catch (error) {
        items.push({index: {Status: 400, _index: 'default', _id: action?._id ?? '', Result: 'not_found', Error: {Type: 'parse_error', Reason: error.message}}});
      }
    }
    const id = randomUUID();
    this.state.journals[id] = compactJournal({ts: new Date().toISOString(), took: Math.round(performance.now() - started), errors: items.some(i => i.index.Status === 400), status: 'done', items});
    this.trim('journals', 1000);
    this.changed();
    return id;
  }
  trim(name, limit) {
    const keys = Object.keys(this.state[name]);
    for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete this.state[name][key];
  }
  addJob(job, jobHeader) {
    if (typeof job?.id !== 'string' || !job.id || !Array.isArray(job.details) || job.details.some(detail => typeof detail?.id !== 'string' || !detail.id)) throw new Error('Job requires a string id and details containing string journal ids');
    Object.defineProperty(this.state.jobs, job.id, {value: {...structuredClone(job), ts: new Date().toISOString(), ogJobId: jobHeader ?? job.id}, enumerable: true, writable: true, configurable: true});
    this.trim('jobs', 200); this.changed();
  }
  jobStatus(id) {
    if (!own(this.state.jobs, id)) return null;
    const details = Array.isArray(this.state.jobs[id]?.details) ? this.state.jobs[id].details.filter(detail => typeof detail?.id === 'string') : [];
    const failingJournals = details.filter(d => this.state.journals[d.id.replace(/^stream\//, '')]?.errors).map(d => d.id);
    return {id, status: failingJournals.length ? 'Error' : 'Success', failingJournals, error: null, totalJournalIds: details.length, succeededJournalIds: details.length - failingJournals.length, failedJournalIds: failingJournals.length, queuedJournalIds: 0};
  }
  mutate(name) {
    if (name === 'deployNewAccountVersion') {
      this.state.slots.new = emptySlot();
      delete this.state.metadata.newTypesUpdated; delete this.state.metadata.newTypesMethod;
    }
    else if (name === 'useNewAccountVersion' && this.state.slots.new) {
      this.state.slots.old = {types: this.state.types, docs: this.state.docs, tombstones: this.state.tombstones};
      for (const field of ['Updated', 'Method']) {
        const value = this.state.metadata[`liveTypes${field}`];
        if (value !== undefined) this.state.slots.old[`types${field}`] = value;
      }
      this.state.types = this.state.slots.new.types;
      this.state.docs = this.state.slots.new.docs;
      this.state.tombstones = this.state.slots.new.tombstones;
      for (const field of ['TypesUpdated', 'TypesMethod']) {
        if (this.state.metadata[`new${field}`]) this.state.metadata[`live${field}`] = this.state.metadata[`new${field}`];
        else delete this.state.metadata[`live${field}`];
        delete this.state.metadata[`new${field}`];
      }
      delete this.state.slots.new;
    } else if (name === 'useOldAccountVersion' || name === 'abandonSlot') {
      if (name === 'useOldAccountVersion' && this.state.slots.old) {
        const old = this.state.slots.old;
        this.state.types = old.types; this.state.docs = old.docs; this.state.tombstones = old.tombstones;
        for (const field of ['Updated', 'Method']) {
          if (old[`types${field}`] !== undefined) this.state.metadata[`liveTypes${field}`] = old[`types${field}`];
          else delete this.state.metadata[`liveTypes${field}`];
        }
        delete this.state.slots.old;
      }
      delete this.state.slots.new; delete this.state.metadata.newTypesUpdated; delete this.state.metadata.newTypesMethod;
    }
    this.changed(); return 'done';
  }
  reset() {
    this.state.types = {}; this.state.docs = {}; this.state.tombstones = {}; this.state.journals = {}; this.state.jobs = {}; this.state.slots = {};
    this.state.metadata = {}; this.state.webhooks = [];
    this.changed();
  }
}
