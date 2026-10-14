// Presentation layer for /chat - a chat page for the self-hosted LLM
// (llm-service) that can also read its replies aloud (tts-service) and take
// spoken input (stt-service). Calls the API Gateway's /api/llm, /api/tts and
// /api/stt routes, never those services directly (see docs/DESIGN.md §1). Both are streamed: the browser POSTs to
// /chat/completions or /chat/speech here, this server forwards the request
// with the caller's token and pipes the gateway's response back unchanged
// (Server-Sent Events for text, audio/mpeg for speech), so the token never
// leaves the httpOnly session cookie and no audio is ever written to disk.
const express = require('express');
const { Readable } = require('stream');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');
const { GRADE_ORDER } = require('../services/voiceOptions');

const DEFAULT_VOICE = 'af_heart';
// Kokoro voice ids are "<language><gender>_<name>" (e.g. "ef_dora" = Spanish,
// female); tts-service only accepts ids of this shape anyway.
const VOICE_ID = /^[a-z][fm]_[a-z0-9_]+$/;
const VOICE_LANGUAGES = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese',
};
// The page speaks one sentence per request, so this is generous; it only
// stops a single request from tying up the GPU with a huge input.
const MAX_SPEECH_CHARS = 1000;
// Voice input: the page caps a recording at 60 s (~0.5 MB of opus); this is
// stt-service's own upload limit.
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const STT_LANGUAGES = ['en', 'ko'];
const AUDIO_EXTENSIONS = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

// The tutor's instructions (the "system prompt"). Only admins may see or
// change them on the page; for everyone else the server decides them, and
// any system message a non-admin's request carries is dropped - so the
// tutor can't be talked out of its role by editing a hidden field.
const DEFAULT_SYSTEM_PROMPT = 'You are a friendly, concise language tutor. When the user writes in a language they are learning, gently correct mistakes and explain briefly.';
const MAX_SYSTEM_PROMPT = 4000;
// A place the Map page sends a learner to role-play (`?place=Café`): only
// the name of one of the Map's place kinds (Content Sharing's
// /places/categories) is taken - anything else would be a way to slip
// instructions into the tutor's prompt. The list is fetched now and then.
const PLACES_CACHE_MS = 10 * 60 * 1000;

class ChatRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.places = null; // { names: Set(lowercased), at }
    this.router = express.Router();

    this.router.get('/chat', requireLogin, AsyncHandler.wrap(this.showChat.bind(this)));
    this.router.post('/chat/completions', AsyncHandler.wrap(this.complete.bind(this)));
    this.router.post('/chat/speech', AsyncHandler.wrap(this.speech.bind(this)));
    // The browser posts the recording as the raw request body (Content-Type
    // audio/webm etc.) - simpler than multipart on the page, and nothing
    // else in this app parses audio bodies.
    this.router.post(
      '/chat/transcribe',
      express.raw({ type: ['audio/*', 'application/octet-stream'], limit: MAX_RECORDING_BYTES }),
      AsyncHandler.wrap(this.transcribe.bind(this))
    );
  }

  // The model name and voice list only decorate the page, so a failure
  // loading either (service down, model still loading) renders the page
  // with a warning / without the voice picker instead of the error page.
  async showChat(req, res) {
    const [models, voices] = await Promise.allSettled([
      this.gatewayClient.get('/api/llm/models', req.auth.token),
      this.gatewayClient.get('/api/tts/voices', req.auth.token),
    ]);
    for (const result of [models, voices]) {
      if (result.status === 'rejected' && result.reason instanceof GatewayError && result.reason.status === 401) {
        throw result.reason;
      }
    }

    let model = null;
    let modelError = null;
    if (models.status === 'fulfilled') {
      model = models.value?.data?.[0]?.id || null;
    } else {
      modelError = models.reason instanceof GatewayError ? models.reason.message : 'LLM service unreachable';
    }

    const place = await this.placeFrom(req, req.query.place);
    res.render('chat', {
      model,
      modelError,
      place,
      // Shown (and editable) for admins only - see #complete.
      systemPrompt: req.auth?.user?.role === 'admin' ? ChatRoutes.systemPromptFor(req, place) : null,
      voiceGroups: voices.status === 'fulfilled' ? ChatRoutes.voiceGroups(voices.value?.voices) : null,
      defaultVoice: DEFAULT_VOICE,
    });
  }

  // Called by the page's own fetch(), not by navigation, so failures are
  // answered as JSON `{ error }` (401 included - the page redirects to
  // /login itself) rather than going through errorHandler.js's
  // redirect/error-page responses.
  async complete(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: req.t('Not logged in') });
    }
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: req.t('messages must be a non-empty array') });
    }
    // The conversation itself: user and assistant turns only.
    const turns = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0) return res.status(400).json({ error: req.t('messages must be a non-empty array') });
    // An admin's own system prompt is used as sent; everyone else gets the
    // one built here, for the role-play place if there is one.
    const sent = messages[0]?.role === 'system' && typeof messages[0].content === 'string' ? messages[0].content.trim() : '';
    const system = req.auth.user.role === 'admin' && sent
      ? sent.slice(0, MAX_SYSTEM_PROMPT)
      : ChatRoutes.systemPromptFor(req, await this.placeFrom(req, req.body?.place));
    await this.pipeFromGateway(req, res, '/api/llm/chat/completions', { messages: [{ role: 'system', content: system }, ...turns], stream: true }, 'text/event-stream');
  }

  // `value` if it names one of the Map's place kinds, else null.
  async placeFrom(req, value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 60) return null;
    if (!this.places || Date.now() - this.places.at > PLACES_CACHE_MS) {
      try {
        const data = await this.gatewayClient.get('/api/places/categories', req.auth.token);
        const names = (data?.categories || []).map((c) => String(c.en || c.title || '').toLowerCase()).filter(Boolean);
        this.places = { names: new Set(names), at: Date.now() };
      } catch {
        return null; // without the list, no role-play: the usual tutor
      }
    }
    return this.places.names.has(value.trim().toLowerCase()) ? value.trim() : null;
  }

  // The tutor's instructions: the usual tutor, or - for a place from the
  // Map page - a member of staff there for the learner to practise with.
  static systemPromptFor(req, place) {
    if (!place) return req.t(DEFAULT_SYSTEM_PROMPT);
    return `You are playing a staff member at a ${place.toLowerCase()}. The user is a Korean learner of English practising what to say there. Stay in character, speak natural English in short turns, and wait for the user. If the user makes a mistake, give a brief correction in brackets after your reply.`;
  }

  // Streams speech for one piece of text as audio/mpeg. tts-service
  // synthesizes on the fly and streams its output, so the audio exists only
  // in transit - unlike Content Sharing's cached vocab mp3s.
  async speech(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: req.t('Not logged in') });
    }
    const { text, voice } = req.body || {};
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SPEECH_CHARS) {
      return res.status(400).json({ error: req.t('text must be 1-{max} characters', { max: MAX_SPEECH_CHARS }) });
    }
    if (voice !== undefined && (typeof voice !== 'string' || !VOICE_ID.test(voice))) {
      return res.status(400).json({ error: req.t('voice must be a tts voice id, e.g. "af_heart"') });
    }
    await this.pipeFromGateway(
      req,
      res,
      '/api/tts/speech',
      { input: text, voice: voice || DEFAULT_VOICE, response_format: 'mp3' },
      'audio/mpeg'
    );
  }

  // Speech-to-text for the chat's microphone button: relays the recording
  // to the gateway's /api/stt/transcriptions (Whisper) and returns
  // { text }. `?language=en|ko` pins the language (faster and more reliable
  // on short clips than auto-detection); anything else auto-detects. The
  // audio is only relayed, never stored.
  async transcribe(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: req.t('Not logged in') });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: req.t('Send the recording as an audio/* request body') });
    }
    const type = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const form = new FormData();
    form.append('file', new Blob([req.body], { type }), `recording.${AUDIO_EXTENSIONS[type] || 'webm'}`);
    form.append('response_format', 'json');
    if (STT_LANGUAGES.includes(req.query.language)) form.append('language', req.query.language);
    try {
      const result = await this.gatewayClient.postMultipart('/api/stt/transcriptions', form, req.auth.token);
      res.set('Cache-Control', 'no-store');
      res.json({ text: (result?.text || '').trim() });
    } catch (err) {
      if (!(err instanceof GatewayError)) {
        console.error(err);
        return res.status(502).json({ error: req.t('Speech recognition is unavailable right now') });
      }
      if (err.status === 401) Session.clearToken(res);
      // 502/503/504: stt-service not running or still loading its model.
      const message = err.status >= 502 ? 'Speech recognition is unavailable right now' : err.message;
      res.status(err.status).json({ error: message });
    }
  }

  // POSTs `body` to the gateway and pipes the streamed response straight to
  // the browser. Stops the upstream request (freeing its GPU slot) if the
  // browser goes away first, e.g. the Stop button, a closed tab, or a reload.
  async pipeFromGateway(req, res, path, body, contentType) {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstream;
    try {
      upstream = await this.gatewayClient.stream(path, body, req.auth.token, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof GatewayError) {
        if (err.status === 401) Session.clearToken(res);
        return res.status(err.status).json({ error: err.message });
      }
      console.error(err);
      return res.status(502).json({ error: req.t('Service unreachable') });
    }

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    const stream = Readable.fromWeb(upstream.body);
    // An abort (above) or a dropped gateway connection errors the stream
    // mid-response; the response has already started, so just end it.
    stream.on('error', () => res.end());
    stream.pipe(res);
  }

  // tts-service's voice list → `[{ language, voices: [{ id, label }] }]` for
  // the page's <optgroup>s: languages in VOICE_LANGUAGES order, best-graded
  // voices first. Unknown languages/odd ids are skipped. null if empty.
  static voiceGroups(voices) {
    if (!Array.isArray(voices)) return null;
    const rank = (v) => {
      const i = GRADE_ORDER.indexOf(v.overall_grade);
      return i === -1 ? GRADE_ORDER.length : i;
    };
    const groups = Object.entries(VOICE_LANGUAGES).map(([code, language]) => ({
      language,
      voices: voices
        .filter((v) => typeof v?.id === 'string' && VOICE_ID.test(v.id) && v.id[0] === code)
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
        .map((v) => ({
          id: v.id,
          label: `${v.id} — ${v.id[1] === 'f' ? 'female' : 'male'}${v.overall_grade ? ` (grade ${v.overall_grade})` : ''}`,
        })),
    })).filter((group) => group.voices.length > 0);
    return groups.length > 0 ? groups : null;
  }
}

module.exports = ChatRoutes;
