// Presentation layer for /community - browse, publish, download, and
// unpublish shared drill sets. Calls the API Gateway's /api/sets (Content
// Sharing service), never that service directly (see docs/DESIGN.md §1).
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');

class CommunityRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/community', requireLogin, AsyncHandler.wrap(this.browse.bind(this)));
    this.router.post('/community/publish', requireLogin, AsyncHandler.wrap(this.publish.bind(this)));
    this.router.get('/community/:id', requireLogin, AsyncHandler.wrap(this.showOne.bind(this)));
    this.router.post('/community/:id/download', requireLogin, AsyncHandler.wrap(this.download.bind(this)));
    this.router.post('/community/:id/delete', requireLogin, AsyncHandler.wrap(this.remove.bind(this)));
  }

  async browse(req, res) {
    const type = req.query.type || '';
    const q = req.query.q || '';
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (q) qs.set('q', q);
    const path = `/api/sets${qs.toString() ? `?${qs}` : ''}`;
    const sets = await this.gatewayClient.get(path, req.auth.token);
    res.render('community', {
      sets,
      type,
      q,
      error: null,
      published: req.query.published === '1',
      deleted: req.query.deleted === '1',
    });
  }

  async publish(req, res, next) {
    const { type, name, desc, author, items } = req.body || {};
    let parsedItems;
    try {
      parsedItems = JSON.parse(items || '[]');
    } catch {
      return res.render('community', {
        sets: [],
        type: '',
        q: '',
        published: false,
        deleted: false,
        error: 'Items must be valid JSON (an array of objects).',
      });
    }

    try {
      const card = await this.gatewayClient.post(
        '/api/sets',
        { type, name, desc, author, items: parsedItems },
        req.auth.token
      );
      res.redirect(`/community/${card.id}?published=1`);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 400) {
        return res.render('community', { sets: [], type: '', q: '', published: false, deleted: false, error: err.message });
      }
      next(err);
    }
  }

  async showOne(req, res) {
    const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
    res.render('set-detail', {
      set,
      isOwner: null, // ownership is never exposed to clients - see ContentSharing's dto/setDto.js; Delete just attempts it and shows whatever the service decides (see #remove below).
      downloaded: req.query.downloaded === '1',
      published: req.query.published === '1',
      error: null,
    });
  }

  async download(req, res) {
    await this.gatewayClient.post(`/api/sets/${encodeURIComponent(req.params.id)}/download`, undefined, req.auth.token);
    res.redirect(`/community/${req.params.id}?downloaded=1`);
  }

  async remove(req, res, next) {
    try {
      await this.gatewayClient.delete(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
      res.redirect('/community?deleted=1');
    } catch (err) {
      // 403 here means "not your set" - a routine, expected outcome (not
      // every set's owner is a mystery to the person clicking Delete), so
      // it's shown inline rather than the generic error page.
      if (err instanceof GatewayError && err.status === 403) {
        const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
        return res.render('set-detail', { set, isOwner: false, downloaded: false, published: false, error: err.message });
      }
      next(err);
    }
  }
}

module.exports = CommunityRoutes;
