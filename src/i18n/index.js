// UI language (English / Korean) for every page. gettext-style: templates
// and page scripts call t(englishText, vars), and ko.json maps that
// exact English string to Korean. A string with no Korean entry falls back
// to English, so a missing translation never breaks a page
// (`npm run i18n:check` lists them).
//
// The choice is kept in the `ld_lang` cookie (set by GET /lang/:code - the
// nav's EN / 한국어 switch); with no cookie, the browser's Accept-Language
// decides. Exposed to views as `lang` and `t`, and to page scripts via
// window.t (see views/_i18n.pug).
const ko = require('./ko.json');

const LANGS = ['en', 'ko'];
const COOKIE = 'ld_lang';
const DICTS = { ko };
// What page scripts get: the plain entries (patterns are applied server-side only).
const CLIENT_DICTS = { ko: Object.fromEntries(Object.entries(ko).filter(([k]) => !k.startsWith('@'))) };

function interpolate(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m));
}

// "@patterns" in a dictionary: [[regex, replacement], ...] for messages
// that carry numbers or names (mostly ones relayed from backend services,
// e.g. "wrong code or password - 4 tries left"), tried when there's no
// exact entry. Replacements use $1, $2... for the captured parts.
function compilePatterns(dict) {
  return ((dict && dict['@patterns']) || []).map(([re, to]) => [new RegExp(`^${re}$`), to]);
}
const PATTERNS = { ko: compilePatterns(ko) };

function lookup(lang, text) {
  const dict = DICTS[lang];
  if (!dict || typeof text !== 'string') return text;
  if (Object.prototype.hasOwnProperty.call(dict, text) && typeof dict[text] === 'string') return dict[text];
  for (const [re, to] of PATTERNS[lang]) {
    if (re.test(text)) return text.replace(re, to);
  }
  return text;
}

function translator(lang) {
  return (text, vars) => interpolate(lookup(lang, text), vars);
}

function pickLang(req) {
  const fromCookie = req.cookies?.[COOKIE];
  if (LANGS.includes(fromCookie)) return fromCookie;
  return /^ko\b/i.test(req.get('accept-language') || '') ? 'ko' : 'en';
}

// Mounted app-wide after cookie-parser.
function middleware(req, res, next) {
  const lang = pickLang(req);
  req.lang = lang;
  req.t = translator(lang);
  res.locals.lang = lang;
  res.locals.t = req.t;
  // The Korean dictionary for window.t in page scripts (English pages need none).
  res.locals.clientDict = lang === 'en' ? null : CLIENT_DICTS[lang];
  // Where the language switch sends you back to. A POST-rendered page (e.g.
  // the registration code step) can't be re-requested with GET, so those
  // go to a safe page instead.
  res.locals.langReturn = req.method === 'GET' ? req.originalUrl : req.auth ? '/dashboard' : '/login';
  next();
}

// GET /lang/:code?next=/somewhere - remember the choice for a year, go back.
function switchRoute(req, res) {
  const lang = LANGS.includes(req.params.code) ? req.params.code : 'en';
  res.cookie(COOKIE, lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: false });
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/dashboard';
  res.redirect(next);
}

module.exports = { middleware, switchRoute, translator, LANGS };
