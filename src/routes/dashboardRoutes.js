// Presentation layer for /dashboard (the home feed), /feed and /profile.
//
// Home is laid out like a social network's: community drill sets are the
// feed's "posts" (newest first, with item previews), flanked by shortcuts and
// a "your progress / trending / top creators" rail. Everything comes from the
// gateway (see docs/DESIGN.md §1): GET /api/sets for the cards, GET
// /api/sets/:id for each post on screen (its items), GET /api/progress/me.
// /feed?type=&offset= returns the next posts as an HTML fragment for the
// page's "Load more".
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Avatar = require('../services/avatar');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

const PAGE_SIZE = 8;
const PREVIEW_ITEMS = 3;
const FEED_TYPES = ['vocab', 'listening', 'writing'];

class DashboardRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/', (req, res) => res.redirect(req.auth ? '/dashboard' : '/login'));
    this.router.get('/dashboard', requireLogin, AsyncHandler.wrap(this.showDashboard.bind(this)));
    this.router.get('/feed', requireLogin, AsyncHandler.wrap(this.feedPage.bind(this)));
    this.router.get('/profile', requireLogin, AsyncHandler.wrap(this.showProfile.bind(this)));
    this.router.post('/profile/nickname', requireLogin, AsyncHandler.wrap(this.setNickname.bind(this)));
  }

  async showDashboard(req, res) {
    const type = FEED_TYPES.includes(req.query.type) ? req.query.type : '';
    const [cardsResult, progressResult] = await Promise.allSettled([
      this.gatewayClient.get('/api/sets', req.auth.token),
      this.gatewayClient.get('/api/progress/me', req.auth.token),
    ]);
    for (const r of [cardsResult, progressResult]) {
      if (r.status === 'rejected' && r.reason instanceof GatewayError && r.reason.status === 401) throw r.reason;
    }
    // Every card with its author's profile image (services/avatar.js), for
    // the posts, the trending list and the top creators alike.
    const all = await Avatar.withAuthorAvatars(this.gatewayClient, req.auth.token, cardsResult.status === 'fulfilled' ? cardsResult.value || [] : []);
    const feed = type ? all.filter((c) => c.type === type) : all;
    const posts = await this.withItems(feed.slice(0, PAGE_SIZE), req.auth.token);
    res.render('dashboard', {
      type,
      posts,
      hasMore: feed.length > PAGE_SIZE,
      nextOffset: PAGE_SIZE,
      feedError: cardsResult.status === 'rejected' ? 'Content sharing is unavailable right now' : null,
      counts: { all: all.length, ...Object.fromEntries(FEED_TYPES.map((t) => [t, all.filter((c) => c.type === t).length])) },
      progress: progressResult.status === 'fulfilled' ? progressResult.value : null,
      trending: [...all].sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).filter((c) => c.downloads > 0).slice(0, 5),
      creators: DashboardRoutes.topCreators(all),
    });
  }

  // The next page of posts, rendered with the same mixin as the home page.
  async feedPage(req, res) {
    const type = FEED_TYPES.includes(req.query.type) ? req.query.type : '';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const all = (await this.gatewayClient.get('/api/sets', req.auth.token)) || [];
    const feed = type ? all.filter((c) => c.type === type) : all;
    const page = await Avatar.withAuthorAvatars(this.gatewayClient, req.auth.token, feed.slice(offset, offset + PAGE_SIZE));
    const posts = await this.withItems(page, req.auth.token);
    res.set('X-Has-More', feed.length > offset + PAGE_SIZE ? '1' : '0');
    res.set('X-Next-Offset', String(offset + PAGE_SIZE));
    res.render('feed-posts', { posts });
  }

  // Each card plus its first few items (and the total) for the preview. A set
  // that fails to load still shows, just without a preview.
  async withItems(cards, token) {
    return Promise.all(cards.map(async (card) => {
      try {
        const full = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(card.id)}`, token);
        return { ...card, preview: (full.items || []).slice(0, PREVIEW_ITEMS) };
      } catch (err) {
        if (err instanceof GatewayError && err.status === 401) throw err;
        return { ...card, preview: [] };
      }
    }));
  }

  static topCreators(cards) {
    const byAuthor = new Map();
    for (const c of cards) {
      const name = c.author || '';
      const entry = byAuthor.get(name) || { author: name, sets: 0, downloads: 0, avatar: null, authorId: null };
      entry.avatar = entry.avatar || c.authorAvatar || null; // creators are grouped by display name
      entry.authorId = entry.authorId || c.authorId || null; // whose profile the row opens
      entry.sets += 1;
      entry.downloads += c.downloads || 0;
      byAuthor.set(name, entry);
    }
    return [...byAuthor.values()].sort((a, b) => b.sets - a.sets || b.downloads - a.downloads).slice(0, 5);
  }

  async showProfile(req, res) {
    const profile = await this.gatewayClient.get('/api/auth/me', req.auth.token);
    // The image may have been changed elsewhere (the mobile app): this is
    // where the copy remembered for the top bar catches up.
    Avatar.remember(res, profile);
    const avatar = Avatar.siteUrl(profile.avatarUrl);
    res.render('profile', {
      profile,
      avatar,
      myAvatar: avatar,
      nicknameSaved: req.query.nickname === 'saved',
      nicknameError: typeof req.query.nicknameError === 'string' ? req.query.nicknameError.slice(0, 300) : null,
    });
  }

  // The profile page's nickname form. Authentication answers a new login
  // token carrying the new display name: it replaces the session's, and the
  // user's published sets are brought to the new name straight away.
  async setNickname(req, res) {
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname : '';
    try {
      const { token } = await this.gatewayClient.patch('/api/auth/me', { nickname }, req.auth.token);
      Session.setToken(res, token);
      await this.gatewayClient.post('/api/sets/author/refresh', undefined, token).catch(() => {});
      res.redirect('/profile?nickname=saved');
    } catch (err) {
      if (err instanceof GatewayError && [400, 409].includes(err.status)) {
        return res.redirect(`/profile?nicknameError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }
}

module.exports = DashboardRoutes;
