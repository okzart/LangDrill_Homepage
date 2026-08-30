// Reads the payload out of a JWT WITHOUT verifying its signature. This
// service holds no JWT_SECRET and never makes an authorization decision
// itself - every request it forwards still carries the real token, and the
// gateway/services verify it for real. The one thing this file is for is
// cheap, read-only access to already-known-good claims (sub/email/role/exp)
// so pages can render a nav bar or gate an admin link without an extra
// round trip to GET /api/auth/me on every request.
//
// Never use the object this returns to authorize an action - only to
// decide what to show. A tampered cookie value is caught one of two ways:
// the outer cookie is itself signed (see middleware/session.js), and even
// if that weren't true, any actual state-changing request built from a
// forged payload would still be rejected downstream when the real
// signature check runs.
function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = token.split('.');
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// True once the token's `exp` claim (seconds since epoch) has passed.
// Payloads with no `exp` at all are treated as not expired - every token
// this app issues to itself always has one (see Authentication's
// authService.js), so a missing claim means decoding failed upstream, not
// that the token is somehow eternal.
function isExpired(payload) {
  return typeof payload?.exp === 'number' && payload.exp * 1000 <= Date.now();
}

module.exports = { decodeJwtPayload, isExpired };
