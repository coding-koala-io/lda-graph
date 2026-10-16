import {product} from './product.js';
import {escapeHtml as e} from './html.js';

export const chromeStyle = '.development-banner{font:14px/1.5 system-ui,sans-serif;background:#fff5dc;color:#493810;padding:8px 16px;border-bottom:1px solid #d7bd77}.development-banner small{display:block}.product-header{font:16px/1.5 system-ui,sans-serif;padding:12px 16px}.product-footer{font:13px/1.6 system-ui,sans-serif;color:#42535e;border-top:1px solid #bcc7cf;margin-top:32px;padding:12px 0;overflow-wrap:anywhere}.product-footer a,.product-header a{color:#07599e}';
export const banner = `<aside class="development-banner" aria-label="Development notice"><strong>Development use only — not for production.</strong><small>${e(product.suite)} · by Coding Koala</small></aside>`;
// Pages that the CMS may show inside a frame (GraphiQL) open product links in a new tab.
const newTab = ' target="_blank" rel="noopener"';
const headerFor = (attributes = '') => `<header class="product-header"><a href="/"${attributes}>${e(product.name)} · Tenants</a></header>`;
export const productHeader = headerFor();
export const framedProductHeader = headerFor(newTab);
const footerFor = (attributes = '') => `<footer class="product-footer">${e(product.name)} ${e(product.version)} · Development use only, not for production · Not affiliated with or endorsed by Optimizely · Optimizely® is a trademark of Optimizely North America Inc. · No warranty · <a href="/about"${attributes}>About</a> · <a href="/about/privacy"${attributes}>Privacy</a> · <a href="/about/licence"${attributes}>Licence</a> · <a href="/about/legal"${attributes}>Legal notice</a></footer>`;
export const footer = footerFor();
export const framedFooter = footerFor(newTab);
