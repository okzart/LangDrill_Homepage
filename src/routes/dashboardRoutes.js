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
    const all = cardsResult.status === 'fulfilled' ? cardsResult.value || [] : [];
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
    const posts = await this.withItems(feed.slice(offset, offset + PAGE_SIZE), req.auth.token);
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
      const entry = byAuthor.get(name) || { author: name, sets: 0, downloads: 0 };
      entry.sets += 1;
      entry.downloads += c.downloads || 0;
      byAuthor.set(name, entry);
    }
    return [...byAuthor.values()].sort((a, b) => b.sets - a.sets || b.downloads - a.downloads).slice(0, 5);
  }

  async showProfile(req, res) {
    const profile = await this.gatewayClient.get('/api/auth/me', req.auth.token);
    res.render('profile', { profile });
  }
}

module.exports = DashboardRoutes;
