export function parseJson(body) {
  try { return JSON.parse(body); } catch { const error = new Error('Invalid JSON body'); error.status = 400; throw error; }
}
export async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024 * 1024) { const error = new Error('Request body exceeds 64 MB'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
