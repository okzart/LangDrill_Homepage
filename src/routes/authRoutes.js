// Presentation layer for /login, /register, /logout. These are the only
// pages reachable while logged out (besides the error page) - every other
// route in this app is behind requireLogin (see server.js).
const express = require('express');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

// Only ever redirect to a same-site relative path. `next` arrives as a
// query/body string a caller controls (it's how requireLogin remembers
// where to send someone back to after login) - without this check a
// crafted `?next=//evil.example` would send a freshly-logged-in user
// straight off-site (an open-redirect), since browsers treat a leading
// "//" as protocol-relative to a different host.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

class AuthRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/login', this.showLogin.bind(this));
    this.router.post('/login', AsyncHandler.wrap(this.login.bind(this)));
    this.router.get('/register', this.showRegister.bind(this));
    this.router.post('/register', AsyncHandler.wrap(this.register.bind(this)));
    this.router.post('/logout', this.logout.bind(this));
  }

  showLogin(req, res) {
    res.render('login', { error: null, email: '', next: req.query.next || '' });
  }

  async login(req, res, next) {
    const { email, password } = req.body || {};
    const nextPath = safeNext(req.body?.next);
    try {
      const { token } = await this.gatewayClient.post('/api/auth/login', { email, password });
      Session.setToken(res, token);
      res.redirect(nextPath);
    } catch (err) {
      // Wrong credentials (401) or a missing field (400) are expected,
      // routine failures here - show them inline on the form rather than
      // falling through to the generic error page every other GatewayError
      // in this app ends up on (see middleware/errorHandler.js).
      if (err instanceof GatewayError && (err.status === 401 || err.status === 400)) {
        return res.render('login', { error: err.message, email: email || '', next: nextPath });
      }
      next(err);
    }
  }

  showRegister(req, res) {
    res.render('register', { error: null, email: '' });
  }

  async register(req, res, next) {
    const { email, password } = req.body || {};
    try {
      await this.gatewayClient.post('/api/auth/register', { email, password });
      // Log the new account straight in rather than sending them back to a
      // separate login form to re-type what they just typed.
      const { token } = await this.gatewayClient.post('/api/auth/login', { email, password });
      Session.setToken(res, token);
      res.redirect('/dashboard');
    } catch (err) {
      if (err instanceof GatewayError && [400, 409].includes(err.status)) {
        return res.render('register', { error: err.message, email: email || '' });
      }
      next(err);
    }
  }

  logout(req, res) {
    Session.clearToken(res);
    res.redirect('/login');
  }
}

module.exports = AuthRoutes;
