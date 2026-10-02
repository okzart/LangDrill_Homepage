// Presentation layer for /login, /register (+ its email-confirmation
// steps), /logout. These are the only
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
    // Email confirmation (Authentication's registrationService): the code
    // step right after registering, a resend, and the emailed link.
    this.router.post('/register/verify', AsyncHandler.wrap(this.verify.bind(this)));
    this.router.post('/register/resend', AsyncHandler.wrap(this.resend.bind(this)));
    this.router.get('/register/confirm', this.showConfirm.bind(this));
    this.router.post('/register/confirm', AsyncHandler.wrap(this.confirm.bind(this)));
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
      // Right password, but the registration's email isn't confirmed yet.
      if (err instanceof GatewayError && err.status === 403) {
        return AuthRoutes.renderVerify(res, { email, password, error: null, info: err.message });
      }
      next(err);
    }
  }

  showRegister(req, res) {
    res.render('register', { error: null, email: '' });
  }

  // Registering no longer creates the account: Authentication emails a code
  // and the account appears once it's confirmed (code here, or the link).
  async register(req, res, next) {
    const { email, password } = req.body || {};
    try {
      const started = await this.gatewayClient.post('/api/auth/register', { email, password });
      AuthRoutes.renderVerify(res, {
        email: started.email,
        password,
        error: null,
        info: req.t('We sent a 6-digit code to {email}. It expires in {minutes} minutes.', { email: started.email, minutes: started.expiresInMinutes }),
      });
    } catch (err) {
      if (err instanceof GatewayError && [400, 409, 429, 503].includes(err.status)) {
        return res.render('register', { error: err.message, email: email || '' });
      }
      next(err);
    }
  }

  // The confirmation needs the registration's password as well as the code
  // (see Authentication's registrationService.js), so the verify form
  // carries it in a hidden field - only on this POST response, which is
  // never cached - to spare the user typing it again.
  static renderVerify(res, { email, password, error, info }) {
    res.set('Cache-Control', 'no-store');
    res.render('register-verify', { email: email || '', password: password || '', error, info });
  }

  async verify(req, res, next) {
    const { email, code, password } = req.body || {};
    try {
      const { token } = await this.gatewayClient.post('/api/auth/register/verify', { email, code, password });
      Session.setToken(res, token);
      res.redirect('/dashboard');
    } catch (err) {
      if (err instanceof GatewayError && [400, 401, 404, 429].includes(err.status)) {
        return AuthRoutes.renderVerify(res, { email, password, error: err.message, info: null });
      }
      next(err);
    }
  }

  async resend(req, res, next) {
    const { email, password } = req.body || {};
    try {
      await this.gatewayClient.post('/api/auth/register/resend', { email });
      AuthRoutes.renderVerify(res, { email, password, error: null, info: req.t('We sent a new code to {email}. Earlier codes no longer work.', { email }) });
    } catch (err) {
      if (err instanceof GatewayError && [400, 404, 429, 503].includes(err.status)) {
        return AuthRoutes.renderVerify(res, { email, password, error: err.message, info: null });
      }
      next(err);
    }
  }

  // The emailed link lands here. It only shows a form: confirming on a plain
  // GET would let mail scanners that prefetch links use it up, and the
  // password is needed anyway.
  showConfirm(req, res) {
    res.render('register-confirm', { token: typeof req.query.token === 'string' ? req.query.token : '', error: null });
  }

  async confirm(req, res, next) {
    const { token, password } = req.body || {};
    try {
      const { token: jwt } = await this.gatewayClient.post('/api/auth/register/confirm', { token, password });
      Session.setToken(res, jwt);
      res.redirect('/dashboard');
    } catch (err) {
      if (err instanceof GatewayError && [400, 401, 429].includes(err.status)) {
        return res.render('register-confirm', { token: token || '', error: err.message });
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
