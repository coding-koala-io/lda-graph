import {getHeapStatistics} from 'node:v8';
import {readFileSync, promises as fs} from 'node:fs';
import {join} from 'node:path';

const HOUR = 3600000;
// WinSW v2.12.0 doc/xmlConfigFile.md: BASE is inherited by the child process.
export function recycleSettings({value = process.env.MEMORY_RECYCLE_MB, env = process.env, platform = process.platform, heapLimit = getHeapStatistics().heap_size_limit} = {}) {
  const automatic = value == null || value === '';
  const thresholdMb = automatic ? (platform === 'win32' && Boolean(env.BASE) ? heapLimit * 0.75 / 1048576 : 0) : Number(value);
  return {enabled: Number.isFinite(thresholdMb) && thresholdMb > 0, thresholdMb: Number.isFinite(thresholdMb) ? Math.max(0, thresholdMb) : 0};
}

/** Pure decision logic; readings and time are explicit for deterministic tests. */
export function recycleDecision(state, {heapUsed, now, thresholdMb, last}) {
  state.consecutive = heapUsed > thresholdMb * 1048576 ? (state.consecutive ?? 0) + 1 : 0;
  if (state.consecutive < 3) return 'wait';
  if (Number.isFinite(Date.parse(last)) && now - Date.parse(last) < HOUR) {
    if (state.warnedAt == null || now - state.warnedAt >= HOUR) { state.warnedAt = now; return 'warn'; }
    return 'wait';
  }
  return 'recycle';
}

export function startRecycle({server, registry, logDir, logger = console, value, env = process.env, platform = process.platform,
  memory = () => process.memoryUsage().heapUsed, now = Date.now, exit = code => process.exit(code), drainMs = 5000, intervalMs = 30000} = {}) {
  const settings = recycleSettings({value, env, platform}); const state = {};
  const file = logDir === ':memory:' ? null : join(logDir, '_recycle.json');
  let last = null; let running = false;
  if (file) { try { const saved = JSON.parse(readFileSync(file, 'utf8')); if (Number.isFinite(Date.parse(saved.last))) last = saved.last; } catch (error) { if (error.code !== 'ENOENT') logger.error(`Recycle history unavailable: ${error.message}`); } }
  async function tick() {
    if (!settings.enabled || running) return;
    const heapUsed = memory();
    const action = recycleDecision(state, {heapUsed, now: now(), thresholdMb: settings.thresholdMb, last});
    if (action === 'warn') { (logger.warn ?? logger.error).call(logger, 'Memory recycle delayed: last recycle was less than 60 minutes ago'); return; }
    if (action !== 'recycle') return;
    running = true;
    logger.log(`Recycling: heapUsed ${(heapUsed / 1048576).toFixed(0)} MB > threshold ${settings.thresholdMb.toFixed(0)} MB; data will be saved and the service restarted`);
    clearInterval(timer);
    // Stop admission immediately; let active requests drain before flushing.
    let timeout;
    const closed = new Promise(resolve => server.close(error => { if (error) logger.error(`Recycle close failed: ${error.message}`); resolve(); }));
    await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, drainMs); })]);
    clearTimeout(timeout);
    for (const runtime of registry.runtimes.values()) if (runtime.store) {
      try { await runtime.store.flush({onlyIfChanged: true}); } catch (error) { logger.error(`Recycle flush failed [${runtime.tenant.id}]: ${error.message}`); }
    }
    last = new Date(now()).toISOString();
    try {
      if (file) { await fs.mkdir(logDir, {recursive: true}); await fs.writeFile(`${file}.tmp`, JSON.stringify({last})); await fs.rename(`${file}.tmp`, file); }
    } catch (error) { logger.error(`Recycle history write failed: ${error.message}`); }
    exit(75);
  }
  const timer = settings.enabled ? setInterval(() => tick().catch(error => { logger.error(`Recycle failed: ${error.message}`); exit(75); }), intervalMs) : null;
  timer?.unref();
  return {tick, stop: () => clearInterval(timer), health: () => ({...settings, last})};
}
