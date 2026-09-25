// The English narration voices Content Sharing accepts (GET /api/sets/voices),
// shaped for a <select>. Shared by the pages that let a user pick one:
// Community's vocab-set builder (routes/communityRoutes.js) and Passages
// (routes/passagesRoutes.js).

// tts-service's overall_grade scale, best first - used to sort voice
// pickers so the better-sounding voices are on top. Ungraded voices go last.
const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];

// `{ default, voices: [{ id, label }] }`, best-graded first, or null when
// Content Sharing can't reach tts-service (or the call fails at all) - the
// page then just omits the picker and the service's default voice is used.
// Never throws: a missing picker shouldn't break the page.
async function loadVoiceOptions(gatewayClient) {
  let result;
  try {
    result = await gatewayClient.get('/api/sets/voices');
  } catch {
    return null;
  }
  if (!result || !Array.isArray(result.voices) || result.voices.length === 0) {
    return null;
  }
  const rank = (v) => {
    const i = GRADE_ORDER.indexOf(v.grade);
    return i === -1 ? GRADE_ORDER.length : i;
  };
  const voices = [...result.voices]
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((v) => ({ id: v.id, label: voiceLabel(v) }));
  return { default: result.default, voices };
}

// "af_heart — American English, female (grade A)". Kokoro voice ids encode
// accent + gender in their first two letters (see Content Sharing's
// services/voiceCatalog.js, which only ever returns a*/b* ids).
function voiceLabel(voice) {
  const accent = { a: 'American English', b: 'British English' }[voice.id[0]] || 'English';
  const gender = { f: 'female', m: 'male' }[voice.id[1]] || '';
  const grade = voice.grade ? ` (grade ${voice.grade})` : '';
  return `${voice.id} — ${accent}${gender ? `, ${gender}` : ''}${grade}`;
}

module.exports = { GRADE_ORDER, loadVoiceOptions, voiceLabel };
