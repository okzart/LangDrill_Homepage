// Presentation layer for /community/:id/extract - "make a vocab set from this
// listening set": the AI picks the words and expressions worth learning out
// of the set's sentences, the user reviews them (keeping, dropping and
// correcting each), and only then are they saved - as a new vocab drill set,
// or added to one of the user's own.
//
// The picking is Content Sharing's /study/analyze, the same the Scan page
// uses (llm-service): text in, vocabulary and expressions out, each with its
// Korean meaning, the sentence it came from, and that sentence's blanks -
// exactly what a vocab drill item needs. Nothing is saved before the user
// confirms on the page.
//
//   GET  /community/:id/extract        the page
//   POST /community/:id/extract        { part, level } → the picks (JSON)
//   POST /community/:id/extract/sentences
//                                      { level, items: [{ term, meaning, avoid? }] }
//                                      → a new example sentence for each (JSON)
//   POST /community/sentences          the same, for the set editor's "New sentence"
//   POST /community/:id/extract/save   { mode: "new" | "existing", name?,
//                                        desc?, targetId?, items } → { id }
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');
const ScanRoutes = require('./scanRoutes');

const LEVELS = ['beginner', 'intermediate', 'advanced'];
// /study/analyze takes at most 6000 characters and 80 sentences; a long
// listening set is studied a part at a time.
const PART_CHARS = 5800;
const PART_ITEMS = 60;
const MAX_SET_ITEMS = 300; // a vocab set this page will grow to, at most
// New example sentences per request: llm-service caps a reply at 1024
// tokens, which fits about this many sentences with their Korean.
const MAX_NEW_SENTENCES = 8;
const WORD = /[A-Za-z']+/g;
const HANGUL = /[가-힣]/;
const LEVEL_WORDING = {
  beginner: 'a beginner (CEFR A1-A2): short sentences, everyday words',
  intermediate: 'an intermediate learner (CEFR B1-B2)',
  advanced: 'an advanced learner (CEFR C1)',
};
const SENTENCE_PROMPT = `You write example sentences for Korean learners of English.
For each numbered word or expression, write ONE new, natural English sentence that uses it in the given meaning - a different situation from the "not this" sentence when one is given. Everyday contexts, 6-16 words, no names of real people, nothing unpleasant.
Answer with exactly one line per number, in this form:
<n>. <English sentence> ||| <the word or expression exactly as it appears in your sentence> ||| <natural Korean translation of the whole sentence>
The middle part must be copied word for word from your sentence (e.g. "ran out of" if the sentence says "ran out of"). Output nothing else.`;

class ExtractRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/community/:id/extract', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/community/:id/extract', AsyncHandler.wrap(this.extract.bind(this)));
    this.router.post('/community/:id/extract/sentences', AsyncHandler.wrap(this.sentences.bind(this)));
    // The same for the set editor (views/community.pug), which has no set yet when creating one.
    this.router.post('/community/sentences', AsyncHandler.wrap(this.sentences.bind(this)));
    this.router.post('/community/:id/extract/save', AsyncHandler.wrap(this.save.bind(this)));
  }

  // The set's sentences, each ending like a sentence so that they aren't
  // run together, in parts small enough for one analysis:
  // [{ from, to, text }] (`from`/`to`: item numbers, 1-based).
  static parts(set) {
    const lines = (set.items || [])
      .map((item) => (typeof item?.answer === 'string' ? item.answer.trim() : ''))
      .map((answer) => (answer && !/[.?!…]["'”’)\]]*$/.test(answer) ? `${answer}.` : answer));
    const parts = [];
    let current = null;
    lines.forEach((line, i) => {
      if (!line) return;
      if (!current || current.count >= PART_ITEMS || current.text.length + line.length + 1 > PART_CHARS) {
        current = { from: i + 1, to: i + 1, count: 0, text: '' };
        parts.push(current);
      }
      current.text += (current.text ? '\n' : '') + line;
      current.to = i + 1;
      current.count += 1;
    });
    return parts.map(({ from, to, text }) => ({ from, to, text }));
  }

  // The vocab sets the user published - the ones they may add to.
  async mySets(req) {
    const all = await this.gatewayClient.get('/api/sets?type=vocab', req.auth.token).catch(() => []);
    return (all || []).filter((set) => set.authorId === req.auth.user.sub).map((set) => ({ id: set.id, name: set.name, count: set.count }));
  }

  async show(req, res) {
    const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
    if (set.type !== 'listening') return res.redirect(`/community/${encodeURIComponent(set.id)}`);
    res.render('extract', {
      set: { id: set.id, name: set.name, count: (set.items || []).length },
      parts: ExtractRoutes.parts(set).map(({ from, to }) => ({ from, to })),
      mySets: await this.mySets(req),
      levels: LEVELS,
    });
  }

  fail(req, res, err, unavailable) {
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: req.t(unavailable) });
    }
    if (err.status === 401) Session.clearToken(res);
    res.status(err.status).json({ error: err.status >= 502 ? req.t(unavailable) : req.t(err.message) });
  }

  // Runs the analysis on one part of the set. Where a picked sentence is one
  // of the set's own, its Korean is the set's (already checked by whoever
  // made the set) rather than a fresh machine translation.
  async extract(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const level = LEVELS.includes(req.body?.level) ? req.body.level : 'intermediate';
    try {
      const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token);
      if (set.type !== 'listening') return res.status(400).json({ error: req.t('Only a listening set can be turned into a vocab set here') });
      const parts = ExtractRoutes.parts(set);
      const part = parts[Math.max(0, Math.min(parts.length - 1, Number(req.body?.part) || 0))];
      if (!part) return res.status(400).json({ error: req.t('This set has no sentences to study') });
      const result = await this.gatewayClient.postLong('/api/study/analyze', { text: part.text, level }, req.auth.token, 5 * 60 * 1000);
      const ownKorean = new Map((set.items || []).filter((it) => it.answer && it.ko).map((it) => [it.answer.trim().replace(/[.?!…]+$/, ''), it.ko]));
      const withKorean = (item) => ({ ...item, exampleKo: ownKorean.get(String(item.example || '').trim().replace(/[.?!…]+$/, '')) || item.exampleKo || null });
      res.set('Cache-Control', 'no-store');
      res.json({ vocab: (result.vocab || []).map(withKorean), expressions: (result.expressions || []).map(withKorean), part: { from: part.from, to: part.to } });
    } catch (err) {
      this.fail(req, res, err, 'The AI is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }

  // The positions (`at`, counting [A-Za-z']+ words, as the apps do) of
  // `phrase` inside `sentence`, as drill blanks; empty when it isn't there
  // word for word.
  static blanksFor(sentence, phrase) {
    const words = String(sentence).match(WORD) || [];
    const want = (String(phrase).match(WORD) || []).map((w) => w.toLowerCase());
    if (!want.length) return [];
    for (let i = 0; i + want.length <= words.length; i++) {
      if (want.every((w, k) => words[i + k].toLowerCase() === w)) {
        return want.map((_, k) => ({ at: i + k, word: words[i + k] }));
      }
    }
    return [];
  }

  // "<n>. English ||| words ||| Korean" lines → for each of `count`
  // numbers { answer, ko, blanks }, or null where the line is missing,
  // malformed, has no Korean, or doesn't contain the words it names.
  static parseSentences(text, count) {
    const out = new Array(count).fill(null);
    const body = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\d+)[.)]\s*(.+?)\s*\|\|\|\s*(.+?)\s*\|\|\|\s*(.+?)\s*$/);
      if (!m) continue;
      const i = Number(m[1]) - 1;
      const answer = m[2].replace(/^["“]|["”]$/g, '').trim();
      const ko = m[4].trim();
      if (i < 0 || i >= count || out[i] || answer.length > 200 || !HANGUL.test(ko) || HANGUL.test(answer)) continue;
      const blanks = ExtractRoutes.blanksFor(answer, m[3]);
      if (blanks.length) out[i] = { answer, ko, blanks };
    }
    return out;
  }

  // A new example sentence for each word or expression - for a pick whose
  // own sentence is a poor drill (too long, too odd, or one the learner
  // already knows by heart from the listening set). → { sentences: [{
  // answer, ko, blanks } | null] }, in order; null where the AI gave
  // nothing usable (the page says so and keeps the old sentence).
  async sentences(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = raw.map((it) => ({
      term: typeof it?.term === 'string' ? it.term.trim().slice(0, 60) : '',
      meaning: typeof it?.meaning === 'string' ? it.meaning.trim().slice(0, 80) : '',
      avoid: typeof it?.avoid === 'string' ? it.avoid.trim().slice(0, 200) : '',
    }));
    if (!items.length || items.length > MAX_NEW_SENTENCES || items.some((it) => !/^[A-Za-z][A-Za-z' .-]*$/.test(it.term))) {
      return res.status(400).json({ error: req.t('Ask for 1-{max} sentences at a time', { max: MAX_NEW_SENTENCES }) });
    }
    const level = LEVEL_WORDING[req.body?.level] || LEVEL_WORDING.intermediate;
    const list = items.map((it, i) => `${i + 1}. ${it.term}${it.meaning ? ` (meaning: ${it.meaning})` : ''}${it.avoid ? ` - not this: "${it.avoid}"` : ''}`).join('\n');
    try {
      const reply = await this.gatewayClient.postLong(
        '/api/llm/chat/completions',
        { messages: [{ role: 'system', content: SENTENCE_PROMPT }, { role: 'user', content: `The learner is ${level}.\n\n${list}` }], max_tokens: 1024, temperature: 0.7 },
        req.auth.token,
        3 * 60 * 1000
      );
      res.set('Cache-Control', 'no-store');
      res.json({ sentences: ExtractRoutes.parseSentences(reply?.choices?.[0]?.message?.content, items.length) });
    } catch (err) {
      this.fail(req, res, err, 'The AI is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }

  // Saves what the user confirmed. Items are rebuilt from known fields with
  // their blanks re-read from the sentence (ScanRoutes.cleanItems).
  async save(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    let items;
    try {
      items = ScanRoutes.cleanItems(req.body?.items);
    } catch (err) {
      return res.status(400).json({ error: err.i18n ? req.t(...err.i18n) : err.message });
    }
    const token = req.auth.token;
    try {
      if (req.body?.mode === 'existing') {
        const target = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(String(req.body.targetId || ''))}`, token);
        if (target.type !== 'vocab') return res.status(400).json({ error: req.t('Choose one of your vocab sets') });
        if (target.authorId !== req.auth.user.sub) return res.status(403).json({ error: req.t('You can only add to a set you published') });
        // The same sentence with the same word blanked is the same drill: not added twice.
        const key = (it) => `${it.answer}|${(it.blanks || []).map((b) => b.at).join(',')}`;
        const have = new Set((target.items || []).map(key));
        const added = items.filter((it) => !have.has(key(it)));
        if ((target.items || []).length + added.length > MAX_SET_ITEMS) {
          return res.status(400).json({ error: req.t('That set would have more than {max} items', { max: MAX_SET_ITEMS }) });
        }
        // Content Sharing narrates every new sentence before it answers.
        await this.gatewayClient.patchLong(`/api/sets/${encodeURIComponent(target.id)}`, { items: [...(target.items || []), ...added] }, token, 5 * 60 * 1000);
        return res.json({ id: target.id, added: added.length, skipped: items.length - added.length });
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ error: req.t('Give the set a name') });
      // Made from a private set: private too, so its sentences stay the owner's.
      const source = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, token);
      const visibility = source?.visibility === 'private' ? 'private' : 'public';
      const card = await this.gatewayClient.postLong(
        '/api/sets',
        { type: 'vocab', name, desc: typeof req.body?.desc === 'string' ? req.body.desc.trim() : '', items, visibility },
        token,
        5 * 60 * 1000
      );
      res.status(201).json({ id: card?.id, added: items.length, skipped: 0 });
    } catch (err) {
      this.fail(req, res, err, 'Publishing is unavailable right now');
    }
  }
}

module.exports = ExtractRoutes;
