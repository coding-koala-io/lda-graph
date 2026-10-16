/** Admin HTML pages may be framed only by the same origin (clickjacking protection). */
export function mergeFrameAncestors(csp, value) {
  const policy = String(csp ?? '').trim().replace(/;\s*$/, '');
  if (/(^|;)\s*frame-ancestors\s/i.test(policy)) return policy; // keep an existing (equal or stricter) directive
  return policy ? `${policy}; frame-ancestors ${value}` : `frame-ancestors ${value}`;
}

/** Add X-Frame-Options SAMEORIGIN and CSP frame-ancestors 'self', merging into any CSP already set. */
export function protectAdminPage(response) {
  if (!response.hasHeader('X-Frame-Options')) response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Content-Security-Policy', mergeFrameAncestors(response.getHeader('Content-Security-Policy'), "'self'"));
}
