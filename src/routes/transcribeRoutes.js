// Presentation layer for /transcribe - the video/audio transcription tool
// with its subtitle editor (views/transcribe.pug + src/public/transcribe/):
// drop a file, get subtitles, then fix them against the video on a timeline
// and export SRT or Final Cut Pro XML.
//
// The page extracts the audio in the browser (16 kHz mono MP3) and posts it
// to POST /transcribe/run. That request is relayed, untouched, to the API
// Gateway's /api/stt/transcriptions (stt-service, Whisper) - never to the
// service directly (see docs/DESIGN.md §1) - and the answer (segments + word
// timings) is cut into subtitle-sized chunks here (services/subtitleChunker.js).
//
// The response is a Server-Sent Events stream of JSON messages, the contract
// the editor script was written against when this tool ran Whisper as a
// local process:
//   { type: 'status',  message }
//   { type: 'segment', index, start, end, text, block }   one per subtitle
//   { type: 'done',    srt, total_segments }
//   { type: 'error',   message, code? }
// stt-service answers all at once, so 'status' doubles as a keep-alive while
// it works. Nothing is stored: the audio only passes through.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');
const { chunkTranscription, srtBlock } = require('../services/subtitleChunker');

// stt-service's own upload limit (MAX_FILE_MB); about 100 minutes of the
// 32 kbps MP3 the page produces.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// A long recording can take several minutes on a busy GPU.
const TIMEOUT_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 5000;

class TranscribeRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    // The shell (top bar + frame) and, inside the frame, the tool itself.
    this.router.get('/transcribe', requireLogin, (req, res) => res.render('transcribe'));
    this.router.get('/transcribe/app', requireLogin, (req, res) => res.render('transcribe-app', { maxUploadMb: MAX_UPLOAD_BYTES / 1024 / 1024 }));
    this.router.post('/transcribe/run', this.run.bind(this));
  }

  // Body: multipart/form-data exactly as stt-service wants it (file,
  // language?, response_format=verbose_json, timestamp_granularities[]=word,
  // vad_filter) - the page builds it, this only pipes it through. The
  // subtitle-chunking settings travel in the query string, since they are
  // this server's business, not stt-service's.
  async run(req, res) {
    const t = req.t;
    if (!req.auth) return res.status(401).json({ error: t('Not logged in') });
    const contentType = req.get('content-type') || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return res.status(400).json({ error: t('Send the file as multipart/form-data') });
    }
    if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES + 64 * 1024) {
      return res.status(413).json({ error: t('The audio is larger than {mb} MB - try a shorter recording.', { mb: MAX_UPLOAD_BYTES / 1024 / 1024 }) });
    }

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let open = true;
    res.on('close', () => { open = false; });
    const emit = (message) => { if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); };

    const started = Date.now();
    emit({ type: 'status', message: t('Transcribing with Whisper (stt-service)…') });
    const heartbeat = setInterval(() => {
      emit({ type: 'status', message: t('Transcribing with Whisper (stt-service)… {n} s', { n: Math.round((Date.now() - started) / 1000) }) });
    }, HEARTBEAT_MS);

    try {
      const result = await this.gatewayClient.postStream('/api/stt/transcriptions', req, contentType, req.auth.token, TIMEOUT_MS);
      clearInterval(heartbeat);
      if (result?.language) emit({ type: 'status', message: t('Detected language: {lang}', { lang: result.language }) });
      const chunks = chunkTranscription(result, {
        maxChars: req.query.max_chars,
        maxDuration: req.query.max_duration,
        pauseThreshold: req.query.pause,
      });
      const blocks = chunks.map(srtBlock);
      chunks.forEach((chunk, i) => emit({ type: 'segment', ...chunk, block: blocks[i] }));
      emit({ type: 'done', srt: blocks.length ? `${blocks.join('\n\n')}\n` : '', total_segments: blocks.length });
    } catch (err) {
      clearInterval(heartbeat);
      // `code: 'auth'` lets the page send the user to /login whatever the language.
      emit({ type: 'error', message: TranscribeRoutes.describe(err, t, res), ...(err instanceof GatewayError && err.status === 401 ? { code: 'auth' } : {}) });
    }
    if (!res.writableEnded) res.end();
  }

  static describe(err, t, res) {
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return t('Transcription is unavailable right now (is stt-service running? scripts/gpu-services.sh status)');
    }
    if (err.status === 401) {
      Session.clearToken(res); // headers are already sent; harmless, and the page reloads to /login on this message
      return t('Not logged in');
    }
    if (err.status === 413) return t('The audio is larger than {mb} MB - try a shorter recording.', { mb: MAX_UPLOAD_BYTES / 1024 / 1024 });
    if (err.status === 504) return t('Transcription took too long and was stopped - try a shorter recording.');
    if (err.status >= 502) return t('Transcription is unavailable right now (is stt-service running? scripts/gpu-services.sh status)');
    return t(err.message);
  }
}

module.exports = TranscribeRoutes;
