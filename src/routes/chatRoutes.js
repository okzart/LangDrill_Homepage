// Presentation layer for /chat - a chat page for the self-hosted LLM
// (llm-service). Calls the API Gateway's /api/llm route, never that service
// directly (see docs/DESIGN.md §1). Replies are streamed: the browser POSTs
// to /chat/completions here, this server forwards it with the caller's
// token and pipes the gateway's Server-Sent Events back unchanged, so the
// token never leaves the httpOnly session cookie.
const express = require('express');
const { Readable } = require('stream');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

class ChatRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/chat', requireLogin, AsyncHandler.wrap(this.showChat.bind(this)));
    this.router.post('/chat/completions', AsyncHandler.wrap(this.complete.bind(this)));
  }

  // The model name is only shown in the page header, so a failure here
  // (llm-service down, model still loading) just renders the page with a
  // warning instead of the error page - sending a message will report the
  // real error anyway.
  async showChat(req, res) {
    let model = null;
    let modelError = null;
    try {
      const result = await this.gatewayClient.get('/api/llm/models', req.auth.token);
      model = result?.data?.[0]?.id || null;
    } catch (err) {
      if (err instanceof GatewayError && err.status === 401) throw err;
      modelError = err instanceof GatewayError ? err.message : 'LLM service unreachable';
    }
    res.render('chat', { model, modelError });
  }

  // Called by the page's own fetch(), not by navigation, so failures are
  // answered as JSON `{ error }` (401 included - the page redirects to
  // /login itself) rather than going through errorHandler.js's
  // redirect/error-page responses.
  async complete(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    // Stop generating (and free the GPU slot) if the browser goes away
    // mid-reply, e.g. the Stop button, a closed tab, or a reload.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstream;
    try {
      upstream = await this.gatewayClient.stream(
        '/api/llm/chat/completions',
        { messages, stream: true },
        req.auth.token,
        abort.signal
      );
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof GatewayError) {
        if (err.status === 401) Session.clearToken(res);
        return res.status(err.status).json({ error: err.message });
      }
      console.error(err);
      return res.status(502).json({ error: 'LLM service unreachable' });
    }

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    const body = Readable.fromWeb(upstream.body);
    // An abort (above) or a dropped gateway connection errors the stream
    // mid-reply; the response has already started, so just end it.
    body.on('error', () => res.end());
    body.pipe(res);
  }
}

module.exports = ChatRoutes;
