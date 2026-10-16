import {createHmac, timingSafeEqual} from 'node:crypto';

/** Decode CMS preview JWTs; secret is Base64 only for HMAC, never for Basic. */
export function verifyPreviewToken(token, {secret = '', appKey = ''} = {}) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[a-zA-Z0-9_-]+$/.test(p))) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    if (claims.iss !== 'graph' || !(Array.isArray(claims.aud) ? claims.aud.includes('graph') : claims.aud === 'graph')) return null;
    if (appKey && claims.appKey !== appKey) return null;
    if (secret) {
      const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${encodedHeader}.${encodedPayload}`).digest();
      const signature = Buffer.from(encodedSignature, 'base64url');
      if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null;
    }
    const roles = claims.role == null ? [] : Array.isArray(claims.role) ? claims.role : [claims.role];
    if (roles.some(role => typeof role !== 'string') || (claims.sub != null && typeof claims.sub !== 'string')) return null;
    // Preview tokens are accepted after expiry (the CMS does not check token lifetime). Preserve that behaviour.
    return {kind: 'preview', username: claims.sub ?? '', roles, expired: typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()};
  } catch { return null; }
}
