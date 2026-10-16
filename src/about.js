import {readFile} from 'node:fs/promises';
import {product} from './product.js';
import {page, pre, link} from './dashboard.js';

const files = {'/about/privacy': 'PRIVACY.md', '/about/licence': 'LICENSE.md', '/about/legal': 'LEGAL-NOTICE.md'};
export async function aboutPage(path, root = new URL('../', import.meta.url)) {
  const links = `<p>${link('/about', 'About')} · ${link('/about/privacy', 'Privacy')} · ${link('/about/licence', 'Licence')} · ${link('/about/legal', 'Legal notice')}</p>`;
  if (path === '/about') return {status: 200, html: page('About', pre(`${product.name} ${product.version}\n${product.suite}\ndataVersion: ${product.dataVersion}\nPublisher: ${product.publisher} (ACN 668 775 433)\nCompatible with ${product.compatibleWith}\nBusiness Source License 1.1 — free for development and other non-production use`) + links)};
  const file = files[path];
  if (!file) return {status: 404, html: page('Not found', '<p>Not found</p>' + links)};
  try { return {status: 200, html: page(file, pre(await readFile(new URL(file, root), 'utf8')) + links)}; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {status: 404, html: page(file, pre(`${file} not found`) + links)};
  }
}
