// Presentation layer for /admin/listening - an admin test bench for
// tts-service-listening (Dia2): write a [S1]/[S2] dialogue script, pick
// reference voices, generate, listen with read-along, download the audio +
// timestamps JSON. Calls the API Gateway's /api/listening routes, never the
// service directly (see docs/DESIGN.md §1).
//
// Admin-only (requireLogin + requireAdmin, same as the other /admin pages):
// Dia2 is a heavy GPU job meant for producing listening material, not a
// learner feature. Nothing is stored here - the audio comes back inside the
// JSON response and the page offers it as a download.
const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

// Fields the page may send on to the service (anything else is dropped).
const FORWARDED = ['script', 'voices', 'format', 'seed', 'cfg_scale', 'temperature'];

class ListeningRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/admin/listening', requireLogin, requireAdmin, AsyncHandler.wrap(this.showPage.bind(this)));
    this.router.post('/admin/listening/generate', AsyncHandler.wrap(this.generate.bind(this)));
  }

  // The voice list doubles as a health check: if it can't be loaded the page
  // still renders, with the reason, and generation uses random voices.
  async showPage(req, res) {
    let voices = null;
    let serviceError = null;
    try {
      voices = (await this.gatewayClient.get('/api/listening/voices', req.auth.token)).voices || [];
    } catch (err) {
      if (err instanceof GatewayError && err.status === 401) throw err;
      serviceError = err instanceof GatewayError && err.status < 500
        ? err.message
        : 'tts-service-listening is not reachable through the gateway (is it running? scripts/gpu-services.sh status)';
    }
    res.render('admin/listening', { voices, serviceError });
  }

  // Called by the page's fetch(): JSON in, JSON out (errors as { error }).
  async generate(req, res) {
    if (!req.auth) return res.status(401).json({ error: 'Not logged in' });
    if (req.auth.user.role !== 'admin') return res.status(403).json({ error: 'Admin privileges required.' });
    const body = { response: 'json' };
    for (const key of FORWARDED) {
      if (req.body?.[key] !== undefined && req.body[key] !== null && req.body[key] !== '') body[key] = req.body[key];
    }
    try {
      const result = await this.gatewayClient.postLong('/api/listening/generate', body, req.auth.token);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      if (err instanceof GatewayError) {
        if (err.status === 401) Session.clearToken(res);
        const message = err.status === 502 || err.status === 504
          ? 'tts-service-listening is not reachable through the gateway (is it running?)'
          : err.message;
        return res.status(err.status).json({ error: message });
      }
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
        return res.status(504).json({ error: 'Generation took longer than 15 minutes' });
      }
      console.error(err);
      return res.status(502).json({ error: 'Could not reach the gateway' });
    }
  }
}

module.exports = ListeningRoutes;
