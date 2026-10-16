let pdfModule;
let mammothModule;
// Observable without loading either parser (including when server.js is imported).
export let pdfjsLoaded = false;
export let mammothLoaded = false;

function formatOf(bytes) {
  if (bytes.subarray(0, 1029).indexOf('%PDF-') !== -1) return 'pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'docx';
  return 'text';
}

function decodeText(bytes) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('Invalid text');
  return text;
}

/** Classify request-log bodies without importing a parser, even for ASCII PDFs. */
export function isTextInput(bytes) {
  try {
    if (formatOf(bytes) !== 'text') return false;
    decodeText(bytes); return true;
  }
  catch { return false; }
}

function normalize(text, maxChars) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

/** Extract media bytes; parser failures always produce an empty protocol result. */
export async function extractText(bytes, {timeoutMs = 20000, maxChars = 1_000_000} = {}) {
  let format = 'unknown'; let loadingTask; let timer; let cancelled = false; let destroyed = false;
  const destroy = () => {
    if (!loadingTask || destroyed) return;
    destroyed = true;
    try { Promise.resolve(loadingTask.destroy()).catch(() => {}); } catch { /* best-effort cleanup */ }
  };
  try {
    const buffer = Buffer.from(bytes);
    format = formatOf(buffer);
    const work = async () => {
      if (format === 'text') return decodeText(buffer);
      if (format === 'docx') {
        mammothModule ??= import('mammoth').then(module => { mammothLoaded = true; return module.default; });
        const mammoth = await mammothModule;
        if (cancelled) return '';
        return (await mammoth.extractRawText({buffer})).value;
      }
      pdfModule ??= import('pdfjs-dist/legacy/build/pdf.mjs').then(module => { pdfjsLoaded = true; return module; });
      const pdfjs = await pdfModule;
      if (cancelled) return '';
      // Node's legacy build uses its in-process fake worker; never render a page.
      loadingTask = pdfjs.getDocument({data: new Uint8Array(buffer), disableWorker: true,
        isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
        useWorkerFetch: false, stopAtErrors: true, verbosity: 0});
      const pdf = await loadingTask.promise;
      // Permission flags (no print/copy) do not block indexing; only a user password
      // (PasswordException from getDocument) means the text is unavailable.
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        try {
          const content = await page.getTextContent();
          pages.push(content.items.filter(item => typeof item.str === 'string')
            .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
        } finally { page.cleanup(); }
      }
      return pages.join('\n\n');
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true; destroy();
        const error = new Error('Extraction timed out'); error.name = 'ExtractionTimeout'; reject(error);
      }, timeoutMs);
    });
    const text = await Promise.race([work(), timeout]);
    return {type: 'text/plain', text: normalize(text, maxChars)};
  } catch (error) {
    // Parser messages can contain document fragments. Only log fixed diagnostics.
    const message = error?.name === 'ExtractionTimeout' ? `Timed out after ${timeoutMs} ms`
      : error?.name === 'PasswordException' ? 'Password-protected PDF'
      : error?.name === 'EncryptedPDF' ? 'Encrypted PDF'
      : format === 'text' ? 'Invalid UTF-8 text or control characters' : 'Unable to extract text';
    console.log(`extract: ${format} failed: ${message}`);
    return {type: 'text/plain', text: ''};
  } finally { clearTimeout(timer); destroy(); }
}
