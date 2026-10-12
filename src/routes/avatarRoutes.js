// Profile images: showing anyone's, and setting or removing your own (from
// the profile page). The images belong to the Authentication service
// (/api/auth/avatars/:id, /api/auth/me/avatar); this fronts them for the
// browser, which has no token to send - see services/avatar.js.
//
//   GET  /avatar/:userId          the image (any logged-in user)
//   POST /profile/avatar          set mine - body: the image itself, already
//                                 cropped and scaled by the page
//   POST /profile/avatar/remove   remove mine
const express = require('express');
const AsyncHandler = require('../middleware/asyncHandler');
const Avatar = require('../services/avatar');

// Authentication's own limit is 300 KB; this only refuses the absurd early.
const MAX_UPLOAD_BYTES = 512 * 1024;

class AvatarRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/avatar/:userId', AsyncHandler.wrap(this.show.bind(this)));
    this.router.post(
      '/profile/avatar',
      express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_UPLOAD_BYTES }),
      AsyncHandler.wrap(this.set.bind(this))
    );
    this.router.post('/profile/avatar/remove', AsyncHandler.wrap(this.remove.bind(this)));
  }

  call(method, path, req, body, contentType) {
    const headers = { Authorization: `Bearer ${req.auth.token}` };
    if (contentType) headers['Content-Type'] = contentType;
    return fetch(`${this.gatewayClient.baseUrl}${path}`, { method, headers, body });
  }

  // An <img> can't show an error page: failures are a bare status.
  async show(req, res) {
    if (!req.auth) return res.status(401).end();
    const version = typeof req.query.v === 'string' ? `?v=${encodeURIComponent(req.query.v)}` : '';
    let upstream;
    try {
      upstream = await this.call('GET', `/api/auth/avatars/${encodeURIComponent(req.params.userId)}${version}`, req);
    } catch {
      return res.status(502).end();
    }
    if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', upstream.headers.get('cache-control') || 'private, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }

  // Both are called by the profile page's fetch(), so every outcome is JSON:
  // { avatarUrl } (null after removing) or { error }.
  async set(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: req.t('Choose an image first.') });
    await this.forward(req, res, () => this.call('PUT', '/api/auth/me/avatar', req, req.body, 'application/octet-stream'));
  }

  async remove(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    await this.forward(req, res, () => this.call('DELETE', '/api/auth/me/avatar', req));
  }

  async forward(req, res, send) {
    let upstream;
    let body = null;
    try {
      upstream = await send();
      body = await upstream.json().catch(() => null);
    } catch {
      return res.status(502).json({ error: req.t('Profile images are unavailable right now.') });
    }
    if (!upstream.ok) {
      const down = upstream.status === 502 || upstream.status === 504;
      return res.status(upstream.status).json({ error: down ? req.t('Profile images are unavailable right now.') : req.t(body?.error || 'Something went wrong.') });
    }
    Avatar.remember(res, body);
    res.json({ avatarUrl: Avatar.siteUrl(body?.avatarUrl) });
  }
}

module.exports = AvatarRoutes;
