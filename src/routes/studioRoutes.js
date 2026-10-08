// Presentation layer for /studio - turn your own audio or video (or a voice
// recording made on the page) into listening drill items: upload → transcript
// with word timings → select a stretch of words → crop that audio → build a
// dictation/full/choice/order item around it → publish the items as a listening set.
//
// Calls the API Gateway only (see docs/DESIGN.md §1):
//   /api/split/transcribe  audio-split-service: extracts the audio track
//                          (video too), transcribes it via stt-service, and
//                          returns the compact mp3 + word timings.
//   /api/split/cut         audio-split-service: crops one clip.
//   /api/sets/clips        content-sharing: stores the clip, returns its
//                          audioUrl ("/audio/<sha256>.mp3").
//   /api/sets              content-sharing: publishes the set, or searches /
//                          loads / updates an existing listening set that the
//                          new items are added to (update is owner-only).
// Nothing is kept here: the page holds the extracted mp3 in memory and sends
// it back with each crop request, so this server stays stateless.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

// audio-split-service's own limits are 300 MB and 2 hours per upload; it
// transcribes at most 30 minutes per request, so a longer recording comes
// back one part at a time (the form's `part` field - the page sends the file
// again for each). This only rejects obviously oversized uploads early.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
// The page re-sends the extracted mp3 (mono 96 kbps ≈ 0.7 MB/min, so ≤ ~22 MB
// for a 30-minute part) with every crop request.
const MAX_CLIP_SOURCE_BYTES = 32 * 1024 * 1024;
// Matches audio-split-service's MAX_CLIP_SECONDS default.
const MAX_CLIP_SECONDS = 120;
// audio-split-service transcribes at most MAX_PART_SECONDS per request
// (its MAX_TRANSCRIBE_MINUTES default) and may move a part boundary by up to
// PART_SLACK_SECONDS (its PART_SLACK). The page uses them to work out how
// many parts a file will have before uploading it; the service's own answer
// (`part.count`) replaces that guess once a part has been transcribed.
const MAX_PART_SECONDS = 30 * 60;
const PART_SLACK_SECONDS = 10;
const LANGUAGES = ['en', 'ko', 'auto'];
const ITEM_TYPES = ['dictation', 'full', 'choice', 'order'];
const MAX_OPTIONS = 6;
const MAX_OPTION_LENGTH = 500;
const MAX_ITEMS = 200;
const MAX_SEARCH_RESULTS = 20;
// The apps count blank positions over these word tokens (see
// services/vocabExpressions.js and LangDrillApp's listening drill).
const WORD = /[A-Za-z']+/g;
const CLIP_URL = /^\/audio\/[a-f0-9]{64}\.mp3$/;

class StudioRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/studio', requireLogin, (req, res) => res.render('studio', { maxClipSeconds: MAX_CLIP_SECONDS, maxPartSeconds: MAX_PART_SECONDS, partSlackSeconds: PART_SLACK_SECONDS }));
    // Multipart body streamed straight through - never parsed or buffered here.
    this.router.post('/studio/transcribe', AsyncHandler.wrap(this.transcribe.bind(this)));
    this.router.post(
      '/studio/clip',
      express.raw({ type: ['audio/*', 'application/octet-stream'], limit: MAX_CLIP_SOURCE_BYTES }),
      AsyncHandler.wrap(this.clip.bind(this))
    );
    this.router.post('/studio/publish', AsyncHandler.wrap(this.publish.bind(this)));
    // Adding to an existing listening set instead of publishing a new one.
    this.router.get('/studio/sets', AsyncHandler.wrap(this.searchSets.bind(this)));
    this.router.get('/studio/sets/:id', AsyncHandler.wrap(this.loadSet.bind(this)));
    this.router.post('/studio/sets/:id/update', AsyncHandler.wrap(this.updateSet.bind(this)));
  }

  // All three POSTs are called by the page's fetch(), so every outcome is
  // JSON ({ error } on failure, 401 included - the page sends the user to
  // /login itself).
  async transcribe(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const contentType = req.get('content-type') || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return res.status(400).json({ error: req.t('Send the file as multipart/form-data') });
    }
    if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: req.t('Files up to {mb} MB', { mb: MAX_UPLOAD_BYTES / 1024 / 1024 }) });
    }
    try {
      const result = await this.gatewayClient.postStream('/api/split/transcribe', req, contentType, req.auth.token);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      this.fail(res, err, 'Transcription is unavailable right now (are audio-split-service and stt-service running? scripts/gpu-services.sh status)');
    }
  }

  // Body: the extracted mp3 (raw audio/mpeg); query: start, end (seconds).
  // Crops through audio-split-service, stores the clip in content-sharing,
  // and answers { audioUrl, duration }.
  async clip(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: req.t('Send the audio as the request body') });
    }
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return res.status(400).json({ error: req.t('start and end (seconds) are required, with start < end') });
    }
    if (end - start > MAX_CLIP_SECONDS) {
      return res.status(400).json({ error: req.t('A clip can be at most {max} s', { max: MAX_CLIP_SECONDS }) });
    }
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: 'audio/mpeg' }), 'source.mp3');
    form.append('start', String(start));
    form.append('end', String(end));
    form.append('format', 'mp3');
    form.append('fade_ms', '20');
    form.append('mono', 'true');
    try {
      const cut = await this.gatewayClient.postMultipartBinary('/api/split/cut', form, req.auth.token);
      const stored = await this.gatewayClient.postRaw('/api/sets/clips', cut.buffer, 'audio/mpeg', req.auth.token);
      res.json({ audioUrl: stored.audioUrl, duration: Number(cut.headers.get('x-clip-duration')) || end - start });
    } catch (err) {
      this.fail(res, err, 'Cropping is unavailable right now (is audio-split-service running?)');
    }
  }

  // Body (JSON): { name, desc, author, items }. Answers { id } of the new set.
  async publish(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { name, desc, author } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: req.t('Give the set a name') });
    let items;
    try {
      items = StudioRoutes.cleanItems(req.body?.items);
    } catch (err) {
      return res.status(400).json({ error: err.i18n ? req.t(...err.i18n) : req.t(err.message) });
    }
    try {
      const card = await this.gatewayClient.post(
        '/api/sets',
        {
          type: 'listening',
          name: name.trim(),
          desc: typeof desc === 'string' ? desc.trim() : '',
          author: typeof author === 'string' ? author.trim() : '',
          items,
        },
        req.auth.token
      );
      res.status(201).json({ id: card?.id });
    } catch (err) {
      this.fail(res, err, 'Publishing is unavailable right now');
    }
  }

  // ?q= → up to 20 listening set cards, newest first.
  async searchSets(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const qs = new URLSearchParams({ type: 'listening' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) qs.set('q', q);
    try {
      const cards = await this.gatewayClient.get(`/api/sets?${qs}`, req.auth.token);
      res.json({ sets: (cards || []).slice(0, MAX_SEARCH_RESULTS), total: (cards || []).length });
    } catch (err) {
      this.fail(res, err, 'Content sharing is unavailable right now');
    }
  }

  // One listening set with its items, for the page to show and extend.
  async loadSet(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    try {
      const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
      if (set?.type !== 'listening') return res.status(400).json({ error: req.t('That is not a listening set') });
      res.json({ id: set.id, name: set.name, desc: set.desc, author: set.author, items: set.items || [] });
    } catch (err) {
      this.fail(res, err, 'Content sharing is unavailable right now');
    }
  }

  // Body (JSON): { name, desc, author, keep, items }. `keep` lists the
  // indexes of the set's current items to keep (the page can remove some);
  // those are re-read from the service, not taken from the page, so items
  // Studio can't make pass through untouched. `items`
  // are the new Studio items, appended after them. Owner-only - the
  // service answers 403 for anyone else.
  async updateSet(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const id = req.params.id;
    const { name, desc, author } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: req.t('Give the set a name') });
    try {
      const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(id)}`, req.auth.token);
      if (set?.type !== 'listening') return res.status(400).json({ error: req.t('That is not a listening set') });
      const current = set.items || [];
      const keep = (Array.isArray(req.body?.keep) ? req.body.keep : [])
        .map(Number)
        .filter((i, k, all) => Number.isInteger(i) && i >= 0 && i < current.length && all.indexOf(i) === k)
        .sort((a, b) => a - b);
      let added = [];
      if (Array.isArray(req.body?.items) && req.body.items.length) {
        try {
          added = StudioRoutes.cleanItems(req.body.items);
        } catch (err) {
          return res.status(400).json({ error: err.i18n ? req.t(...err.i18n) : req.t(err.message) });
        }
      }
      const items = keep.map((i) => current[i]).concat(added);
      if (!items.length) return res.status(400).json({ error: req.t('A set needs at least one item') });
      if (items.length > MAX_ITEMS) return res.status(400).json({ error: req.t('At most {max} items per set', { max: MAX_ITEMS }) });
      await this.gatewayClient.patch(
        `/api/sets/${encodeURIComponent(id)}`,
        {
          name: name.trim(),
          desc: typeof desc === 'string' ? desc.trim() : '',
          author: typeof author === 'string' ? author.trim() : '',
          items,
        },
        req.auth.token
      );
      res.json({ id });
    } catch (err) {
      if (err instanceof GatewayError && err.status === 403) {
        return res.status(403).json({ error: req.t('Only the person who published this set can add to it - publish your items as a new set instead.') });
      }
      this.fail(res, err, 'Content sharing is unavailable right now');
    }
  }

  // Rebuilds each item from known fields only, so the page can't publish
  // anything but a well-formed listening item. Only dictation takes blanks,
  // only choice takes options (the answer first, then the wrong ones).
  // Errors carry `i18n: [english, vars]` so the caller can translate them.
  static itemError(text, vars) {
    const err = new Error(text.replace(/\{(\w+)\}/g, (m, k) => vars?.[k] ?? m));
    err.i18n = [text, vars];
    return err;
  }

  static cleanItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw StudioRoutes.itemError('Add at least one item');
    if (raw.length > MAX_ITEMS) throw StudioRoutes.itemError('At most {max} items per set', { max: MAX_ITEMS });
    return raw.map((it, i) => {
      const n = i + 1;
      if (!it || !ITEM_TYPES.includes(it.type)) throw StudioRoutes.itemError('Item {n}: unknown drill type', { n });
      const answer = typeof it.answer === 'string' ? it.answer.trim() : '';
      if (!answer) throw StudioRoutes.itemError('Item {n}: the answer text is empty', { n });
      if (typeof it.audioUrl !== 'string' || !CLIP_URL.test(it.audioUrl)) throw StudioRoutes.itemError('Item {n}: missing its audio clip', { n });
      const item = { type: it.type, answer, audioUrl: it.audioUrl };
      if (typeof it.ko === 'string' && it.ko.trim()) item.ko = it.ko.trim();
      if (it.type === 'dictation') {
        const words = answer.match(WORD) || [];
        const blanks = (Array.isArray(it.blanks) ? it.blanks : [])
          .map((b) => Number(b?.at))
          .filter((at, k, all) => Number.isInteger(at) && at >= 0 && at < words.length && all.indexOf(at) === k)
          .sort((a, b) => a - b)
          .map((at) => ({ at, word: words[at] }));
        if (blanks.length === 0) throw StudioRoutes.itemError('Item {n}: pick at least one word to blank out', { n });
        item.blanks = blanks;
      }
      if (it.type === 'choice') {
        const wrong = (Array.isArray(it.options) ? it.options : [])
          .map((o) => (typeof o === 'string' ? o.trim().slice(0, MAX_OPTION_LENGTH) : ''))
          .filter((o, k, all) => o && o !== answer && all.indexOf(o) === k)
          .slice(0, MAX_OPTIONS - 1);
        if (wrong.length === 0) throw StudioRoutes.itemError('Item {n}: add at least one wrong option', { n });
        item.options = [answer, ...wrong];
      }
      return item;
    });
  }

  fail(res, err, unavailableMessage) {
    const t = res.locals.t || ((s) => s);
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: t(unavailableMessage) });
    }
    if (err.status === 401) Session.clearToken(res);
    // 502/504 come from the gateway's proxy when the service isn't running;
    // a 404 means an audio-split-service build older than /v1/transcribe and /v1/cut.
    let message = err.status === 502 || err.status === 504 ? t(unavailableMessage) : t(err.message);
    if (err.status === 404 && /route .* not found|^not found$/i.test(err.message)) {
      message = t('audio-split-service is an older build without the Studio endpoints - rebuild it on the GPU host: cd services/audio-split-service && docker compose up -d --build');
    }
    res.status(err.status).json({ error: message });
  }
}

module.exports = StudioRoutes;
