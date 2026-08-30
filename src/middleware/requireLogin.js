// Gates every feature page behind having a valid session (see
// currentUser.js, which must run first - mounted app-wide in server.js).
// Redirects to /login?next=<original path> rather than answering 401,
// since these are pages a person navigates to in a browser, not an API a
// program calls.
function requireLogin(req, res, next) {
  if (!req.auth) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Must run after requireLogin. Only gates the /admin/* pages - see
// docs/DESIGN.md §4.
function requireAdmin(req, res, next) {
  if (req.auth?.user?.role !== 'admin') {
    return res.status(403).render('error', {
      status: 403,
      message: 'Admin privileges required.',
    });
  }
  next();
}

module.exports = { requireLogin, requireAdmin };
