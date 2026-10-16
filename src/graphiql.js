import {escapeHtml} from './html.js';
import {banner, framedFooter as footer, chromeStyle, framedProductHeader as productHeader} from './product-ui.js';
export {escapeHtml} from './html.js';

/** Pinned browser-only dependencies; the Node runtime needs only graphql. */
export function graphiqlHtml(singleKey = '', query, useNew = false) {
  const headers = JSON.stringify(singleKey ? {Authorization: `epi-single ${singleKey}`, ...(useNew ? {'cg-query-new': 'true'} : {})} : (useNew ? {'cg-query-new': 'true'} : {})).replaceAll('<', '\\u003c');
  // A query passed in the link must win over the query GraphiQL restores from browser storage.
  const defaultQuery = JSON.stringify(query ?? '{ _Content { items { _id _metadata { displayName key locale } } total } }').replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GraphiQL · LDA Local Graph</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphiql@3.7.1/graphiql.min.css">
<style>${chromeStyle}html,body{height:100%;margin:0}body{display:flex;flex-direction:column}.slot-toggle{font:16px/1.5 system-ui,sans-serif;padding:8px 16px;color:#18242c;background:#f1f5f7}.slot-toggle select{font:inherit;padding:4px 8px;color:inherit;background:#fff;border:1px solid #8495a1;border-radius:4px}.slot-toggle select:focus-visible{outline:3px solid #07599e;outline-offset:3px}#graphiql{flex:1;min-height:0}</style></head><body>${banner}${productHeader}<label class="slot-toggle" for="query-slot">Query: <select id="query-slot"><option value="live"${useNew ? '' : ' selected'}>live</option><option value="new"${useNew ? ' selected' : ''}>new slot</option></select></label><div id="graphiql"></div>
<script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/graphiql@3.7.1/graphiql.min.js"></script>
<script>const headers=${headers};
const root=ReactDOM.createRoot(document.getElementById('graphiql'));
const linkQuery=${query === undefined ? 'undefined' : defaultQuery};let first=linkQuery!==undefined;
function renderGraphiQL(){const fetcher=GraphiQL.createFetcher({url:'/content/v2',headers:{...headers}});
root.render(React.createElement(GraphiQL,{fetcher,defaultQuery:${defaultQuery},...(first?{query:linkQuery}:{})}));first=false;}
document.getElementById('query-slot').addEventListener('change',event=>{
  if(event.target.value==='new')headers['cg-query-new']='true';else delete headers['cg-query-new'];
  renderGraphiQL();
});renderGraphiQL();</script>${footer}</body></html>`;
}
