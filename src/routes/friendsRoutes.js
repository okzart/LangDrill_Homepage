// Presentation layer for /friends - the logged-in user's friends and friend
// requests (Authentication's /friends API, through the gateway's
// /api/friends). A friendship takes two steps: one user asks by email, the
// other accepts. From the list a friend can be called (links to /call).
//
// Plain forms with a redirect back to the page, like routes/adminRoutes.js:
// the outcome travels in the query string (`?done=` a code, `?error=` the
// service's own message).
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');

// ?done= codes → the message views/friends.pug shows.
const DONE = ['sent', 'friends', 'declined', 'withdrawn', 'removed'];

class FriendsRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/friends', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/friends/request', requireLogin, AsyncHandler.wrap(this.request.bind(this)));
    this.router.post('/friends/requests/:id/accept', requireLogin, this.action((req) => this.gatewayClient.post(`/api/friends/requests/${encodeURIComponent(req.params.id)}/accept`, undefined, req.auth.token), 'friends'));
    this.router.post('/friends/requests/:id/decline', requireLogin, this.action((req) => this.gatewayClient.post(`/api/friends/requests/${encodeURIComponent(req.params.id)}/decline`, undefined, req.auth.token), 'declined'));
    this.router.post('/friends/requests/:id/withdraw', requireLogin, this.action((req) => this.gatewayClient.delete(`/api/friends/requests/${encodeURIComponent(req.params.id)}`, req.auth.token), 'withdrawn'));
    this.router.post('/friends/:userId/remove', requireLogin, this.action((req) => this.gatewayClient.delete(`/api/friends/${encodeURIComponent(req.params.userId)}`, req.auth.token), 'removed'));
  }

  async show(req, res) {
    const lists = await this.gatewayClient.get('/api/friends', req.auth.token);
    res.render('friends', {
      friends: lists.friends || [],
      incoming: lists.incoming || [],
      outgoing: lists.outgoing || [],
      done: DONE.includes(req.query.done) ? req.query.done : null,
      who: typeof req.query.who === 'string' ? req.query.who.slice(0, 320) : '',
      error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    });
  }

  // The service's own refusals (no such user, already friends, a request
  // that is gone...) are shown on the page; anything else is a real error.
  static back(res, err) {
    if (err instanceof GatewayError && [400, 404, 409].includes(err.status)) {
      return res.redirect(`/friends?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  async request(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    try {
      const result = await this.gatewayClient.post('/api/friends/requests', { email }, req.auth.token);
      // 'accepted': they had already asked - the two are friends at once.
      res.redirect(`/friends?done=${result.status === 'accepted' ? 'friends' : 'sent'}&who=${encodeURIComponent(result.email || email)}`);
    } catch (err) {
      FriendsRoutes.back(res, err);
    }
  }

  action(call, done) {
    return AsyncHandler.wrap(async (req, res) => {
      try {
        await call(req);
        res.redirect(`/friends?done=${done}`);
      } catch (err) {
        FriendsRoutes.back(res, err);
      }
    });
  }
}

module.exports = FriendsRoutes;
