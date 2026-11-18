import {readFile} from 'node:fs/promises';
import {product} from './product.js';
import {page, pre, link} from './dashboard.js';
import {escapeHtml as e} from './html.js';

const files = {'/about/privacy': 'PRIVACY.md', '/about/licence': 'LICENSE.md', '/about/legal': 'LEGAL-NOTICE.md'};
export async function aboutPage(path, root = new URL('../', import.meta.url)) {
  const links = `<p>${link('/about', 'About')} · ${link('/about/privacy', 'Privacy')} · ${link('/about/licence', 'Licence')} · ${link('/about/legal', 'Legal notice')}</p>`;
  if (path === '/about') {
    const rows = [
      ['Product', e(product.name)], ['Version', e(product.version)], ['Suite', e(product.suite)],
      ['dataVersion', e(product.dataVersion)], ['Compatible with', e(product.compatibleWith)],
      ['Built by', '<a href="https://codingkoala.io" target="_blank" rel="noopener noreferrer">Coding Koala</a>'],
      ['Source', '<a href="https://github.com/coding-koala-io/lda-graph" target="_blank" rel="noopener noreferrer">GitHub</a>'],
      ['Licence', 'Apache License 2.0, development tool, not for production use'],
      ['Copyright', `2026 ${e(product.publisher)} (ACN 668 775 433).`],
    ];
    const body = `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>`;
    return {status: 200, html: page('About', body + '<p>Not affiliated with or endorsed by Optimizely. Optimizely® is a trademark of Optimizely North America Inc. Provided as is, without warranty.</p>' + links, '', {brandInBody: true, disclaimerInBody: true})};
  }
  const file = files[path];
  if (!file) return {status: 404, html: page('Not found', '<p>Not found</p>' + links)};
  try {
    const content = await readFile(new URL(file, root), 'utf8');
    return {status: 200, html: page(file, pre(content) + links, '', {brandInBody: content.includes('Built by Coding Koala'), disclaimerInBody: content.includes('Not affiliated with or endorsed by Optimizely.')})};
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {status: 404, html: page(file, pre(`${file} not found`) + links)};
  }
}
