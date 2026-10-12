// Presentation layer for /call - peer-to-peer video calls between two
// logged-in users (WebRTC). This server only helps the two browsers find
// each other: it serves the page, the ICE server list and the protocol
// definition, and carries the signaling WebSocket to the gateway
// (services/signalingProxy.js, attached in server.js). Camera and microphone
// data never pass through here or any other LanguageDrill server.
//
//   GET /call              the page (start a call, answer one, be in one)
//   GET /call/ice-config   → GET /api/signaling/ice-config (STUN, and TURN
//                            with short-lived credentials when configured)
//   GET /call/protocol.js  → GET /api/signaling/protocol.js - the message
//                            types and their validation, exactly as the
//                            signaling service defines them
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

// The protocol file only changes when the signaling service is redeployed.
const PROTOCOL_CACHE_MS = 5 * 60 * 1000;

class CallRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();
    this.protocol = null; // { text, at }

    this.router.get('/call', requireLogin, (req, res) => res.render('call'));
    this.router.get('/call/ice-config', AsyncHandler.wrap(this.iceConfig.bind(this)));
    this.router.get('/call/protocol.js', AsyncHandler.wrap(this.protocolScript.bind(this)));
  }

  // Called by the page's fetch(), so failures are JSON `{ error }` (401
  // included) rather than errorHandler.js's pages.
  async iceConfig(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    try {
      const config = await this.gatewayClient.get('/api/signaling/ice-config', req.auth.token);
      res.set('Cache-Control', 'no-store'); // TURN credentials are per user and expire
      res.json(config);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      if (err instanceof GatewayError && err.status === 401) Session.clearToken(res);
      const status = err instanceof GatewayError ? err.status : 502;
      res.status(status).json({ error: req.t('Video calls are unavailable right now (is signaling-service running?)') });
    }
  }

  // Loaded with a <script> tag on every page a logged-in user sees.
  async protocolScript(req, res) {
    if (!req.auth) return res.status(401).type('application/javascript').send('// not logged in');
    if (!this.protocol || Date.now() - this.protocol.at > PROTOCOL_CACHE_MS) {
      try {
        const response = await fetch(`${this.gatewayClient.baseUrl}/api/signaling/protocol.js`, { headers: { Authorization: `Bearer ${req.auth.token}` } });
        if (!response.ok) throw new Error(`gateway answered ${response.status}`);
        this.protocol = { text: await response.text(), at: Date.now() };
      } catch (err) {
        // An older copy is better than none; without any, the page says so.
        if (!this.protocol) return res.status(502).type('application/javascript').send('// signaling-service is unavailable');
      }
    }
    res.set('Cache-Control', 'private, max-age=300').type('application/javascript').send(this.protocol.text);
  }
}

module.exports = CallRoutes;
