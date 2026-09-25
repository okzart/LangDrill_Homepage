// Presentation layer for /passages - generate an example passage that uses
// the user's expressions, then listen to it with each word highlighted as
// it's spoken. Calls the API Gateway's /api/passages route (Content
// Sharing, which in turn uses llm-service and tts-service), never those
// services directly (see docs/DESIGN.md §1).
//
// The generated MP3 arrives inside the JSON result and is only relayed to
// the browser - nothing is stored here, and the response is marked
// no-store so no cache keeps it either.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');
const { loadVoiceOptions } = require('../services/voiceOptions');

class PassagesRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/passages', requireLogin, AsyncHandler.wrap(this.showPage.bind(this)));
    this.router.post('/passages/generate', AsyncHandler.wrap(this.generate.bind(this)));
  }

  async showPage(req, res) {
    res.render('passages', { voiceOptions: await loadVoiceOptions(this.gatewayClient) });
  }

  // Called by the page's own fetch(), so failures are answered as JSON
  // `{ error }` (the page redirects to /login itself on 401) rather than
  // through errorHandler.js's redirect/error-page responses. Validation is
  // left to Content Sharing, whose messages are shown as-is.
  async generate(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const { expressions, level, voice } = req.body || {};
    try {
      const passage = await this.gatewayClient.post(
        '/api/passages',
        { expressions, level, voice: voice || undefined },
        req.auth.token
      );
      res.set('Cache-Control', 'no-store');
      res.json(passage);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      if (err.status === 401) Session.clearToken(res);
      res.status(err.status).json({ error: err.message });
    }
  }
}

module.exports = PassagesRoutes;
