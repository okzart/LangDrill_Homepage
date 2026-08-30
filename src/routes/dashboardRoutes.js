const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');

class DashboardRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/', (req, res) => res.redirect(req.auth ? '/dashboard' : '/login'));
    this.router.get('/dashboard', requireLogin, this.showDashboard.bind(this));
    this.router.get('/profile', requireLogin, AsyncHandler.wrap(this.showProfile.bind(this)));
  }

  showDashboard(req, res) {
    res.render('dashboard');
  }

  async showProfile(req, res) {
    const profile = await this.gatewayClient.get('/api/auth/me', req.auth.token);
    res.render('profile', { profile });
  }
}

module.exports = DashboardRoutes;
