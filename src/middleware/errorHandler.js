const { GatewayError } = require('../errors');
const Session = require('./session');

// Express error-handling middleware, registered last (see server.js -
// Express recognizes it by its 4-argument signature).
//
// A GatewayError means the gateway/a service answered with a non-2xx
// status (see services/gatewayClient.js):
//   - 401: the caller's token is missing/invalid/expired from the
//     backend's point of view even though it looked valid locally (e.g.
//     it expired in the seconds since currentUser.js decoded it, or the
//     account was deleted) - clear the stale cookie and send them back to
//     /login rather than showing an error page for a problem "logging in
//     again" fixes.
//   - anything else (400/403/404/409/...): show the message on a generic
//     error page. The status and message already come from the
//     service's own validation/authorization/not-found errors, so there's
//     nothing more specific to add here.
// Anything else is an unexpected bug rather than an expected failure
// case, so it's logged server-side and answered with a generic 500
// instead of leaking internals to the browser.
function errorHandler(err, req, res, next) {
  if (err instanceof GatewayError) {
    if (err.status === 401) {
      Session.clearToken(res);
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(err.status).render('error', { status: err.status, message: err.message });
  }
  console.error(err);
  res.status(500).render('error', { status: 500, message: 'Something went wrong.' });
}

module.exports = errorHandler;
