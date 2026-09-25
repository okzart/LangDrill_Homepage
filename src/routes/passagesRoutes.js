// Presentation layer for /passages - generate an example passage that uses
// the user's expressions (typed in, or picked from a community vocab drill
// set - each with its example sentence and meaning, so the passage uses the
// intended sense), then listen to it with each word highlighted as it's
// spoken. Calls the API Gateway's /api/passages route (Content
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
const { fromVocabItem } = require('../services/vocabExpressions');

class PassagesRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/passages', requireLogin, AsyncHandler.wrap(this.showPage.bind(this)));
    this.router.get('/passages/sets/:id', AsyncHandler.wrap(this.setItems.bind(this)));
    this.router.post('/passages/generate', AsyncHandler.wrap(this.generate.bind(this)));
  }

  // The vocab set list only feeds the "pick from a drill set" picker, so
  // failing to load it just hides the picker (typing expressions still works).
  async showPage(req, res) {
    const [voiceOptions, vocabSets] = await Promise.all([
      loadVoiceOptions(this.gatewayClient),
      this.gatewayClient.get('/api/sets?type=vocab', req.auth.token).catch((err) => {
        if (err instanceof GatewayError && err.status === 401) throw err;
        return null;
      }),
    ]);
    res.render('passages', {
      voiceOptions,
      vocabSets: Array.isArray(vocabSets)
        ? vocabSets.map(({ id, name, author, count }) => ({ id, name, author, count }))
        : null,
    });
  }

  // A vocab set's items as passage expressions (see
  // services/vocabExpressions.js), for the page's picker. JSON, like
  // #generate. Items without a usable expression (no blanks) are skipped.
  async setItems(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    try {
      const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
      if (set.type !== 'vocab') {
        return res.status(400).json({ error: 'Only vocab drill sets can be used for passages' });
      }
      const items = (set.items || []).map(fromVocabItem).filter((item) => item.expression);
      res.json({ id: set.id, name: set.name, items });
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      if (err.status === 401) Session.clearToken(res);
      res.status(err.status).json({ error: err.message });
    }
  }

  // Called by the page's own fetch(), so failures are answered as JSON
  // `{ error }` (the page redirects to /login itself on 401) rather than
  // through errorHandler.js's redirect/error-page responses. `expressions`
  // are { expression, example?, meaning? } objects (or plain strings);
  // validation is left to Content Sharing, whose messages are shown as-is.
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
