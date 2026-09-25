// Presentation layer for /chat - a chat page for the self-hosted LLM
// (llm-service) that can also read its replies aloud (tts-service). Calls
// the API Gateway's /api/llm and /api/tts routes, never those services
// directly (see docs/DESIGN.md §1). Both are streamed: the browser POSTs to
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
// tts-service's overall_grade scale, best first (same as communityRoutes.js).
const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];
// The page speaks one sentence per request, so this is generous; it only
// stops a single request from tying up the GPU with a huge input.
const MAX_SPEECH_CHARS = 1000;

class ChatRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/chat', requireLogin, AsyncHandler.wrap(this.showChat.bind(this)));
    this.router.post('/chat/completions', AsyncHandler.wrap(this.complete.bind(this)));
    this.router.post('/chat/speech', AsyncHandler.wrap(this.speech.bind(this)));
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

    res.render('chat', {
      model,
      modelError,
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
      return res.status(401).json({ error: 'Not logged in' });
    }
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    await this.pipeFromGateway(req, res, '/api/llm/chat/completions', { messages, stream: true }, 'text/event-stream');
  }

  // Streams speech for one piece of text as audio/mpeg. tts-service
  // synthesizes on the fly and streams its output, so the audio exists only
  // in transit - unlike Content Sharing's cached vocab mp3s.
  async speech(req, res) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const { text, voice } = req.body || {};
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SPEECH_CHARS) {
      return res.status(400).json({ error: `text must be 1-${MAX_SPEECH_CHARS} characters` });
    }
    if (voice !== undefined && (typeof voice !== 'string' || !VOICE_ID.test(voice))) {
      return res.status(400).json({ error: 'voice must be a tts voice id, e.g. "af_heart"' });
    }
    await this.pipeFromGateway(
      req,
      res,
      '/api/tts/speech',
      { input: text, voice: voice || DEFAULT_VOICE, response_format: 'mp3' },
      'audio/mpeg'
    );
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
      return res.status(502).json({ error: 'Service unreachable' });
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
