const { GatewayError } = require('../errors');

// The one place this app talks HTTP to the outside world. Every feature
// page (routes/) calls through here rather than fetching the API Gateway
// directly, so there's a single spot that attaches the caller's bearer
// token, parses the response, and turns a non-2xx status into a typed
// GatewayError (see errors.js) that middleware/errorHandler.js knows how
// to react to.
//
// This app is a CLIENT of the gateway, never of a backend service
// directly (see docs/DESIGN.md §1) - baseUrl is always the gateway's own
// address, injected by server.js rather than read from process.env here,
// same constructor-injection pattern the sibling services use for their
// DAOs.
class GatewayClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  // `token` is the caller's own JWT (from the session cookie - see
  // middleware/session.js), forwarded as-is. This app never signs or
  // verifies one itself.
  async request(method, path, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let parsed = null;
    if (res.status !== 204) {
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      throw new GatewayError(res.status, parsed?.error || res.statusText);
    }

    return parsed;
  }

  get(path, token) {
    return this.request('GET', path, { token });
  }

  post(path, body, token) {
    return this.request('POST', path, { token, body });
  }

  patch(path, body, token) {
    return this.request('PATCH', path, { token, body });
  }

  delete(path, token) {
    return this.request('DELETE', path, { token });
  }

  // Fetches a non-JSON response (e.g. a cached vocab-item mp3 from
  // /api/sets/audio/...) as a raw Buffer instead of parsing it - see
  // routes/communityRoutes.js#audio, the one caller. No token is attached:
  // that gateway route isn't auth-gated (filenames are content hashes of
  // already-public sentences, not secrets - see content-sharing's
  // src/server.js), and a plain <audio> tag couldn't send one anyway.
  async getBinary(path) {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new GatewayError(res.status, res.statusText);
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  // POSTs a JSON body and returns the raw fetch Response without reading
  // it, so the caller can pipe a streamed body (e.g. Server-Sent Events
  // from /api/llm/chat/completions) straight through to the browser - see
  // routes/chatRoutes.js, the one caller. `signal` lets the caller cancel
  // the upstream request when the browser disconnects. A non-2xx status
  // still throws GatewayError, like #request.
  async stream(path, body, token, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      // Fastify-based services (llm-service) put the human-readable reason
      // in `message` and only the status text in `error`.
      throw new GatewayError(res.status, parsed?.message || parsed?.error || res.statusText);
    }
    return res;
  }
}

module.exports = GatewayClient;
