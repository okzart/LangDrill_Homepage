// Presentation layer for /progress - the caller's own progress record,
// shown as a read-only dashboard (views/mixins/progressCharts.pug). Calls
// the API Gateway's /api/progress/me (Progress Stats service), never that
// service directly (see docs/DESIGN.md §1).
//
// Editing is an admin tool: admins edit any record (their own included) on
// /admin/users/:id/progress (routes/adminRoutes.js), so there is no
// self-service form here any more.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');

class ProgressRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/progress', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
  }

  async show(req, res) {
    const progress = await this.gatewayClient.get('/api/progress/me', req.auth.token);
    res.render('progress', { progress, userId: req.auth.user.sub, isAdmin: req.auth.user.role === 'admin' });
  }
}

module.exports = ProgressRoutes;
