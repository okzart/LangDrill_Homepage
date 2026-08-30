// Presentation layer for /progress - the caller's own progress record.
// Calls the API Gateway's /api/progress/me (Progress Stats service),
// never that service directly (see docs/DESIGN.md §1).
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { parseProgressForm } = require('../services/progressForm');
const { GatewayError } = require('../errors');

class ProgressRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/progress', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/progress', requireLogin, AsyncHandler.wrap(this.update.bind(this)));
  }

  async show(req, res) {
    const progress = await this.gatewayClient.get('/api/progress/me', req.auth.token);
    res.render('progress', { progress, error: null, saved: req.query.saved === '1' });
  }

  async update(req, res, next) {
    const update = parseProgressForm(req.body || {});
    try {
      await this.gatewayClient.patch('/api/progress/me', update, req.auth.token);
      res.redirect('/progress?saved=1');
    } catch (err) {
      if (err instanceof GatewayError && err.status === 400) {
        // Re-render with what the user just submitted (not a re-fetch of
        // the old server value) so a typo doesn't erase the rest of their edits.
        return res.render('progress', { progress: { userId: req.auth.user.sub, ...update }, error: err.message, saved: false });
      }
      next(err);
    }
  }
}

module.exports = ProgressRoutes;
