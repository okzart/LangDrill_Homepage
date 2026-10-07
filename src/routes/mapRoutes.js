// Presentation layer for /map - "expressions for where you are": a map
// (OpenStreetMap, Google or Kakao - the user picks) that finds out what kind
// of place the user is near or searched for, and shows the English worth
// knowing there (ordering and asking for the bill at a restaurant...).
//
// The map and the place lookups run entirely in the browser, straight
// against the chosen provider (src/public/map/map.js). Only the *kind* of
// place comes here - never the user's position.
//
// Calls the API Gateway only (see docs/DESIGN.md §1):
//   /api/places/categories    content-sharing: the place kinds and levels
//   /api/places/expressions   content-sharing: the pack for one kind (written
//                             by llm-service on first request, then stored)
//   /api/sets                 content-sharing: saves a pack as a vocab set
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const ScanRoutes = require('./scanRoutes');
const { GatewayError } = require('../errors');

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const PROVIDERS = ['osm', 'google', 'kakao'];

class MapRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/map', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.get('/map/expressions', AsyncHandler.wrap(this.expressions.bind(this)));
    this.router.post('/map/regenerate', AsyncHandler.wrap(this.regenerate.bind(this)));
    this.router.post('/map/publish', AsyncHandler.wrap(this.publish.bind(this)));
  }

  // Which map providers this deployment offers. OpenStreetMap needs no key;
  // Google and Kakao appear once their browser key is set in .env. These
  // keys are public by design (they are sent to every browser) - restrict
  // them to this site's address in the provider's console.
  static providers() {
    const keys = { osm: '', google: process.env.GOOGLE_MAPS_API_KEY || '', kakao: process.env.KAKAO_MAP_JS_KEY || '' };
    const available = PROVIDERS.filter((id) => id === 'osm' || keys[id]);
    const wanted = process.env.MAP_DEFAULT_PROVIDER;
    return { available, keys, fallback: available.includes(wanted) ? wanted : 'osm' };
  }

  // The category list only decorates the page; without it (content-sharing
  // down) the page still renders, with a warning instead of the lists.
  async show(req, res) {
    let categories = [];
    let levels = LEVELS;
    let unavailable = false;
    try {
      const data = await this.gatewayClient.get('/api/places/categories', req.auth.token);
      categories = Array.isArray(data?.categories) ? data.categories : [];
      if (Array.isArray(data?.levels) && data.levels.length) levels = data.levels;
    } catch (err) {
      if (err instanceof GatewayError && err.status === 401) throw err;
      unavailable = true;
    }
    res.render('map', { mapConfig: { providers: MapRoutes.providers(), categories, levels, isAdmin: req.auth.user.role === 'admin' }, levels, unavailable });
  }

  // The three below are called by the page's fetch(), so every outcome is
  // JSON ({ error } on failure, 401 included).
  async expressions(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const query = new URLSearchParams({ category: String(req.query.category || ''), level: LEVELS.includes(req.query.level) ? req.query.level : 'intermediate' });
    try {
      // The first request for a pack waits for the LLM (well under a minute).
      res.json(await this.gatewayClient.get(`/api/places/expressions?${query}`, req.auth.token));
    } catch (err) {
      this.fail(res, err);
    }
  }

  async regenerate(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { category, level } = req.body || {};
    try {
      res.json(await this.gatewayClient.postLong('/api/places/expressions/regenerate', { category: String(category || ''), level: LEVELS.includes(level) ? level : 'intermediate' }, req.auth.token, 5 * 60 * 1000));
    } catch (err) {
      this.fail(res, err);
    }
  }

  // Body (JSON): { name, desc?, items: [{ ko, answer, blanks }] } → { id } of
  // the new vocab set. Items are rebuilt exactly as Scan & Study's are.
  async publish(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { name, desc } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: req.t('Give the set a name') });
    let items;
    try {
      items = ScanRoutes.cleanItems(req.body?.items);
    } catch (err) {
      return res.status(400).json({ error: err.i18n ? req.t(...err.i18n) : err.message });
    }
    try {
      const card = await this.gatewayClient.postLong(
        '/api/sets',
        { type: 'vocab', name: name.trim().slice(0, 120), desc: typeof desc === 'string' ? desc.trim().slice(0, 300) : '', author: '', items },
        req.auth.token,
        5 * 60 * 1000 // content-sharing narrates every sentence (tts-service) before answering
      );
      res.status(201).json({ id: card?.id });
    } catch (err) {
      this.fail(res, err);
    }
  }

  fail(res, err) {
    const t = res.locals.t || ((s) => s);
    const unavailable = t('Expressions are unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: unavailable });
    }
    if (err.status === 401) Session.clearToken(res);
    res.status(err.status).json({ error: err.status >= 502 ? unavailable : t(err.message) });
  }
}

module.exports = MapRoutes;
