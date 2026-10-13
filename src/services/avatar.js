// Profile images on the website. The images live in the Authentication
// service; a user record says where (`avatarUrl`, a path on that service,
// e.g. "/auth/avatars/<id>?v=<version>", or null). Browsers can't fetch that
// - it needs the login token - so pages use the same path under /avatar
// here (routes/avatarRoutes.js), which adds the token.
//
// The logged-in user's own image is wanted on every page (the top bar), and
// asking Authentication for it on every page load would be wasteful, so its
// address is remembered in a cookie: set at login, refreshed whenever the
// profile page is opened or the image changes, dropped at logout.
const COOKIE = 'ld_avatar';
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, secure: process.env.NODE_ENV === 'production' };
const SERVICE_PATH = /^\/auth\/avatars\/([^/?#]+)(\?v=[^#]*)?$/;

// "/auth/avatars/<id>?v=…" (as Authentication returns it) → "/avatar/<id>?v=…"
// for an <img> on this site; null for no image or anything unexpected.
function siteUrl(avatarUrl) {
  const match = typeof avatarUrl === 'string' ? SERVICE_PATH.exec(avatarUrl) : null;
  return match ? `/avatar/${match[1]}${match[2] || ''}` : null;
}

// Remembers (or forgets, when they have none) the image of `user` - a user
// record from Authentication - as the logged-in user's.
function remember(res, user) {
  const url = siteUrl(user?.avatarUrl);
  if (url) res.cookie(COOKIE, `${user.id} ${url}`, COOKIE_OPTIONS);
  else forget(res);
}

function forget(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: COOKIE_OPTIONS.secure });
}

// The remembered image address of the logged-in user, or null. The cookie
// names the user it belongs to, so one left by another account is ignored.
function remembered(req, userId) {
  const value = req.cookies?.[COOKIE];
  if (typeof value !== 'string' || !userId) return null;
  const [owner, url] = value.split(' ');
  return owner === userId && /^\/avatar\/[^/?#]+(\?v=[^#"'<>\s]*)?$/.test(url || '') ? url : null;
}

// Adds `authorAvatar` - the image of whoever published it, as an address on
// this site, or null - to each of `sets` (cards or full sets from Content
// Sharing, which name their publisher in `authorId`). One lookup for all of
// them. Never throws: a page of sets is still a page of sets without
// pictures, so on any failure every `authorAvatar` is simply null.
async function withAuthorAvatars(gatewayClient, token, sets) {
  const list = Array.isArray(sets) ? sets : [];
  const ids = [...new Set(list.map((set) => set?.authorId).filter(Boolean))].slice(0, 200);
  let avatars = {};
  if (ids.length) {
    try {
      avatars = (await gatewayClient.get(`/api/auth/avatars?ids=${ids.map(encodeURIComponent).join(',')}`, token))?.avatars || {};
    } catch (error) {
      avatars = {};
    }
  }
  return list.map((set) => ({ ...set, authorAvatar: siteUrl(avatars[set?.authorId]) }));
}

module.exports = { siteUrl, remember, forget, remembered, withAuthorAvatars };
