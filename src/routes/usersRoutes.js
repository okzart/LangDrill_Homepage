// Presentation layer for /users/:id - another user's public profile, where
// clicking someone's profile image anywhere on the site leads: who they are
// (the name they go by and their image - never their email), the drill sets
// they have published, and how the viewer stands with them as a friend,
// with the matching action (add, accept, call).
//
//   GET  /users/:id          the page (your own id goes to /profile)
//   POST /users/:id/friend   ask them to be your friend
//
// From the gateway: GET /api/auth/users/:id, GET /api/friends/status/:id,
// GET /api/sets (filtered to theirs here), POST /api/friends/requests.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');
const Avatar = require('../services/avatar');

class UsersRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/users/:id', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/users/:id/friend', requireLogin, AsyncHandler.wrap(this.addFriend.bind(this)));
  }

  async show(req, res) {
    const { id } = req.params;
    if (id === req.auth.user.sub) return res.redirect('/profile');
    const token = req.auth.token;
    // A missing user is the error page's 404, like any other missing page.
    const person = await this.gatewayClient.get(`/api/auth/users/${encodeURIComponent(id)}`, token);
    // The rest only decorates the page: without it there is still a profile.
    const [friendship, allSets] = await Promise.all([
      this.gatewayClient.get(`/api/friends/status/${encodeURIComponent(id)}`, token).catch(() => ({ status: 'none' })),
      this.gatewayClient.get('/api/sets', token).catch(() => []),
    ]);
    res.render('user', {
      person: { ...person, avatar: Avatar.siteUrl(person.avatarUrl) },
      friendship,
      sets: (allSets || []).filter((set) => set.authorId === id),
      done: req.query.done === 'sent' || req.query.done === 'friends' ? req.query.done : null,
      error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    });
  }

  async addFriend(req, res) {
    const back = `/users/${encodeURIComponent(req.params.id)}`;
    try {
      const result = await this.gatewayClient.post('/api/friends/requests', { userId: req.params.id }, req.auth.token);
      res.redirect(`${back}?done=${result.status === 'accepted' ? 'friends' : 'sent'}`);
    } catch (err) {
      if (err instanceof GatewayError && [400, 404, 409].includes(err.status)) {
        return res.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }
}

module.exports = UsersRoutes;
