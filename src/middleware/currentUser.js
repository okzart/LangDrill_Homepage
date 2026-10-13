const Session = require('./session');
const { decodeJwtPayload, isExpired } = require('../services/jwt');
const Avatar = require('../services/avatar');

// Runs on every request (mounted app-wide in server.js). Makes the caller's
// token/claims available two ways:
//   - req.auth = { token, user: { sub, email, role } } when logged in and
//     the token hasn't expired, otherwise undefined - routes/middleware
//     that need to require login check this (see requireLogin.js).
//   - res.locals.currentUser - the same `user` object (or undefined), so
//     every view can render "logged in as ..." / nav links without each
//     route handler passing it in explicitly.
// An expired or undecodable token is treated as logged-out here rather
// than erroring - the user just sees the logged-out nav and gets sent
// through /login again the next time they hit a page that requires it.
function currentUser(req, res, next) {
  const token = Session.getToken(req);
  if (token) {
    const payload = decodeJwtPayload(token);
    if (payload && !isExpired(payload)) {
      // `name`: the display name others see - the nickname, or a neutral
      // stand-in (Authentication's dto/userDto.js#displayName, repeated
      // here for a token issued before it carried one).
      const name = typeof payload.name === 'string' && payload.name ? payload.name : `learner-${String(payload.sub || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()}`;
      req.auth = { token, user: { sub: payload.sub, email: payload.email, role: payload.role || 'user', name } };
    }
  }
  res.locals.currentUser = req.auth?.user;
  // The name their drill sets are published under: their display name.
  // Content Sharing takes it from the login token and ignores anything a
  // form sends, so the forms only show it.
  res.locals.authorName = req.auth?.user?.name || '';
  // Their profile image, if they have one (see services/avatar.js) - for the
  // top bar on every page.
  res.locals.myAvatar = Avatar.remembered(req, req.auth?.user?.sub);
  // For the nav's "you are here" highlight (views/_nav.pug).
  res.locals.currentPath = req.path;
  next();
}

module.exports = currentUser;
