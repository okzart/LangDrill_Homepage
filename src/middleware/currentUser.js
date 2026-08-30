const Session = require('./session');
const { decodeJwtPayload, isExpired } = require('../services/jwt');

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
      req.auth = { token, user: { sub: payload.sub, email: payload.email, role: payload.role || 'user' } };
    }
  }
  res.locals.currentUser = req.auth?.user;
  next();
}

module.exports = currentUser;
