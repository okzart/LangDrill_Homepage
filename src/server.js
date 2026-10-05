// Loads variables from .env into process.env (PORT, GATEWAY_URL, COOKIE_SECRET)
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const GatewayClient = require('./services/gatewayClient');
const currentUser = require('./middleware/currentUser');
const i18n = require('./i18n');
const errorHandler = require('./middleware/errorHandler');
const AuthRoutes = require('./routes/authRoutes');
const DashboardRoutes = require('./routes/dashboardRoutes');
const ProgressRoutes = require('./routes/progressRoutes');
const CommunityRoutes = require('./routes/communityRoutes');
const AdminRoutes = require('./routes/adminRoutes');
const ChatRoutes = require('./routes/chatRoutes');
const PassagesRoutes = require('./routes/passagesRoutes');
const ListeningRoutes = require('./routes/listeningRoutes');
const StudioRoutes = require('./routes/studioRoutes');
const ScanRoutes = require('./routes/scanRoutes');

// Fail fast: without COOKIE_SECRET the session cookie can't be signed, so
// every login would be silently unverifiable (see middleware/session.js).
if (!process.env.COOKIE_SECRET) {
  console.error('COOKIE_SECRET is not set. Copy .env.example to .env and set a secret.');
  process.exit(1);
}

// This app is a CLIENT of the API Gateway, never of a backend service
// directly - one GatewayClient instance, injected into every route class
// (see docs/DESIGN.md §1), same dependency-injection shape the sibling
// services use for their DAOs.
const gatewayClient = new GatewayClient(process.env.GATEWAY_URL || 'http://localhost:8080');

const authRoutes = new AuthRoutes(gatewayClient);
const dashboardRoutes = new DashboardRoutes(gatewayClient);
const progressRoutes = new ProgressRoutes(gatewayClient);
const communityRoutes = new CommunityRoutes(gatewayClient);
const adminRoutes = new AdminRoutes(gatewayClient);
const chatRoutes = new ChatRoutes(gatewayClient);
const passagesRoutes = new PassagesRoutes(gatewayClient);
const listeningRoutes = new ListeningRoutes(gatewayClient);
const studioRoutes = new StudioRoutes(gatewayClient);
const scanRoutes = new ScanRoutes(gatewayClient);

const app = express();
// Parses JSON bodies (unused by this app's own forms, kept for parity/
// future API-style endpoints) and classic HTML form submissions.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));

app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'pug');

// Runs before every route - decodes the session cookie (if any) into
// req.auth / res.locals.currentUser (see middleware/currentUser.js).
app.use(currentUser);
// UI language (EN/KO): res.locals.t / lang for views, req.t for routes.
app.use(i18n.middleware);
app.get('/lang/:code', i18n.switchRoute);

app.use(authRoutes.router);
app.use(dashboardRoutes.router);
app.use(progressRoutes.router);
app.use(communityRoutes.router);
app.use(adminRoutes.router);
app.use(chatRoutes.router);
app.use(passagesRoutes.router);
app.use(listeningRoutes.router);
app.use(studioRoutes.router);
app.use(scanRoutes.router);

// Simple liveness check, useful for uptime monitors / load balancers
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Anything no route matched: the styled error page instead of Express's
// plain "Cannot GET /x".
app.use((req, res) => res.status(404).render('error', { status: 404, message: `There's no page at ${req.path}.` }));

// Must be registered after every route - Express recognizes error-handling
// middleware by its 4-argument signature and only invokes it when
// something upstream called next(err), which every route here does via
// AsyncHandler.wrap (see middleware/asyncHandler.js and middleware/errorHandler.js).
app.use(errorHandler);

const PORT = process.env.PORT || 3004;

app.listen(PORT, () => {
  console.log(`Homepage server listening on http://localhost:${PORT}`);
});
