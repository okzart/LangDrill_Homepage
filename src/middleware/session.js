// The session cookie IS the JWT - there's no server-side session store,
// matching the stateless-token design every service in this family already
// uses (see LanguageDrill_ProgressStats/docs/DESIGN.md §1). Signed via
// cookie-parser's COOKIE_SECRET so a value edited directly in the browser
// is rejected outright, rather than this server trying to decode garbage.
const COOKIE_NAME = 'ld_token';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  signed: true,
  secure: process.env.NODE_ENV === 'production',
};

class Session {
  static setToken(res, token) {
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  }

  static clearToken(res) {
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  }

  // undefined if there's no cookie, or it failed signature verification
  // (cookie-parser puts a tampered value under req.signedCookies[name] ===
  // false rather than throwing).
  static getToken(req) {
    const value = req.signedCookies?.[COOKIE_NAME];
    return value || undefined;
  }
}

module.exports = Session;
