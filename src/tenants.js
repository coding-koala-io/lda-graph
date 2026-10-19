import {existsSync, statSync, readFileSync, mkdirSync, renameSync, readdirSync, watch, watchFile, unwatchFile, promises as fs} from 'node:fs';
import {resolve, join, dirname, basename} from 'node:path';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {product} from './product.js';
import {Store} from './store.js';
import {buildSchema} from './schema.js';
import {mergeSourceModels} from './content-sources.js';
import {verifyPreviewToken} from './auth.js';
import {RequestLog} from './request-log.js';

export const loopback = host => /^(localhost|\[?::1\]?|127(?:\.\d{1,3}){3}|::ffff:127(?:\.\d{1,3}){3})$/i.test(host);
export const constantEqual = (a, b) => {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
export function basicCredentials(header = '') {
  const match = /^Basic\s+([a-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  const value = Buffer.from(match[1], 'base64').toString('utf8'); const colon = value.indexOf(':');
  return colon < 0 ? null : {appKey: value.slice(0, colon), secret: value.slice(colon + 1)};
}

/** Strict file-mode keys; permissive legacy keys are never silently written to disk. */
export function validateTenants(input, logger = console) {
  if (!input || !Array.isArray(input.tenants)) throw new Error('tenants.json must contain a tenants array');
  const ids = new Set(); const keys = new Set();
  return input.tenants.map((entry, index) => {
    const label = `Tenant entry ${index + 1}${entry?.id ? ` (${entry.id})` : ''}`;
    const fail = message => { throw new Error(`${label}: ${message}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('must be an object');
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.id)) fail('invalid id (use lowercase letters, digits and hyphens, maximum 63 characters)');
    if (ids.has(entry.id)) fail('duplicate id'); ids.add(entry.id);
    for (const key of ['appKey', 'singleKey']) {
      if (typeof entry[key] !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(entry[key])) fail(`${key} must match ^[A-Za-z0-9._~-]{1,200}$ (no spaces or colon)`);
      if (keys.has(entry[key])) fail(`${key} duplicates another appKey or singleKey`);
      keys.add(entry[key]);
    }
    if (typeof entry.secret !== 'string' || !entry.secret || entry.secret !== entry.secret.trim()) fail('secret must be non-empty without leading/trailing whitespace');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.secret) || Buffer.from(entry.secret, 'base64').toString('base64') !== entry.secret) {
      (logger.warn ?? logger.error).call(logger, `${label}: secret is not valid Base64; CMS preview requires Base64`);
    }
    if (entry.name != null && typeof entry.name !== 'string') fail('name must be a string');
    return {id: entry.id, name: entry.name?.trim() ? entry.name : entry.id, appKey: entry.appKey, secret: entry.secret, singleKey: entry.singleKey};
  });
}

/** Backward-compatible authentication helper for env-mode callers. */
export function authenticate(headers, url, config, graphql = false) {
  const authorization = headers.authorization;
  if (authorization) {
    const basic = basicCredentials(authorization);
    if (basic) return config.appKey && (!constantEqual(basic.appKey, config.appKey) || !constantEqual(basic.secret, config.secret)) ? null : 'basic';
    const match = /^(epi-single|bearer)\s+(.+)$/i.exec(authorization);
    if (graphql && match?.[1].toLowerCase() === 'epi-single') return !config.singleKey || constantEqual(match[2], config.singleKey) ? 'single' : null;
    if (graphql && match?.[1].toLowerCase() === 'bearer') return verifyPreviewToken(match[2], config);
    return null;
  }
  if (graphql && url.searchParams.has('auth')) return !config.singleKey || constantEqual(url.searchParams.get('auth'), config.singleKey) ? 'single' : null;
  return graphql && !config.singleKey ? 'single' : null;
}

export class TenantRegistry {
  constructor(config, logger) {
    this.config = config; this.logger = logger; this.file = resolve(config.tenantsFile);
    this.runtimes = new Map(); this.writeQueue = Promise.resolve();
    this.loadedText = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
    this.legacy = !existsSync(this.file);
    if (this.legacy) {
      if (Boolean(config.appKey) !== Boolean(config.secret)) throw new Error('GRAPH_APP_KEY and GRAPH_SECRET must both be set or both be empty');
      this.entries = [{id: 'default', name: 'Default', appKey: config.appKey, secret: config.secret, singleKey: config.singleKey}];
    } else {
      this.entries = this.read(this.loadedText);
      if (config.appKey || config.secret || config.singleKey) (logger.warn ?? logger.error).call(logger, 'tenants.json exists; GRAPH_APP_KEY/GRAPH_SECRET/GRAPH_SINGLE_KEY are ignored');
    }
    this.migrateDefault();
    this.unrouted = new RequestLog(this.folder(config.logDir, '_unrouted'), logger);
    this.startWatching();
  }
  folder(root, id) { return root === ':memory:' ? root : join(root, id); }
  folderExists(id) {
    return [this.config.dataDir, this.config.logDir].some(root => root !== ':memory:' && existsSync(this.folder(root, id)));
  }
  read(text = readFileSync(this.file, 'utf8')) {
    try {
      const input = JSON.parse(text);
      // Only an absent dataVersion means 1; anything else but a positive integer (null included) is refused rather than guessed.
      const dataVersion = input !== null && typeof input === 'object' && Object.hasOwn(input, 'dataVersion') ? input.dataVersion : 1;
      if (typeof dataVersion !== 'number' || !Number.isInteger(dataVersion) || dataVersion < 1) {
        const error = new Error(`Data in ${this.file} has an invalid dataVersion (${JSON.stringify(dataVersion)}).`);
        error.exitCode = 3; throw error;
      }
      if (dataVersion > product.dataVersion) {
        const error = new Error(`Data in ${this.file} was written by a newer version (dataVersion ${dataVersion}). Upgrade ${product.name} or restore a backup.`);
        error.exitCode = 3; throw error;
      }
      return validateTenants(input, this.logger);
    }
    catch (error) { if (error.exitCode === 3) throw error; throw new Error(`Invalid ${this.file}: ${error.message}`); }
  }
  startWatching() {
    // Watching the directory survives atomic editor renames and creation of a missing file.
    const changed = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 300); this.reloadTimer.unref();
    };
    try {
      this.watcher = watch(dirname(this.file), {persistent: false}, (_, name) => {
        if (name && String(name) !== basename(this.file)) return;
        changed();
      });
      this.watcher.on('error', error => this.logger.error(`Tenant watcher failed: ${error.message}`));
    } catch {
      // A custom config parent can be created later by an editor/dashboard.
      this.fileWatcher = changed; watchFile(this.file, {persistent: false, interval: 100}, changed);
    }
  }
  reload() {
    return this.enqueue(async () => {
      if (this.closed) return false;
      try {
        const text = readFileSync(this.file, 'utf8');
        await this.apply(this.read(text)); this.loadedText = text;
        this.logger.log('Tenant configuration reloaded'); return true;
      } catch (error) { this.logger.error(`Tenant reload rejected; keeping previous configuration: ${error.message}`); return false; }
    });
  }
  enqueue(work) {
    const operation = this.writeQueue.then(work);
    this.writeQueue = operation.catch(() => {}); return operation;
  }
  async apply(entries, {renameFrom, commit = async () => {}} = {}) {
    const active = new Set(entries.map(entry => entry.id));
    const renames = this.entries.filter(old => !active.has(old.id)).map(old => {
      const next = entries.find(entry => !this.find(entry.id) && (renameFrom === old.id || entry.appKey === old.appKey));
      return next ? {old, next} : null;
    }).filter(Boolean);
    const moves = renames.flatMap(({old, next}) => [this.config.dataDir, this.config.logDir].filter(root => root !== ':memory:').map(root => ({from: this.folder(root, old.id), to: this.folder(root, next.id)})));
    const checkTargets = () => { for (const move of moves) if (existsSync(move.to)) throw new Error(`Cannot rename tenant: target folder already exists: ${resolve(move.to)}`); };
    checkTargets();
    const evicted = [...this.runtimes].filter(([id]) => !active.has(id));
    for (const [, runtime] of evicted) runtime.busy = true;
    const moved = [];
    try {
      for (const [, runtime] of evicted) if (runtime.store) await runtime.store.flush({onlyIfChanged: true});
      checkTargets();
      for (const move of moves) if (existsSync(move.from)) { renameSync(move.from, move.to); moved.push(move); }
      await commit();
    } catch (error) {
      for (const move of moved.reverse()) renameSync(move.to, move.from);
      throw error;
    } finally { for (const [, runtime] of evicted) runtime.busy = false; }
    if (this.legacy && (this.config.appKey || this.config.secret || this.config.singleKey)) (this.logger.warn ?? this.logger.error).call(this.logger, 'tenants.json exists; GRAPH_APP_KEY/GRAPH_SECRET/GRAPH_SINGLE_KEY are ignored');
    for (const [id, runtime] of evicted) {
      runtime.store?.dispose();
      this.runtimes.delete(id);
      const renamed = renames.find(({old}) => old.id === id);
      if (renamed) runtime.log.dir = this.folder(this.config.logDir, renamed.next.id);
      // A request completing after eviction must not recreate the old folder.
      else runtime.log.disabled = true;
    }
    this.entries = entries; this.legacy = false;
    for (const {old, next} of renames) {
      const runtime = evicted.find(([id]) => id === old.id)?.[1];
      if (!runtime) continue;
      // Share the moved log writer with requests already finishing so numbering stays monotonic.
      const replacement = this.get(next.id, false); replacement.log = runtime.log;
      if (this.config.dataDir === ':memory:' && runtime.store) {
        this.get(next.id); replacement.store.state = runtime.store.state; replacement.rebuild();
      }
    }
    for (const entry of entries) { const runtime = this.runtimes.get(entry.id); if (runtime) runtime.tenant = entry; }
    this.migrateDefault();
  }
  find(id) { return this.entries.find(entry => entry.id === id); }
  get(id, load = true) {
    const tenant = this.find(id); if (!tenant) return null;
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {tenant, store: null, schemas: {}, log: new RequestLog(this.folder(this.config.logDir, id), this.logger)};
      this.runtimes.set(id, runtime);
    }
    if (load && !runtime.store) {
      const started = performance.now();
      const folder = this.folder(this.config.dataDir, id);
      const size = folder === ':memory:' ? 0 : ['store.ndjson', 'store.json'].reduce((sum, file) => sum + (existsSync(join(folder, file)) ? statSync(join(folder, file)).size : 0), 0);
      this.logger.log(`[${id}] loading store (${(size / 1048576).toFixed(1)} MB)…`);
      runtime.store = this.legacy && id === 'default' && this.config.store ? this.config.store : new Store({dataDir: folder, logger: this.logger, tenant: id, previousSlotHours: this.config.previousSlotHours});
      runtime.rebuild = () => {
        const conflicts = new Set();
        for (const slot of ['live', 'new']) {
          const model = mergeSourceModels(runtime.store.slot(slot).types, (source, name) => conflicts.add(`${source}:${name}`));
          runtime.schemas[slot] = buildSchema(model, runtime.store, {previous: runtime.schemas[slot], logger: this.logger, onMutation: runtime.rebuild});
        }
        if (conflicts.size) (this.logger.warn ?? this.logger.error).call(this.logger, `Source type name clash; keeping the first definition (default takes precedence): ${[...conflicts].join(', ')}`);
      };
      runtime.rebuild(); runtime.log.load();
      this.logger.log(`[${id}] loaded store in ${(performance.now() - started).toFixed(0)} ms`);
    }
    return runtime;
  }
  route(headers, url, graphql = false) {
    if (this.legacy) {
      const identity = authenticate(headers, url, this.entries[0], graphql);
      return identity ? {runtime: this.get('default'), identity} : null;
    }
    const authorization = headers.authorization ?? '';
    const basic = basicCredentials(authorization);
    let tenant; let identity;
    if (basic) {
      tenant = this.entries.find(entry => entry.appKey === basic.appKey);
      if (!tenant || !constantEqual(basic.secret, tenant.secret)) return null;
      identity = 'basic';
    } else {
      const match = /^(epi-single|bearer)\s+(.+)$/i.exec(authorization);
      if (match?.[1].toLowerCase() === 'bearer') {
        try { const claims = JSON.parse(Buffer.from(match[2].split('.')[1], 'base64url').toString()); tenant = this.entries.find(entry => entry.appKey === claims.appKey); } catch { return null; }
        identity = tenant && verifyPreviewToken(match[2], tenant);
      } else {
        const key = match?.[1].toLowerCase() === 'epi-single' ? match[2] : !authorization ? url.searchParams.get('auth') : null;
        tenant = key && this.entries.find(entry => constantEqual(entry.singleKey, key)); identity = tenant && 'single';
      }
    }
    return tenant && identity ? {runtime: this.get(tenant.id), identity} : null;
  }
  legacyFiles() {
    const root = this.config.dataDir;
    if (root === ':memory:' || !existsSync(root)) return [];
    return readdirSync(root).filter(name => /^store\.(ndjson|json)$/.test(name) || /^store\.(json\.migrated-|corrupt-)/.test(name));
  }
  migrateDefault() {
    const files = this.legacyFiles();
    if (this.find('default')) {
      const target = this.folder(this.config.dataDir, 'default');
      if (files.length && !existsSync(target)) { mkdirSync(target, {recursive: true}); for (const name of files) renameSync(join(this.config.dataDir, name), join(target, name)); }
      const root = this.config.logDir;
      if (root !== ':memory:' && existsSync(root)) {
        const logs = readdirSync(root).filter(name => /^requests\.ndjson(?:\..*)?$/.test(name));
        const destination = this.folder(root, 'default');
        // An existing tenant log is never overwritten; leave conflicting files for manual import.
        const conflicts = logs.filter(name => existsSync(join(destination, name)));
        if (conflicts.length) (this.logger.warn ?? this.logger.error).call(this.logger, `Root request logs retained: destination files already exist: ${conflicts.join(', ')}`);
        if (logs.length && !conflicts.length) { mkdirSync(destination, {recursive: true}); for (const name of logs) renameSync(join(root, name), join(destination, name)); }
      }
    } else if (files.length) (this.logger.warn ?? this.logger.error).call(this.logger, 'Root-level legacy store left in place: use Import legacy store on a tenant dashboard to import it');
  }
  async importLegacy(id) {
    const runtime = this.get(id); const files = this.legacyFiles();
    if (!files.some(name => /^store\.(ndjson|json)$/.test(name))) throw new Error('No root-level legacy store exists');
    const state = runtime.store.state;
    if (Object.keys(state.docs).length || Object.keys(state.types).length || Object.keys(state.journals).length || Object.keys(state.jobs).length || state.webhooks.length || Object.keys(state.tombstones).length || state.slots.new || state.slots.old) throw new Error('Import requires an empty tenant; reset everything first');
    runtime.busy = true;
    try {
      await runtime.store.flush({onlyIfChanged: true}); const target = runtime.store.dataDir;
      const oldFiles = (await fs.readdir(target)).filter(name => /^store\.(ndjson|json)$/.test(name) || /^store\.(json\.migrated-|corrupt-)/.test(name));
      const backup = join(target, `before-import-${randomUUID()}`);
      if (oldFiles.length) { await fs.mkdir(backup); for (const name of oldFiles) await fs.rename(join(target, name), join(backup, name)); }
      for (const name of files) await fs.rename(join(this.config.dataDir, name), join(target, name));
      runtime.store.dispose();
      runtime.store = new Store({dataDir: target, logger: this.logger, tenant: id, previousSlotHours: this.config.previousSlotHours}); runtime.rebuild();
    } finally { runtime.busy = false; }
  }
  /** Serialize dashboard edits so concurrent submissions cannot lose tenants. */
  get defaultNeedsKeys() { return this.legacy && ['appKey', 'secret', 'singleKey'].some(key => !this.entries[0][key]); }
  assertDiskUnchanged() {
    const text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null;
    if (text !== this.loadedText) {
      let detail = '';
      if (text !== null) { try { this.read(text); } catch (error) { detail = `: ${error.message}`; } }
      throw new Error(`tenants.json was changed on disk — reload or fix it first${detail}`);
    }
  }
  edit(change, {initializeDefault = false, renameFrom} = {}) {
    return this.enqueue(async () => {
      this.assertDiskUnchanged();
      if (this.defaultNeedsKeys && !initializeDefault) throw new Error('Give the default instance explicit keys first. Update the CMS appsettings to match before using file mode.');
      const existing = this.entries.map(entry => ({...entry}));
      const entries = validateTenants({tenants: change(existing)}, this.logger);
      if (initializeDefault && !entries.some(entry => entry.id === 'default')) throw new Error('Give the default instance explicit keys first; keep its id as default');
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const writtenText = JSON.stringify({dataVersion: product.dataVersion, tenants: entries}, null, 2) + '\n';
      await fs.mkdir(dirname(this.file), {recursive: true});
      try {
        await fs.writeFile(temporary, writtenText);
        await this.apply(entries, {renameFrom, commit: async () => {
          this.assertDiskUnchanged();
          // Synchronous promotion leaves no event-loop gap after the conflict check.
          renameSync(temporary, this.file); this.loadedText = writtenText;
        }});
      }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
  }
  async deleteFolders(id, runtime) {
    if (runtime?.store) await runtime.store.flush({onlyIfChanged: true});
    for (const root of [this.config.dataDir, this.config.logDir]) {
      if (root === ':memory:') continue;
      const base = resolve(root); const target = resolve(root, id);
      if (dirname(target) !== base || basename(target) !== id) throw new Error('Unsafe tenant folder');
      await fs.rm(target, {recursive: true, force: true});
    }
  }
  health() {
    return Object.fromEntries(this.entries.map(({id}) => { const runtime = this.runtimes.get(id); return [id, {loaded: Boolean(runtime?.store), docs: runtime?.store ? Object.keys(runtime.store.state.docs).length : 0}]; }));
  }
  async close() {
    this.closed = true; this.watcher?.close(); if (this.fileWatcher) unwatchFile(this.file, this.fileWatcher); clearTimeout(this.reloadTimer); await this.writeQueue;
    for (const runtime of this.runtimes.values()) if (runtime.store) {
      runtime.store.dispose();
      try { await runtime.store.flush({onlyIfChanged: true}); } catch (error) { this.logger.error(`Shutdown persistence failed: ${error.message} [${runtime.tenant.id}]`); }
    }
  }
}
