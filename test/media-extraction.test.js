import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
import {extractText} from '../src/extract.js';
import {gateway, success} from './helpers.js';
import {MODEL, index} from './fixtures.js';

// Every fixture is generated here; xref offsets refer to actual byte positions.
function pdfFixture(contents = ['BT /F1 12 Tf 72 720 Td (Hello PDFWORD42) Tj ET'], {encrypted = false} = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const content of contents) {
    const page = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const encryption = encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : '';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCXWORD42</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({type: 'nodebuffer'});
}

function captureFailures(t) {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  return lines;
}

test('importing server and extracting plain text loads neither PDF.js nor mammoth', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    await import('./src/server.js');
    const extraction = await import('./src/extract.js');
    assert.equal(extraction.pdfjsLoaded, false);
    assert.equal(extraction.mammothLoaded, false);
    assert.equal((await extraction.extractText(Buffer.from('plain'))).text, 'plain');
    assert.equal(extraction.pdfjsLoaded, false);
    assert.equal(extraction.mammothLoaded, false);
  `], {cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('POST extract detects an ASCII PDF by bytes and logs only its binary length', async t => {
  const {request, server} = await gateway(t); const bytes = pdfFixture();
  const result = await request('/extract?cache=1s', {method: 'POST', body: bytes, headers: {'Content-Type': 'text/plain'}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {type: 'text/plain', language: '', text: 'Hello PDFWORD42'});
  assert.equal(server.recentRequests.at(-1).reqBody, `<${bytes.length} bytes binary>`);
});

test('POST extract detects DOCX by ZIP contents and logs only its binary length', async t => {
  const {request, server} = await gateway(t); const bytes = await docxFixture();
  const result = await request('/extract', {method: 'POST', body: bytes, headers: {'Content-Type': 'application/octet-stream'}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {type: 'text/plain', language: '', text: 'DOCXWORD42'});
  assert.equal(server.recentRequests.at(-1).reqBody, `<${bytes.length} bytes binary>`);
});

test('UTF-8 text keeps its response shape and original request-log body', async t => {
  const {request, server} = await gateway(t);
  const body = '  Résumé\t\tHello  \r\n  world\n\n\n\n  café  ';
  const result = await request('/extract', {method: 'POST', body, headers: {'Content-Type': 'application/pdf'}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {type: 'text/plain', language: '', text: 'Résumé Hello\nworld\n\ncafé'});
  assert.equal(server.recentRequests.at(-1).reqBody, body);
  assert.deepEqual(await extractText(Buffer.from(body), {maxChars: 6}), {type: 'text/plain', text: 'Résumé'});
  assert.equal((await extractText(Buffer.from('a'.repeat(1_000_001)))).text.length, 1_000_000);
  assert.deepEqual(await extractText(Buffer.alloc(0)), {type: 'text/plain', text: ''});
});

test('binary garbage, invalid UTF-8 and forbidden controls return empty text with 200', async t => {
  const lines = captureFailures(t); const {request, server} = await gateway(t);
  for (const bytes of [Buffer.from([255, 0, 12]), Buffer.from([0xc3, 0x28]), Buffer.from('SECRET\x00'), Buffer.from('SECRET\x0c'), Buffer.from('SECRET\x7f')]) {
    const result = await request('/extract', {method: 'POST', body: bytes});
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, {type: 'text/plain', language: '', text: ''});
    assert.equal(server.recentRequests.at(-1).reqBody, `<${bytes.length} bytes binary>`);
  }
  assert.equal(lines.length, 5);
  assert.ok(lines.every(line => /^extract: text failed: [^\r\n]+$/.test(line) && !line.includes('SECRET')));
});

test('truncated and corrupt PDFs return 200, log one safe line and leave extraction usable', async t => {
  const lines = captureFailures(t); const {request} = await gateway(t);
  for (const bytes of [pdfFixture().subarray(0, 200), Buffer.from('%PDF-1.4\nSECRET invalid PDF')]) {
    const result = await request('/extract', {method: 'POST', body: bytes});
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, {type: 'text/plain', language: '', text: ''});
  }
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => /^extract: pdf failed: [^\r\n]+$/.test(line) && !line.includes('SECRET')));
  assert.equal((await request('/extract', {method: 'POST', body: pdfFixture()})).data.text, 'Hello PDFWORD42');
});

test('non-DOCX ZIP and corrupt DOCX return empty text instead of archive bytes', async t => {
  const lines = captureFailures(t); const {request} = await gateway(t);
  const zip = new JSZip(); zip.file('xl/workbook.xml', '<SECRET/>');
  const badDocx = new JSZip(); badDocx.file('word/document.xml', '<SECRET>');
  for (const bytes of [await zip.generateAsync({type: 'nodebuffer'}), await badDocx.generateAsync({type: 'nodebuffer'}), (await docxFixture()).subarray(0, 30)]) {
    const result = await request('/extract', {method: 'POST', body: bytes});
    assert.equal(result.status, 200); assert.equal(result.data.text, '');
  }
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => /^extract: docx failed: [^\r\n]+$/.test(line) && !line.includes('SECRET')));
});

test('PDFs allow 1024 leading bytes and preserve line and page separation', async () => {
  const bytes = pdfFixture(['BT /F1 12 Tf 72 720 Td ( First ) Tj ( second ) Tj 0 -20 Td ( third ) Tj ET', 'BT /F1 12 Tf 72 720 Td ( Last ) Tj ET']);
  const result = await extractText(Buffer.concat([Buffer.alloc(1024), bytes]));
  assert.deepEqual(result, {type: 'text/plain', text: 'First second\nthird\n\nLast'});
  assert.equal((await extractText(bytes, {maxChars: 5})).text, 'First');
});

test('password-protected and graphics-only PDFs return no text', async t => {
  const lines = captureFailures(t); const {request} = await gateway(t);
  const encrypted = await request('/extract', {method: 'POST', body: pdfFixture(undefined, {encrypted: true})});
  assert.equal(encrypted.status, 200); assert.equal(encrypted.data.text, '');
  assert.deepEqual(lines, ['extract: pdf failed: Password-protected PDF']);
  // Permission flags without a user password must not block extraction.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const probe = pdfjs.getDocument({data: new Uint8Array(pdfFixture()), verbosity: 0});
  const pdf = await probe.promise; await probe.destroy();
  const permissions = t.mock.method(Object.getPrototypeOf(pdf), 'getPermissions', async () => []);
  assert.match((await extractText(pdfFixture())).text, /Hello PDFWORD42/);
  permissions.mock.restore();
  assert.deepEqual(lines, ['extract: pdf failed: Password-protected PDF']);
  const blank = await request('/extract', {method: 'POST', body: pdfFixture(['q 0 0 100 100 re f Q'])});
  assert.equal(blank.status, 200); assert.equal(blank.data.text, '');
  assert.equal(lines.length, 1);
});

test('timeout destroys the PDF loading task and emits a single failure line', async t => {
  const lines = captureFailures(t);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const probe = pdfjs.getDocument({data: new Uint8Array(pdfFixture()), verbosity: 0});
  await probe.promise; await probe.destroy();
  const destroyTask = t.mock.method(Object.getPrototypeOf(probe), 'destroy');
  let destroyed = 0;
  let failSetup;
  t.mock.method(pdfjs.PDFWorker, 'create', () => ({promise: new Promise((_, reject) => { failSetup = reject; }), destroy() { destroyed++; }}));
  assert.deepEqual(await extractText(pdfFixture(), {timeoutMs: 10}), {type: 'text/plain', text: ''});
  assert.equal(destroyTask.mock.callCount(), 1);
  assert.equal(destroyTask.mock.calls[0].this.destroyed, true);
  assert.deepEqual(lines, ['extract: pdf failed: Timed out after 10 ms']);
  // PDF.js finishes worker cleanup after setup settles, rather than at destroy().
  failSetup(new Error('Cancelled test setup'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, 1);
});

test('extracted PDF text indexed through stream and doc matches GenericMedia fulltext', async t => {
  const {request, gql} = await gateway(t);
  const model = structuredClone(MODEL);
  model.contentTypes.GenericMedia = {contentType: ['_Media'], properties: {}};
  assert.equal((await request('/api/content/v3/types', {method: 'PUT', body: model})).status, 200);
  const extracted = await request('/extract', {method: 'POST', body: pdfFixture()});
  assert.equal(extracted.status, 200); assert.match(extracted.data.text, /PDFWORD42/);
  const media = key => ({__typename: 'GenericMedia', _rbac: ['r:Everyone:Read'],
    _metadata: {__typename: 'MediaMetadata', key, locale: 'en', version: '1', status: 'Published',
      types: ['GenericMedia', '_Media', '_Content', '_Item'], content___searchable: extracted.data.text}});
  const streamed = await request('/_stream', {method: 'POST', body: index('pdf-stream', media('stream')), headers: {'Content-Type': 'application/x-ndjson'}});
  assert.equal(streamed.status, 200);
  assert.equal((await request(`/journal/stream/${streamed.data.journalId}`)).data.errors, false);
  assert.equal((await request('/_doc/pdf-doc', {method: 'POST', body: media('doc')})).data.result, 'created');
  const result = success(await gql('{GenericMedia(where:{_fulltext:{match:"PDFWORD42"}},orderBy:{_id:ASC}){total items{_id}}}'), 'GenericMedia');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => item._id), ['pdf-doc', 'pdf-stream']);
});
