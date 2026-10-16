import http from 'node:http';
import {product} from './product.js';
import {aboutPage} from './about.js';
import {page} from './dashboard.js';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {TenantRegistry, authenticate, loopback, basicCredentials, constantEqual} from './tenants.js';
import {graphiqlHtml} from './graphiql.js';
import {pickerHtml} from './dashboard.js';
import {handleDashboard} from './dashboard-routes.js';
import {explorerHtml, explorerPickerHtml} from './explorer.js';
import {handleGraphql} from './graphql-handler.js';
import {handleProtocol} from './protocol-routes.js';
import {readBody} from './http-utils.js';
import {protectAdminPage} from './page-security.js';
import {truncate, redactUrl, extractRequestBody} from './request-log.js';
import {processMemory} from './process-memory.js';
export {authenticate};

/** Read environment settings; explicit createServer options override these. */
export function configuration(env = process.env) {
  return {port: Number(env.PORT ?? 8082), host: env.HOST ?? '127.0.0.1', corsOrigins: env.CORS_ORIGINS ?? '*', publicHostnames: env.PUBLIC_HOSTNAMES ?? '', appKey: env.GRAPH_APP_KEY ?? '', secret: env.GRAPH_SECRET ?? '', singleKey: env.GRAPH_SINGLE_KEY ?? '', tenantsFile: env.TENANTS_FILE ?? './tenants.json', adminUser: env.ADMIN_USER ?? '', adminPassword: env.ADMIN_PASSWORD ?? '', dataDir: env.DATA_DIR ?? './data', logDir: env.LOG_DIR ?? './logs', logBodies: (env.LOG_BODIES ?? 'true').toLowerCase() !== 'false'};
}

export function localAuthorities(host, port) {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const names = ['127.0.0.1', 'localhost', hostname].map(name => name.toLowerCase());
  return new Set(names.flatMap(name => Number(port) === 80 ? [name, `${name}:80`] : [`${name}:${port}`]));
}

/** Create an unbound server. All tests and embedders can use port 0. */
export function createServer(options = {}) {
  const config = {...configuration(), ...options}; const logger = config.logger ?? console;
  if (!loopback(config.host) && (!config.adminUser || !config.adminPassword)) throw new Error('ADMIN_USER and ADMIN_PASSWORD are required when HOST is not loopback');
  const registry = new TenantRegistry(config, logger); const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const started = performance.now(); let reqBody = null; let resBody = null; let runtime = null;
    const diagnostic = {};
    // /app/graphiql is framed by the CMS (Settings > GraphiQL) from another origin, so it stays embeddable.
    let embeddable = false;
    response.on('finish', () => {
      const headers = {...request.headers}; if (headers.authorization) headers.authorization = headers.authorization.split(/\s+/)[0];
      const byteLength = body => Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body) ?? '');
      const safeUrl = redactUrl(request.url);
      const entry = {ts: new Date().toISOString(), method: request.method, url: safeUrl, status: response.statusCode, ms: Math.round(performance.now() - started), headers,
        reqBody: config.logBodies ? truncate(reqBody) : null, resBody: config.logBodies ? truncate(resBody) : null,
        reqTruncated: config.logBodies && byteLength(reqBody) > 65536, resTruncated: config.logBodies && byteLength(resBody) > 65536,
        ...Object.fromEntries(['root', 'queryName', 'ops', 'journal'].filter(key => diagnostic[key] != null).map(key => [key, diagnostic[key]]))};
      const log = runtime && !diagnostic.suppressTenantLog ? runtime.log : registry.unrouted;
      log.append(entry);
      const details = ['queryName', 'root', 'ops', 'journal'].filter(key => diagnostic[key] != null).map(key => ` ${key === 'queryName' ? 'query' : key}=${key === 'queryName' ? JSON.stringify(diagnostic[key]) : diagnostic[key]}`).join('');
      logger.log(`[${runtime?.tenant.id ?? '_unrouted'}] ${request.method} ${safeUrl} ${response.statusCode} ${entry.ms}ms${details}`);
    });
    function send(status, body, contentType = 'application/json; charset=utf-8') {
      resBody = body; response.statusCode = status; response.setHeader('Content-Type', contentType);
      if (contentType.startsWith('text/html') && !embeddable) protectAdminPage(response);
      response.end(status === 204 ? undefined : contentType.startsWith('application/json') ? JSON.stringify(body) : body); return true;
    }
    function redirect(location) { response.setHeader('Location', location); return send(303, 'Redirecting', 'text/plain; charset=utf-8'); }
    try {
      const url = new URL(request.url, 'http://localhost'); let path = url.pathname.replace(/\/$/, '') || '/'; const method = request.method;
      const queryRoute = path === '/content/v2';
      const htmlRequest = method === 'GET' && queryRoute && (request.headers.accept ?? '').includes('text/html') && !url.searchParams.has('query');
      const corsRoute = queryRoute && !htmlRequest && ['GET', 'POST', 'OPTIONS'].includes(method);
      const admin = basicCredentials(request.headers.authorization);
      const validAdmin = Boolean(admin && constantEqual(admin.appKey, config.adminUser) && constantEqual(admin.secret, config.adminPassword) && config.adminUser && config.adminPassword);
      const authorities = localAuthorities(config.host, request.socket.localPort);
      const publicHosts = String(config.publicHostnames).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      const matchesPublic = authority => publicHosts.some(value => {
        try {
          const allowed = new URL(value.includes('://') ? value : `http://${value}`);
          const candidate = new URL(`http://${authority}`);
          return allowed.hostname === candidate.hostname && (!allowed.port || allowed.port === candidate.port);
        } catch { return false; }
      });
      if (loopback(config.host) && !authorities.has(request.headers.host?.toLowerCase()) && !matchesPublic(request.headers.host)) return send(403, {message: 'Host is not allowed'});
      const origin = request.headers.origin;
      let sameOrigin = origin == null;
      if (origin != null) {
        try {
          const parsed = new URL(origin);
          if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) {
            sameOrigin = (parsed.protocol === 'http:' && authorities.has(parsed.host.toLowerCase())) || matchesPublic(parsed.host) || (!loopback(config.host) && validAdmin && parsed.host.toLowerCase() === request.headers.host?.toLowerCase());
          }
        } catch { /* invalid origins are cross-origin */ }
      }
      const crossOrigin = !sameOrigin;
      if (!corsRoute && (method === 'OPTIONS' || crossOrigin)) return send(403, {message: 'A same-origin request is required'});
      if (corsRoute) {
        const origins = String(config.corsOrigins).split(',').map(value => value.trim()).filter(Boolean);
        if (crossOrigin && !origins.includes('*') && !origins.includes(origin)) return send(403, {message: 'Origin is not allowed'});
        response.setHeader('Access-Control-Allow-Origin', origin ?? '*');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Query-Name, cg-username, cg-roles, cg-include-deleted, cg-include-expired, cg-use-new, cg-query-new, cg-deploy-new');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Max-Age', '600'); response.setHeader('Vary', 'Origin');
        if (queryRoute && crossOrigin && /^Basic(?:\s|$)/i.test(request.headers.authorization ?? '')) return send(403, {message: 'Cross-origin Basic authentication is forbidden'});
        if (method === 'OPTIONS') return send(204, null);
      }
      const adminRoute = path === '/about' || path.startsWith('/about/') || path === '/' || path === '/tenants' || path.startsWith('/tenants/') || path.startsWith('/__debug/') || path === '/graphiql' || path === '/explorer' || htmlRequest;
      // Health never causes a store to load. Legacy logging remains accessible to old embedders.
      if (method === 'GET' && path === '/health') {
        if (registry.legacy) runtime = registry.get('default', false);
        return send(200, {status: 'ok', product: product.key, version: product.version, dataVersion: product.dataVersion, ...(!loopback(config.host) && !validAdmin ? {} : {tenants: registry.health(), memory: processMemory()})});
      }
      if (adminRoute && !loopback(config.host)) {
        if (!validAdmin) {
          response.setHeader('WWW-Authenticate', 'Basic realm="LDA Local Graph"'); return send(401, {message: 'Administrator credentials are required'});
        }
        if (crossOrigin) return send(403, {message: 'A same-origin request is required for admin access'});
      }
      if (method === 'GET' && (path === '/about' || path.startsWith('/about/'))) {
        const result = await aboutPage(path); return send(result.status, result.html, 'text/html; charset=utf-8');
      }
      const legacyReset = method === 'POST' && path === '/__debug/reset';
      if (path.startsWith('/__debug/')) {
        if (registry.entries.length !== 1) return send(400, {message: 'Choose a tenant: ' + registry.entries.map(tenant => `/tenants/${tenant.id}/...`).join(', ')});
        path = `/tenants/${registry.entries[0].id}/` + path.slice('/__debug/'.length);
      }
      const tenantRoute = /^\/tenants\/([^/]+)(?:\/|$)/.exec(path);
      if (tenantRoute) {
        runtime = registry.get(decodeURIComponent(tenantRoute[1]));
        if (!runtime) return send(404, {message: 'Tenant not found'});
        if (runtime.busy) return send(503, {message: 'Tenant storage maintenance in progress'});
      }
      if (method === 'GET' && path === '/app/graphiql') {
        embeddable = true;
        const key = url.searchParams.get('auth');
        const tenant = key && registry.entries.find(entry => constantEqual(entry.singleKey, key));
        if (!tenant) return send(404, page('Unknown Graph key', '<p>Unknown Graph key</p>'), 'text/html; charset=utf-8');
        runtime = registry.get(tenant.id, false);
        return send(200, graphiqlHtml(tenant.singleKey, url.searchParams.get('query') ?? undefined, url.searchParams.get('slot') === 'new'), 'text/html; charset=utf-8');
      }
      if (method === 'GET' && (path === '/graphiql' || htmlRequest)) {
        let id = url.searchParams.get('tenant');
        if (!id && registry.entries.length !== 1) return send(200, pickerHtml(registry), 'text/html; charset=utf-8');
        id ??= registry.entries[0].id; const tenant = registry.find(id);
        if (!tenant) return send(404, {message: 'Tenant not found'});
        runtime = registry.get(id, false);
        return send(200, graphiqlHtml(tenant.singleKey, url.searchParams.get('query') ?? undefined, url.searchParams.get('slot') === 'new'), 'text/html; charset=utf-8');
      }
      if (method === 'GET' && path === '/explorer') {
        const id = url.searchParams.get('tenant');
        if (!id && registry.entries.length === 1) return redirect('/explorer?tenant=' + encodeURIComponent(registry.entries[0].id));
        if (!id) return send(200, explorerPickerHtml(registry), 'text/html; charset=utf-8');
        if (!registry.find(id)) return send(404, {message: 'Tenant not found'});
        runtime = registry.get(id);
        if (runtime.busy) return send(503, {message: 'Tenant storage maintenance in progress'});
        const result = await explorerHtml(runtime, url.searchParams);
        return send(result.status, result.html, 'text/html; charset=utf-8');
      }
      let identity = null;
      if (!adminRoute) {
        const routed = registry.route(request.headers, url, queryRoute);
        if (!routed) return send(401, {message: registry.legacy ? 'Invalid credentials' : 'Unknown or missing credentials'});
        runtime = routed.runtime; identity = routed.identity;
        if (runtime.busy) return send(503, {message: 'Tenant storage maintenance in progress'});
      } else if (!runtime && registry.legacy) runtime = registry.get('default');
      const auth = typeof identity === 'object' && identity ? identity.kind : identity;
      const pushRoute = /^\/(api|_stream|_doc|journal|account|extract|clientlog)(\/|$)/.test(path);
      if (pushRoute && auth !== 'basic') return send(401, {message: 'Invalid credentials'});
      const queryHeaders = {...request.headers};
      if (identity && typeof identity === 'object') {
        queryHeaders['cg-username'] = encodeURIComponent(identity.username); queryHeaders['cg-roles'] = encodeURIComponent(identity.roles.join(','));
        if (identity.expired) logger.log(`[${runtime.tenant.id}] Preview token expired; lifetime ignored to match the CMS client`);
      }
      let bytes = Buffer.alloc(0); let text = '';
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        bytes = await readBody(request); text = bytes.toString('utf8'); reqBody = path === '/extract' ? extractRequestBody(bytes) : text;
        if (text && !['/_stream', '/extract'].includes(path)) { try { reqBody = JSON.parse(text); } catch { /* route validates */ } }
      }
      if (runtime?.busy || (runtime && !registry.find(runtime.tenant.id))) return send(503, {message: 'Tenant storage maintenance in progress'});
      if (adminRoute) {
        if (await handleDashboard({path, method, url, text, headers: request.headers, registry, token, send, redirect, host: request.headers.host, diagnostic, runtime, legacyReset})) return;
      }
      if (queryRoute && ['POST', 'GET'].includes(method)) {
        diagnostic.queryName = request.headers['x-query-name'];
        return await handleGraphql({method, text, url, crossOrigin, schemas: runtime.schemas, querySlot: ['cg-query-new', 'cg-use-new'].some(name => request.headers[name]?.toLowerCase() === 'true') ? 'new' : 'live', queryHeaders, auth, send, diagnostic});
      }
      if (runtime && await handleProtocol({path, method, url, text, bytes, headers: request.headers, store: runtime.store, rebuild: runtime.rebuild, slot: request.headers['cg-deploy-new'] === 'true' ? 'new' : 'live', source: url.searchParams.get('id') || 'default', send, diagnostic})) return;
      return send(404, {message: 'Not found'});
    } catch (error) {
      logger.error(error.stack ?? error.message);
      if (!response.headersSent) send(error.status ?? 400, {message: error.message}); else response.end();
    }
  });
  // Preserve the single-tenant embedding API without eager loading at startup.
  Object.defineProperty(server, 'store', {get() { return registry.entries.length === 1 ? registry.get(registry.entries[0].id).store : undefined; }});
  Object.defineProperty(server, 'recentRequests', {get() { return registry.entries.length === 1 ? registry.get(registry.entries[0].id, false).log.recent : registry.unrouted.recent; }});
  server.tenants = registry; server.config = config;
  const close = server.close;
  server.close = function(callback) { return close.call(this, async error => { await registry.close(); callback?.(error); }); };
  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  const logger = options.logger ?? console;
  if (!loopback(server.config.host)) (logger.warn ?? logger.error).call(logger, `WARNING: ${product.name} is for development only.\nAnyone on the network can reach this server (HOST=${server.config.host}).\nNever point a shared or production site at it.`);
  (options.logger ?? console).log(`JavaScript heap limit: ${(processMemory().heapLimit / (1024 * 1024)).toFixed(0)} MiB`);
  try { await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(server.config.port, server.config.host, resolveListen); }); }
  catch (error) { await server.tenants.close(); throw error; }
  (options.logger ?? console).log(`${product.name} ${product.version} (${product.suite}) listening at http://${server.config.host}:${server.address().port} — development use only`); return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let server;
  try { server = await startServer(); } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
  if (server) {
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; server.close(error => { if (error) { console.error(error); process.exitCode = 1; } }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGBREAK', stop);
  }
}
