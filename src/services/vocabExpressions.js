// Turns a vocab drill item (see LangDrillApp/docs/13.community_content_formats.md
// §2.A: { ko, answer, keyKo?, blanks: [{ at, word }] }) into the
// { expression, example, meaning } shape Content Sharing's /passages
// accepts, so the Passages page can build a passage from drill items.
//
// The expression is the answer's words from the first blank to the last:
// blanks often hide only part of an idiom ("get this initiative [off] the
// [ground]", "[took] one for the [team]"), and the words in between are
// part of it. `at` counts only words matching [A-Za-z']+ (punctuation,
// digits and hyphens aren't words) - exactly the mobile app's tokenizer
// (LangDrillApp lib/data/drill_data.dart#tokenize), which creates blanks.

// Longer spans are more likely two separate blanks than one idiom; fall
// back to just the blanked words then.
const MAX_SPAN_WORDS = 6;

const stripEdges = (s) => s.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
const WORD = /[A-Za-z']+/g;

function fromVocabItem(item) {
  const raw = typeof item?.answer === 'string' ? item.answer : '';
  const answer = raw.replace(/\s+([.,!?;:])/g, '$1').trim();
  const words = [...raw.matchAll(WORD)]; // words[i] = word #i, with its offset in `raw`
  const blanks = (Array.isArray(item?.blanks) ? item.blanks : [])
    .filter((b) => b && typeof b.word === 'string' && b.word.trim())
    .sort((a, b) => a.at - b.at);

  // Only trust `at` when it really points at the blanked word.
  const located = blanks.filter(
    (b) => Number.isInteger(b.at) && words[b.at] && words[b.at][0].toLowerCase() === stripEdges(b.word).toLowerCase()
  );
  let expression;
  if (located.length > 0 && located.at(-1).at - located[0].at < MAX_SPAN_WORDS) {
    const first = words[located[0].at];
    const last = words[located.at(-1).at];
    // The answer's own text between them keeps hyphens, digits, etc.
    expression = raw.slice(first.index, last.index + last[0].length);
  } else {
    expression = blanks.map((b) => b.word).join(' ');
  }
  // [ ] | are reserved by /passages; placeholders like "[topic]" become words.
  expression = stripEdges(expression.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' '));

  const meaning = (item?.keyKo || item?.ko || '').trim();
  return {
    expression,
    example: answer.replace(/\[\[|\]\]/g, ''),
    meaning,
    ko: typeof item?.ko === 'string' ? item.ko : '',
  };
}

module.exports = { fromVocabItem };
