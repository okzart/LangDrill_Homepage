// Presentation layer for /scan - "Scan & Study": take or upload a picture of
// English text (a textbook page, a worksheet, a sign), read the text out of
// it, then get every sentence in Korean plus the vocabulary and expressions
// worth learning - and save the ones you pick as a vocab drill set.
//
// Calls the API Gateway only (see docs/DESIGN.md §1):
//   /api/ocr/ocr         ocr-service (PaddleOCR): the picture → text + line boxes
//   /api/study/analyze   content-sharing: text → translation, vocab, expressions
//   /api/sets            content-sharing: publishes the picked items as a vocab set
// Two steps on purpose (rather than /api/study/image in one go): the user
// sees what the OCR read and can fix it before the LLM works on it.
// Nothing is kept here - the picture only passes through.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

// ocr-service's own upload limit; this only rejects oversized uploads early.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const MAX_TEXT_CHARS = 6000; // content-sharing's limit for /study/analyze
const MAX_ITEMS = 60;
// The apps count blank positions over these word tokens.
const WORD = /[A-Za-z']+/g;

class ScanRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/scan', requireLogin, (req, res) => res.render('scan', { levels: LEVELS, maxTextChars: MAX_TEXT_CHARS }));
    // Multipart body streamed straight through - never parsed or buffered here.
    this.router.post('/scan/ocr', AsyncHandler.wrap(this.ocr.bind(this)));
    this.router.post('/scan/analyze', AsyncHandler.wrap(this.analyze.bind(this)));
    this.router.post('/scan/publish', AsyncHandler.wrap(this.publish.bind(this)));
  }

  // All three POSTs are called by the page's fetch(), so every outcome is
  // JSON ({ error } on failure, 401 included - the page sends the user to
  // /login itself).
  async ocr(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const contentType = req.get('content-type') || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return res.status(400).json({ error: req.t('Send the file as multipart/form-data') });
    }
    if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: req.t('Files up to {mb} MB', { mb: MAX_UPLOAD_BYTES / 1024 / 1024 }) });
    }
    try {
      const result = await this.gatewayClient.postStream('/api/ocr/ocr', req, contentType, req.auth.token, 5 * 60 * 1000);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      this.fail(res, err, 'Reading pictures is unavailable right now (is ocr-service running? scripts/gpu-services.sh status)');
    }
  }

  // Body (JSON): { text, level }.
  async analyze(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { text, level } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: req.t('There is no text to study yet') });
    if (text.length > MAX_TEXT_CHARS) return res.status(400).json({ error: req.t('The text is too long (at most {max} characters)', { max: MAX_TEXT_CHARS }) });
    try {
      const result = await this.gatewayClient.postLong('/api/study/analyze', { text, level: LEVELS.includes(level) ? level : 'intermediate' }, req.auth.token, 5 * 60 * 1000);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      this.fail(res, err, 'Translation is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }

  // Body (JSON): { name, desc?, author?, items }. Answers { id } of the new vocab set.
  async publish(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { name, desc, author } = req.body || {};
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
        { type: 'vocab', name: name.trim(), desc: typeof desc === 'string' ? desc.trim() : '', author: typeof author === 'string' ? author.trim() : '', items },
        req.auth.token,
        5 * 60 * 1000 // content-sharing narrates every sentence (tts-service) before answering
      );
      res.status(201).json({ id: card?.id });
    } catch (err) {
      this.fail(res, err, 'Publishing is unavailable right now');
    }
  }

  static itemError(text, vars) {
    const err = new Error(text.replace(/\{(\w+)\}/g, (m, k) => vars?.[k] ?? m));
    err.i18n = [text, vars];
    return err;
  }

  // Rebuilds each vocab item from known fields only: { ko, answer, keyKo?,
  // blanks }. Blank words are re-read from the answer, so a client can't
  // publish a blank that doesn't match its sentence.
  static cleanItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw ScanRoutes.itemError('Pick at least one word or expression');
    if (raw.length > MAX_ITEMS) throw ScanRoutes.itemError('At most {max} items per set', { max: MAX_ITEMS });
    return raw.map((it, i) => {
      const n = i + 1;
      const answer = typeof it?.answer === 'string' ? it.answer.trim() : '';
      const ko = typeof it?.ko === 'string' ? it.ko.trim() : '';
      if (!answer || !ko) throw ScanRoutes.itemError('Item {n}: the sentence or its Korean is missing', { n });
      const words = answer.match(WORD) || [];
      const blanks = (Array.isArray(it.blanks) ? it.blanks : [])
        .map((b) => Number(b?.at))
        .filter((at, k, all) => Number.isInteger(at) && at >= 0 && at < words.length && all.indexOf(at) === k)
        .sort((a, b) => a - b)
        .map((at) => ({ at, word: words[at] }));
      if (blanks.length === 0) throw ScanRoutes.itemError('Item {n}: nothing to blank out', { n });
      const item = { ko, answer, blanks };
      if (typeof it.keyKo === 'string' && it.keyKo.trim()) item.keyKo = it.keyKo.trim();
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
    // 502/503/504: the service behind the gateway isn't running (or is still loading).
    const message = err.status >= 502 ? t(unavailableMessage) : t(err.message);
    res.status(err.status).json({ error: message });
  }
}

module.exports = ScanRoutes;
