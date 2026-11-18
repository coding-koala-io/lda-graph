import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {screenshotPages, outputPath, outputDirectory, widths, manifest, imageChanges, findBrowser, withDemoServer,
  assertPrivateTextAbsent, demoTime, demoCorrelationId, configurePage, clippedGraphiQLEditors} from '../scripts/screenshots.mjs';

const demoDirectory = '.test-runtime/screenshots-demo';
const identity = {username: 'InventedUser', home: 'C:\\Users\\InventedUser', suffix: 'aB9xYz'};

test('screenshots cover every distinct standalone HTML screen with safe, fixed output paths', () => {
  const pages = screenshotPages({journalId: 'invented-journal', requestId: 4});
  assert.deepEqual(pages.map(page => page.name), [
    'dashboard', 'about', 'privacy', 'licence', 'legal', 'tenant', 'tenant-edit', 'document', 'request', 'sync-job', 'journal',
    'graphiql-picker', 'graphiql', 'explorer-picker', 'explorer', 'explorer-type', 'explorer-search', 'explorer-item',
    'confirm-content', 'confirm-types', 'confirm-jobs', 'confirm-requests', 'confirm-all', 'confirm-delete',
  ]);
  assert.deepEqual(widths, [720, 360]);
  const files = pages.flatMap(page => widths.map(width => outputPath(page.name, width)));
  assert.equal(new Set(files).size, 48);
  assert.ok(files.every(file => /^docs\/media\/screens\/[a-z-]+-(720|360)\.png$/.test(file)));
  assert.equal(outputPath('graphiql', 360), 'docs/media/screens/graphiql-360.png');
  assert.ok(!pages.some(page => page.path.startsWith('/app/')));
  assert.deepEqual(pages.filter(page => page.action).map(page => page.action), ['content', 'types', 'jobs', 'requests', 'all', 'delete']);
  for (const name of ['../escape', '/absolute', 'a/b', 'a\\b', 'a.png', '', 'UPPER']) assert.throws(() => outputPath(name, 720));
  for (const width of [0, 361, '360', NaN]) assert.throws(() => outputPath('about', width));
  const text = manifest(pages);
  for (const file of files) assert.ok(text.includes(file.slice(outputDirectory.length + 1)));
  assert.equal(text, manifest(screenshotPages({journalId: 'different-journal', requestId: 200})));
  assert.ok(!text.includes('invented-journal') && !text.includes('timestamp'));
});

test('screenshots report byte-level added, changed, unchanged and removed files', () => {
  assert.deepEqual(imageChanges(new Map([['same.png', 'a'], ['changed.png', 'b'], ['old.png', 'c']]),
    new Map([['same.png', 'a'], ['changed.png', 'd'], ['new.png', 'e']])),
  {added: ['new.png'], changed: ['changed.png'], unchanged: ['same.png'], removed: ['old.png']});
});

const box = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const region = bounds => ({checkVisibility: () => true, getBoundingClientRect: () => bounds});
const makeEditor = (pane, text, scrollHeight = pane.height) => ({
  ...region(pane),
  querySelectorAll: selector => selector === '.CodeMirror-code pre.CodeMirror-line' ? [{textContent: 'demo', text}] : [],
  CodeMirror: {getScrollInfo: () => ({height: scrollHeight, clientHeight: pane.height})},
});

function stackedRegions(width, queryTop) {
  const paneWidth = width - 92;
  const query = box(68, queryTop, paneWidth, 224);
  const tabs = box(68, query.bottom, paneWidth, 56);
  const tabBar = region(tabs);
  const buttons = {
    'button[data-name="variables"]': {...region(box(76, tabs.top + 8, 86, 40)), text: box(88, tabs.top + 18, 62, 22), parentElement: tabBar},
    'button[data-name="headers"]': {...region(box(170, tabs.top + 8, 80, 40)), text: box(182, tabs.top + 18, 56, 22), parentElement: tabBar},
  };
  tabBar.style = {overflowX: 'visible', overflowY: 'visible'};
  tabBar.querySelector = selector => buttons[selector];
  return {queryRegion: region(query), tabBar, responseRegion: region(box(68, tabs.bottom + 8, paneWidth, 430))};
}

function checkGraphiQL(query, response, width = 360, regions = stackedRegions(width, 237)) {
  let selected;
  const document = {
    documentElement: {clientWidth: width, scrollHeight: 1200},
    querySelector: selector => ({
      '#graphiql .graphiql-query-editor': regions.queryRegion,
      '#graphiql .graphiql-editor-tools': regions.tabBar,
      '#graphiql .graphiql-response': regions.responseRegion,
      '#graphiql .graphiql-query-editor .CodeMirror': query,
      '#graphiql .graphiql-response .CodeMirror': response,
    })[selector],
    createRange: () => ({selectNodeContents: element => { selected = element; }, getBoundingClientRect: () => selected.text}),
  };
  return Array.from(runInNewContext(`(${clippedGraphiQLEditors.toString()})()`, {
    document, getComputedStyle: element => element.style ?? {overflowX: 'visible', overflowY: 'visible'},
  }));
}

test('GraphiQL capture checks pane visibility, rendered code width and full response height', () => {
  const query = makeEditor(box(95, 220, 185, 260), box(118, 230, 125, 20));
  const response = makeEditor(box(68, 550, 260, 430), box(90, 560, 235, 40));
  const check = checkGraphiQL;
  assert.deepEqual(check(query, response), []);
  assert.deepEqual(check(query, makeEditor(box(68, 550, 260, 430), box(90, 560, 235, 40), 431)),
    ['response text extends beyond the pane vertically (431px in 430px)']);
  assert.deepEqual(check(makeEditor(box(95, 220, 185, 260), box(118, 230, 180, 20)), response),
    ['query text extends beyond the pane horizontally']);
  assert.deepEqual(check(query, makeEditor(box(330, 550, 20, 430), box(333, 560, 15, 40))),
    ['response pane is clipped or too small (20×430px)']);
  assert.deepEqual(check(query, {...response, checkVisibility: () => false}), ['response pane is missing or hidden']);
  const parentElement = {style: {overflowX: 'hidden', overflowY: 'visible'}, clientLeft: 0, clientWidth: 300,
    getBoundingClientRect: () => box(0, 0, 300, 1000)};
  assert.deepEqual(check(query, {...response, parentElement}), ['response pane is clipped or too small (260×430px)']);
});

test('GraphiQL capture catches the response overlapping clipped Variables and Headers tabs at both widths', () => {
  for (const [width, queryTop, cutoff] of [[360, 237, 493], [720, 220, 476]]) {
    const regions = stackedRegions(width, queryTop);
    const query = makeEditor(box(84, queryTop + 16, 180, 192), box(100, queryTop + 24, 120, 20));
    const response = responseTop => makeEditor(box(68, responseTop, width - 92, 430), box(84, responseTop + 8, 200, 22));
    assert.deepEqual(checkGraphiQL(query, response(regions.responseRegion.getBoundingClientRect().top), width, regions), []);

    const editorHeight = cutoff - queryTop;
    regions.tabBar.parentElement = {
      style: {overflowX: 'visible', overflowY: 'hidden'},
      clientTop: 0, clientHeight: editorHeight,
      getBoundingClientRect: () => box(68, queryTop, width - 92, editorHeight),
    };
    const responseTop = cutoff + 8;
    regions.responseRegion = region(box(68, responseTop, width - 92, 430));
    assert.deepEqual(checkGraphiQL(query, response(responseTop), width, regions),
      ['tab bar overlaps response', 'Variables label is clipped', 'Headers label is clipped'], `${width}px`);
  }
});

test('GraphiQL capture checks the query editor against both other regions', () => {
  const regions = stackedRegions(360, 237);
  regions.queryRegion = region(box(68, 237, 268, 310));
  const query = makeEditor(box(84, 253, 180, 192), box(100, 261, 120, 20));
  const response = makeEditor(box(68, 525, 268, 430), box(84, 533, 200, 22));
  assert.deepEqual(checkGraphiQL(query, response, 360, regions), ['query editor overlaps tab bar', 'query editor overlaps response']);
});

test('an unavailable explicit screenshot browser fails plainly without falling back or installing', async () => {
  await assert.rejects(findBrowser({LDA_SCREENSHOT_BROWSER: join(import.meta.dirname, 'not-an-installed-browser')}), /No Chromium-family browser found/);
});

test('demo uses live public routes, every planned screen exists, and temporary data is removed on failure', async () => {
  let temporary;
  await assert.rejects(withDemoServer(async ({base, folder, pages}) => {
    temporary = folder;
    assert.ok((await readdir(demoDirectory)).includes('tenants.json'));
    const home = await (await fetch(base)).text();
    assert.ok(home.includes(`Tenant configuration: <code>${resolve(demoDirectory, 'tenants.json')}</code>`));
    assertPrivateTextAbsent(home, {...identity, suffix: basename(folder).slice('lda-graph-screenshots-'.length)});
    const csrf = /name="csrf" value="([^"]+)"/.exec(home)[1];
    for (const page of pages) {
      const response = await fetch(base + page.path, page.action ? {method: 'POST', body: new URLSearchParams({csrf, action: page.action})} : {});
      assert.equal(response.status, 200, page.name);
      assert.ok(response.headers.get('content-type').startsWith('text/html'), page.name);
      const html = await response.text();
      assert.match(html, /Coding Koala/, page.name);
      assertPrivateTextAbsent(html, {...identity, suffix: basename(folder).slice('lda-graph-screenshots-'.length)});
    }
    const docs = await (await fetch(base + '/tenants/demo/docs')).json();
    assert.ok(docs.some(doc => doc.displayName === 'Welcome to the demo garden'));
    throw new Error('simulated capture failure');
  }), /simulated capture failure/);
  await assert.rejects(readdir(temporary), {code: 'ENOENT'});
  await assert.rejects(readdir(demoDirectory), {code: 'ENOENT'});
});

test('successful demo work also closes its own server and removes its temporary directory', async () => {
  let temporary; let address;
  assert.equal(await withDemoServer(async ({base, folder}) => { address = base; temporary = folder; return 'done'; }), 'done');
  await assert.rejects(readdir(temporary), {code: 'ENOENT'});
  await assert.rejects(readdir(demoDirectory), {code: 'ENOENT'});
  await assert.rejects(fetch(address, {signal: AbortSignal.timeout(1000)}));
});

test('privacy gate catches username, home paths with either separator, and suffix without logging personal text', () => {
  for (const [text, cause] of [['Hello InventedUser', 'OS username'], ['C:\\Users\\InventedUser\\demo', 'home folder'], ['C:/Users/InventedUser/demo', 'home folder'], ['demo-aB9xYz', 'temporary suffix']]) {
    const settings = cause === 'home folder' ? {...identity, username: 'OtherUser'} : identity;
    assert.throws(() => assertPrivateTextAbsent(text, settings), error => error.message === 'Screenshot text contains ' + cause);
  }
  assert.doesNotThrow(() => assertPrivateTextAbsent('Tenant configuration: .test-runtime/screenshots-demo/tenants.json', identity));
});

test('common-word usernames only match identifying paths or exact case-sensitive whole words', () => {
  const settings = {...identity, username: 'Admin'};
  for (const text of ['Contact the administrator or admin.', 'Administrator', 'Administer', 'superAdmin', 'Admin2', '_Admin', 'éAdmin']) {
    assert.doesNotThrow(() => assertPrivateTextAbsent(text, settings));
  }
  for (const text of ['Hello Admin.', 'C:\\Users\\Admin\\demo', 'C:/Users/admin/demo', '/home/admin/demo', '/Users/Admin/demo']) {
    assert.throws(() => assertPrivateTextAbsent(text, settings), {message: 'Screenshot text contains OS username'});
  }
  assert.doesNotThrow(() => assertPrivateTextAbsent('/home/administrator/demo', settings));
  assert.doesNotThrow(() => assertPrivateTextAbsent('userXname', {...identity, username: 'user.name'}));
  assert.throws(() => assertPrivateTextAbsent('/home/user.name/demo', {...identity, username: 'user.name'}),
    {message: 'Screenshot text contains OS username'});
});

test('browser clock and locale setup precedes page scripts without freezing timers or performance', async () => {
  const calls = [];
  await configurePage(async (method, params) => { calls.push({method, params}); });
  assert.deepEqual(calls.slice(0, 2), [
    {method: 'Emulation.setTimezoneOverride', params: {timezoneId: 'UTC'}},
    {method: 'Emulation.setLocaleOverride', params: {locale: 'en-US'}},
  ]);
  assert.equal(calls[2].method, 'Page.addScriptToEvaluateOnNewDocument');
  const timers = () => {}; const performance = {now: () => 123};
  const context = {setTimeout: timers, performance, location: {pathname: '/'}};
  runInNewContext(calls[2].params.source, context);
  assert.equal(runInNewContext('Date.now()', context), demoTime);
  assert.equal(runInNewContext('new Date().toISOString()', context), '2026-01-15T12:00:00.000Z');
  assert.equal(runInNewContext('new Date(0).getTime()', context), 0);
  assert.equal(runInNewContext('Date.parse("2026-01-15T12:00:00Z")', context), demoTime);
  assert.equal(runInNewContext('typeof Date()', context), 'string');
  assert.equal(context.setTimeout, timers);
  assert.equal(context.performance, performance);
  const graphiqlContext = {location: {pathname: '/graphiql'}};
  runInNewContext(calls[2].params.source, graphiqlContext);
  assert.notEqual(runInNewContext('Date.now()', graphiqlContext), demoTime);
});

test('two independent live demos generate the same timestamps, IDs, keys and connection authority', async () => {
  async function sample() {
    return withDemoServer(async ({base, pages}) => {
      const stats = await (await fetch(base + '/tenants/demo/stats')).json();
      const entries = await (await fetch(base + '/tenants/demo/requests')).json();
      const request = entries.find(entry => entry.url === '/content/v2');
      const jobs = await (await fetch(base + '/tenants/demo/jobs')).json();
      const body = request.reqBody;
      assert.equal(request.resBody.extensions.correlationId, demoCorrelationId(body));
      assert.equal(request.ts, new Date(demoTime).toISOString());
      assert.equal(stats.typesUpdated, request.ts);
      assert.equal(jobs[0].ts, request.ts);
      assert.equal(jobs[0].journals[0].ts, request.ts);
      assert.ok(Number.isInteger(request.ms) && request.ms >= 0); // Still measured.
      assert.ok(Number.isInteger(jobs[0].journals[0].took));
      const tenant = await (await fetch(base + '/tenants/demo')).text();
      assert.ok(tenant.includes('http://127.0.0.1:18082'));
      assert.ok(tenant.includes('demo-public') && tenant.includes('made-up-demo-only'));
      // Durations and actual store byte counts are deliberately not normalised.
      return {base, pages, ts: request.ts, headers: request.headers, response: request.resBody, requestId: request.n,
        jobId: jobs[0].id, journalId: jobs[0].journals[0].id};
    });
  }
  assert.deepEqual(await sample(), await sample());
});

test('an existing demo configuration directory is preserved and fails closed', async () => {
  const directory = resolve(demoDirectory);
  assert.equal(dirname(directory), resolve('.test-runtime'));
  await mkdir(dirname(directory), {recursive: true});
  await mkdir(directory); // Exclusive: this test never removes a pre-existing path.
  try {
    await writeFile(join(directory, 'keep.txt'), 'existing data');
    await assert.rejects(withDemoServer(() => assert.fail('must not start')), {code: 'EEXIST'});
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'existing data');
  } finally {
    await rm(directory, {recursive: true});
  }
});
