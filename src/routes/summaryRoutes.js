// Presentation layer for /summary - "summarize as a meeting": the user picks
// listening drill sets, their sentences are gathered into one transcript (in
// the order the sets were picked, each set's items in order), and the AI
// summarizes that transcript as if it were one meeting - overview, key
// points, decisions, action items - in English or Korean.
//
// The AI is llm-service through the gateway (/api/llm/chat/completions).
// It takes at most 8,000 characters per message (llm-service MAX_CHARS) and
// replies with at most 1,024 tokens, so a long transcript is summarized in
// parts first (notes per part), notes that are still too long are condensed
// the same way, then the notes are combined into the summary. The page drives
// a long meeting part by part (/summary/notes, then /summary/merge) so it can
// show progress and no request runs for many minutes; /summary/summarize does
// it all in one request. Nothing is stored.
//
//   GET  /summary?sets=a,b      the page (those sets ticked)
//   POST /summary/gather        { sets } → the transcript and its parts (JSON)
//   POST /summary/notes         { text } (one part) → { notes }
//   POST /summary/merge         { notes: [..], language } → the summary
//   POST /summary/summarize     { sets, language: "en" | "ko" } → the summary (JSON)
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

const MAX_SETS = 20;
const MAX_TRANSCRIPT_CHARS = 450000; // about 70 parts: 20 long sets
const PART_CHARS = 6500; // llm-service takes 8,000 characters per request, prompt included
const PARALLEL = 2; // llm-service's slots
const SECTIONS = ['Overview', 'Key points', 'Decisions', 'Action items', 'Open questions'];

const NOTES_PROMPT = `You take notes on part of a meeting transcript. The transcript has no speaker names - it is the sentences that were said, in order.
Write concise notes in English as "- " bullets (at most 15): the topics discussed, important facts and numbers, anything decided, and tasks someone took on (with who and when, if said). Do not invent anything that is not in the text. Output only the bullets.`;

function summaryPrompt(language) {
  const inKorean = language === 'ko';
  return `You summarize a meeting for someone who was not there. You get ${'{SOURCE}'}. The transcript has no speaker names.
Write the summary ${inKorean ? 'in natural Korean (keep names, numbers and English terms as they are)' : 'in clear, simple English'}, using exactly these headings in English, each on its own line followed by a colon:
Overview:
Key points:
Decisions:
Action items:
Open questions:
Under "Overview" write 2-4 sentences. Under every other heading write "- " bullets; write "- (none)" when there is nothing. Use only what is in the text - never invent people, numbers, dates or decisions. Output nothing else.`;
}

const KOREAN_REMINDER = 'Write the overview and every bullet in Korean (한국어); keep the five headings in English.';

const CONDENSE_PROMPT = `You get notes taken on consecutive parts of one meeting. Merge them into one shorter list of "- " bullets (at most 20) in English: keep every decision, task (with who and when, if said), number and open question; drop repetition. Do not invent anything. Output only the bullets.`;

class SummaryRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/summary', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/summary/gather', AsyncHandler.wrap(this.gather.bind(this)));
    this.router.post('/summary/notes', AsyncHandler.wrap(this.notes.bind(this)));
    this.router.post('/summary/merge', AsyncHandler.wrap(this.merge.bind(this)));
    this.router.post('/summary/summarize', AsyncHandler.wrap(this.summarize.bind(this)));
  }

  async show(req, res) {
    const sets = await this.gatewayClient.get('/api/sets?type=listening', req.auth.token);
    const wanted = typeof req.query.sets === 'string' ? req.query.sets.split(',').filter(Boolean).slice(0, MAX_SETS) : [];
    res.render('summary', {
      sets: (sets || []).map((s) => ({ id: s.id, name: s.name, author: s.author, count: s.count, mine: s.authorId === req.auth.user.sub })),
      preselected: wanted,
      maxSets: MAX_SETS,
    });
  }

  // The sets' sentences, set by set, in the order given:
  // { sources: [{ id, name, count }], sentences: [{ source, text }], chars }.
  async collect(req, ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw Object.assign(new Error(req.t('Choose at least one listening set')), { status: 400 });
    if (ids.length > MAX_SETS) throw Object.assign(new Error(req.t('Choose at most {max} sets', { max: MAX_SETS })), { status: 400 });
    const unique = [...new Set(ids.map(String))];
    const sets = await Promise.all(unique.map((id) => this.gatewayClient.get(`/api/sets/${encodeURIComponent(id)}`, req.auth.token)));
    const sources = [];
    const sentences = [];
    sets.forEach((set, index) => {
      if (set.type !== 'listening') return;
      const lines = (set.items || []).map((item) => (typeof item?.answer === 'string' ? item.answer.trim() : '')).filter(Boolean);
      sources.push({ id: set.id, name: set.name, count: lines.length });
      lines.forEach((text) => sentences.push({ source: index, text }));
    });
    const chars = sentences.reduce((sum, s) => sum + s.text.length + 1, 0);
    if (!sentences.length) throw Object.assign(new Error(req.t('Those sets have no sentences')), { status: 400 });
    if (chars > MAX_TRANSCRIPT_CHARS) throw Object.assign(new Error(req.t('Together those sets are too long to summarize - choose fewer')), { status: 400 });
    return { sources, sentences, chars };
  }

  fail(req, res, err, unavailable) {
    if (err.status === 400 && !(err instanceof GatewayError)) return res.status(400).json({ error: err.message });
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: req.t(unavailable) });
    }
    if (err.status === 401) Session.clearToken(res);
    res.status(err.status).json({ error: err.status >= 502 ? req.t(unavailable) : req.t(err.message) });
  }

  async gather(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    try {
      res.set('Cache-Control', 'no-store');
      const gathered = await this.collect(req, req.body?.sets);
      res.json({ ...gathered, parts: SummaryRoutes.partRanges(gathered.sentences) });
    } catch (err) {
      this.fail(req, res, err, 'Content sharing is unavailable right now');
    }
  }

  async ask(req, system, user) {
    const reply = await this.gatewayClient.postLong(
      '/api/llm/chat/completions',
      { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1024, temperature: 0.2 },
      req.auth.token,
      5 * 60 * 1000
    );
    return String(reply?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  // The transcript in parts of at most PART_CHARS, never splitting a sentence:
  // [{ from, to }] sentence indexes (to exclusive).
  static partRanges(sentences) {
    const ranges = [];
    let from = 0;
    let length = 0;
    sentences.forEach(({ text }, i) => {
      if (i > from && length + text.length + 1 > PART_CHARS) {
        ranges.push({ from, to: i });
        from = i;
        length = 0;
      }
      length += text.length + 1;
    });
    if (sentences.length > from) ranges.push({ from, to: sentences.length });
    return ranges;
  }

  // The parts' texts, one sentence per line.
  static parts(sentences) {
    return SummaryRoutes.partRanges(sentences).map(({ from, to }) => sentences.slice(from, to).map((s) => s.text).join('\n').slice(0, PART_CHARS));
  }

  // Texts joined by blank lines into chunks of at most PART_CHARS.
  static chunks(texts) {
    const chunks = [];
    let current = '';
    for (const text of texts) {
      const piece = text.slice(0, PART_CHARS);
      if (current && current.length + piece.length + 2 > PART_CHARS) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n\n' : '') + piece;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ask() for each input, PARALLEL at a time, results in order.
  async askAll(req, system, inputs) {
    const results = new Array(inputs.length);
    let next = 0;
    const worker = async () => {
      while (next < inputs.length) {
        const i = next++;
        results[i] = await this.ask(req, system, inputs[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, inputs.length) }, worker));
    return results;
  }

  // The model's reply → { overview, sections: [{ title, items }] }; a reply
  // without the expected headings is returned whole as the overview.
  static parseSummary(text) {
    const found = {};
    let current = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/^\*\*|\*\*$/g, '').replace(/^#+\s*/, '');
      const heading = SECTIONS.find((title) => new RegExp(`^${title}\\s*:?\\**\\s*:?\\s*(.*)$`, 'i').test(line));
      if (heading) {
        current = heading;
        found[current] = [];
        const rest = line.replace(new RegExp(`^${heading}\\s*:?\\**\\s*:?\\s*`, 'i'), '').trim();
        if (rest) found[current].push(rest.replace(/^[-*•]\s*/, ''));
        continue;
      }
      if (current && line) found[current].push(line.replace(/^([-*•]\s*)+/, ''));
    }
    if (!found.Overview && Object.keys(found).length === 0) return { overview: text, sections: [] };
    const none = (item) => /^\(?(none|없음)\)?\.?$/i.test(item.trim());
    return {
      overview: (found.Overview || []).join(' '),
      sections: SECTIONS.slice(1).map((title) => ({ title, items: (found[title] || []).filter((item) => !none(item)) })),
    };
  }

  // The summary from the transcript (one part) or from the notes on its parts.
  async write(req, source, parts, language) {
    const prompt = summaryPrompt(language).replace('{SOURCE}', parts === 1 ? 'the full transcript' : `notes taken on the meeting's ${parts} parts, in order`);
    // The model follows the language best when it is asked last, after the text.
    const text = await this.ask(req, prompt, language === 'ko' ? `${source}\n\n${KOREAN_REMINDER}` : source);
    return SummaryRoutes.parseSummary(text);
  }

  // Notes on every part, in order → the summary (notes condensed until they fit one message).
  async combine(req, partNotes, language) {
    let notes = partNotes.map((text, i) => `Part ${i + 1} of ${partNotes.length}:\n${text}`);
    for (let round = 0; notes.join('\n\n').length > PART_CHARS && round < 4; round++) {
      notes = await this.askAll(req, CONDENSE_PROMPT, SummaryRoutes.chunks(notes));
    }
    return this.write(req, notes.join('\n\n').slice(0, PART_CHARS), partNotes.length, language);
  }

  // One part of a long transcript → notes on it.
  async notes(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > PART_CHARS) return res.status(400).json({ error: req.t('Something went wrong.') });
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ notes: await this.ask(req, NOTES_PROMPT, text) });
    } catch (err) {
      this.fail(req, res, err, 'The AI is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }

  // The notes on every part, in order → the summary.
  async merge(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const language = req.body?.language === 'ko' ? 'ko' : 'en';
    const notes = req.body?.notes;
    const valid = Array.isArray(notes) && notes.length > 0 && notes.length <= Math.ceil(MAX_TRANSCRIPT_CHARS / PART_CHARS) * 2
      && notes.every((n) => typeof n === 'string' && n.length <= PART_CHARS);
    if (!valid) return res.status(400).json({ error: req.t('Something went wrong.') });
    const started = Date.now();
    try {
      const summary = await this.combine(req, notes.map((n) => n.trim() || '- (nothing)'), language);
      res.set('Cache-Control', 'no-store');
      res.json({ ...summary, language, parts: notes.length, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (err) {
      this.fail(req, res, err, 'The AI is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }

  async summarize(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const language = req.body?.language === 'ko' ? 'ko' : 'en';
    const started = Date.now();
    try {
      const { sources, sentences } = await this.collect(req, req.body?.sets);
      const parts = SummaryRoutes.parts(sentences);
      const summary = parts.length === 1
        ? await this.write(req, `Transcript:\n${parts[0]}`, 1, language)
        : await this.combine(req, await this.askAll(req, NOTES_PROMPT, parts), language);
      res.set('Cache-Control', 'no-store');
      res.json({
        ...summary,
        language,
        sources,
        sentenceCount: sentences.length,
        parts: parts.length,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    } catch (err) {
      this.fail(req, res, err, 'The AI is unavailable right now (is llm-service running? scripts/gpu-services.sh status)');
    }
  }
}

module.exports = SummaryRoutes;
