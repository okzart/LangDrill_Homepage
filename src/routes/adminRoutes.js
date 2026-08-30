// Presentation layer for /admin/* - user management (Authentication's
// admin API) and, per user, their progress record (Progress Stats' admin
// API). Both through the API Gateway, never a backend service directly
// (see docs/DESIGN.md §1). requireLogin + requireAdmin are applied on
// every route individually here (same convention as Authentication's own
// adminRoutes.js), rather than relying on how server.js happens to mount
// this router - so this file stays correct on its own even if that
// mounting ever changes.
//
// Unlike routes/progressRoutes.js and routes/communityRoutes.js, admin
// actions here use a redirect-with-error-in-the-querystring pattern
// (see #withError) rather than re-rendering the submitted form values -
// simpler, and losing a half-typed admin form on a validation error (e.g.
// "cannot demote the last remaining admin") is an acceptable trade-off for
// an internal admin tool.
const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { parseProgressForm } = require('../services/progressForm');
const { GatewayError } = require('../errors');

function withError(res, redirectTo, err) {
  if (err instanceof GatewayError && [400, 403, 404, 409].includes(err.status)) {
    return res.redirect(`${redirectTo}?error=${encodeURIComponent(err.message)}`);
  }
  throw err;
}

class AdminRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();
    const guard = [requireLogin, requireAdmin];

    this.router.get('/admin', ...guard, (req, res) => res.redirect('/admin/users'));

    this.router.get('/admin/users', ...guard, AsyncHandler.wrap(this.listUsers.bind(this)));
    this.router.post('/admin/users', ...guard, AsyncHandler.wrap(this.createUser.bind(this)));
    this.router.post('/admin/users/:id/update', ...guard, AsyncHandler.wrap(this.updateUser.bind(this)));
    this.router.post('/admin/users/:id/delete', ...guard, AsyncHandler.wrap(this.deleteUser.bind(this)));

    this.router.get('/admin/users/:id/progress', ...guard, AsyncHandler.wrap(this.showUserProgress.bind(this)));
    this.router.post('/admin/users/:id/progress', ...guard, AsyncHandler.wrap(this.updateUserProgress.bind(this)));
    this.router.post('/admin/users/:id/progress/delete', ...guard, AsyncHandler.wrap(this.deleteUserProgress.bind(this)));
  }

  async listUsers(req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const result = await this.gatewayClient.get(
      `/api/admin/api/users?page=${page}&limit=${limit}`,
      req.auth.token
    );
    res.render('admin/users', { ...result, error: req.query.error || null });
  }

  async createUser(req, res) {
    const { email, password, role } = req.body || {};
    try {
      await this.gatewayClient.post('/api/admin/api/users', { email, password, role }, req.auth.token);
      res.redirect('/admin/users');
    } catch (err) {
      withError(res, '/admin/users', err);
    }
  }

  async updateUser(req, res) {
    const update = {};
    if (req.body?.role) update.role = req.body.role;
    if (req.body?.password) update.password = req.body.password;
    try {
      await this.gatewayClient.patch(`/api/admin/api/users/${req.params.id}`, update, req.auth.token);
      res.redirect('/admin/users');
    } catch (err) {
      withError(res, '/admin/users', err);
    }
  }

  async deleteUser(req, res) {
    try {
      await this.gatewayClient.delete(`/api/admin/api/users/${req.params.id}`, req.auth.token);
      res.redirect('/admin/users');
    } catch (err) {
      withError(res, '/admin/users', err);
    }
  }

  async showUserProgress(req, res) {
    const progress = await this.gatewayClient.get(
      `/api/progress/admin/users/${encodeURIComponent(req.params.id)}`,
      req.auth.token
    );
    res.render('admin/userProgress', { progress, userId: req.params.id, error: req.query.error || null, saved: req.query.saved === '1' });
  }

  async updateUserProgress(req, res) {
    const update = parseProgressForm(req.body || {});
    const redirectTo = `/admin/users/${req.params.id}/progress`;
    try {
      await this.gatewayClient.patch(`/api/progress/admin/users/${req.params.id}`, update, req.auth.token);
      res.redirect(`${redirectTo}?saved=1`);
    } catch (err) {
      withError(res, redirectTo, err);
    }
  }

  async deleteUserProgress(req, res) {
    try {
      await this.gatewayClient.delete(`/api/progress/admin/users/${req.params.id}`, req.auth.token);
      res.redirect(`/admin/users/${req.params.id}/progress`);
    } catch (err) {
      withError(res, `/admin/users/${req.params.id}/progress`, err);
    }
  }
}

module.exports = AdminRoutes;
