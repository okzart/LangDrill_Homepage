// Cuts a Whisper transcription (stt-service's verbose_json: segments + word
// timings) into readable subtitle-sized chunks and formats them as SRT. Used
// by routes/transcribeRoutes.js.
//
// A single Whisper segment can run 15-20+ seconds of continuous speech; a
// subtitle should not. Each segment's words are regrouped: a chunk ends at a
// sentence end, at a natural pause between words, or - once it would overrun
// the character/duration budget - at the last clause break (comma etc.), or
// failing that right there. Pure functions, no I/O.
//
// (Port of the rechunk_segment() logic from the standalone transcribe tool
// this page came from, which ran faster-whisper locally.)

const SENTENCE_END_CHARS = '.!?…。！？';
const CLAUSE_BREAK_CHARS = ',;，、·';
const CJK_LANGUAGES = new Set(['ko', 'ja', 'zh']);
const MIN_CLAUSE_CHARS = 8;

const DEFAULTS = { maxDuration: 6.0, pauseThreshold: 0.5 };

// CJK subtitles read denser per character than Latin script.
function defaultMaxChars(language) {
  return CJK_LANGUAGES.has(language) ? 28 : 80;
}

// stt-service returns words trimmed and in one flat list, and each segment's
// text separately. Whisper's own spacing lives in the segment text ("안녕하세요.
// 반갑습니다" - and no spaces at all in Japanese/Chinese), so each word gets
// back the exact slice of its segment's text, leading whitespace included.
// → [{ start, end, word }] per segment, `word` being that raw slice.
function wordsBySegment(segments, words) {
  const groups = segments.map(() => []);
  let s = 0;
  for (const word of words) {
    // A word belongs to the last segment that starts at or before it.
    while (s < segments.length - 1 && word.start >= segments[s + 1].start - 0.001) s++;
    groups[s].push(word);
  }
  return segments.map((segment, i) => {
    const text = segment.text || '';
    let cursor = 0;
    return groups[i].map((w) => {
      const plain = String(w.word || '').trim();
      const at = plain ? text.indexOf(plain, cursor) : -1;
      if (at === -1) return { start: w.start, end: w.end, word: ` ${plain}` }; // can't align: fall back to a space
      const raw = text.slice(cursor, at + plain.length);
      cursor = at + plain.length;
      return { start: w.start, end: w.end, word: raw };
    });
  });
}

// One segment's words → [{ start, end, text }] chunks.
function rechunk(words, { maxChars, maxDuration, pauseThreshold }) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  let clauseBreakAt = null; // index into `cur` of the last word ending in clause punctuation

  const close = (pieces) => {
    const text = pieces.map((w) => w.word).join('').trim();
    if (text) chunks.push({ start: pieces[0].start, end: pieces[pieces.length - 1].end, text });
  };
  const reset = () => { cur = []; curLen = 0; clauseBreakAt = null; };

  for (const w of words) {
    const stripped = w.word.trim();
    if (!stripped) continue;

    if (cur.length) {
      const gap = w.start - cur[cur.length - 1].end;
      const duration = w.end - cur[0].start;
      if (duration > maxDuration || curLen + w.word.length > maxChars) {
        if (clauseBreakAt !== null && clauseBreakAt < cur.length - 1) {
          close(cur.slice(0, clauseBreakAt + 1));
          cur = cur.slice(clauseBreakAt + 1);
          curLen = cur.reduce((n, x) => n + x.word.length, 0);
          clauseBreakAt = null;
        } else {
          close(cur);
          reset();
        }
      } else if (gap > pauseThreshold) {
        close(cur);
        reset();
      }
    }

    cur.push(w);
    curLen += w.word.length;

    const last = stripped[stripped.length - 1];
    if (SENTENCE_END_CHARS.includes(last)) {
      close(cur);
      reset();
    } else if (CLAUSE_BREAK_CHARS.includes(last) && curLen >= MIN_CLAUSE_CHARS) {
      clauseBreakAt = cur.length - 1;
    }
  }
  if (cur.length) close(cur);
  return chunks;
}

// verbose_json → [{ index, start, end, text }]. `options` may carry maxChars,
// maxDuration, pauseThreshold; anything missing or invalid uses the default.
function chunkTranscription(result, options = {}) {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const words = Array.isArray(result?.words) ? result.words : [];
  const num = (v, fallback, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback);
  const settings = {
    maxChars: num(options.maxChars, defaultMaxChars(result?.language), 5, 400),
    maxDuration: num(options.maxDuration, DEFAULTS.maxDuration, 0.5, 60),
    pauseThreshold: num(options.pauseThreshold, DEFAULTS.pauseThreshold, 0.05, 10),
  };

  const out = [];
  const grouped = wordsBySegment(segments, words);
  segments.forEach((segment, i) => {
    const text = (segment.text || '').trim();
    // No word timings for this segment (shouldn't happen with word
    // timestamps on): keep it whole rather than lose it.
    const chunks = grouped[i].length ? rechunk(grouped[i], settings) : text ? [{ start: segment.start, end: segment.end, text }] : [];
    for (const chunk of chunks) out.push({ index: out.length + 1, ...chunk });
  });
  return out;
}

function formatSrtTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// One chunk → its SRT block ("1\n00:00:01,000 --> 00:00:03,500\ntext").
function srtBlock(chunk) {
  return `${chunk.index}\n${formatSrtTime(chunk.start)} --> ${formatSrtTime(chunk.end)}\n${chunk.text}`;
}

module.exports = { chunkTranscription, srtBlock, formatSrtTime, defaultMaxChars, wordsBySegment, rechunk };
