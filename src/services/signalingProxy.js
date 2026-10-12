// Carries the video-call signaling WebSocket between the browser and the API
// Gateway (/call/ws here ↔ /api/signaling/ws there).
//
// It exists for the same reason every other gateway call goes through this
// server: the login token lives in an httpOnly cookie the page's script
// can't read, and a browser can't put an Authorization header on a
// WebSocket anyway. So the browser connects here with its cookie, and this
// opens the gateway connection with the token and passes frames through
// untouched - it never looks inside a message. Media is not involved at all:
// that flows directly between the two browsers.
const cookie = require('cookie');
const cookieParser = require('cookie-parser');
const { WebSocket, WebSocketServer } = require('ws');
const { decodeJwtPayload, isExpired } = require('./jwt');

const PATH = '/call/ws';
const COOKIE_NAME = 'ld_token'; // middleware/session.js
const PING_MS = 25 * 1000;
const MAX_QUEUED = 50; // frames from the browser held while the gateway connection opens
const MAX_FRAME_BYTES = 32 * 1024; // the signaling protocol's own limit

// The login token of an upgrade request, or null (no cookie, a tampered or
// an expired one) - what middleware/currentUser.js does for HTTP requests.
function tokenFrom(req, cookieSecret) {
  const signed = cookieParser.signedCookies(cookie.parse(req.headers.cookie || ''), cookieSecret);
  const token = signed[COOKIE_NAME];
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return payload && !isExpired(payload) ? token : null;
}

// A WebSocket handshake carries the cookie whichever site's script opened
// it, so the page must be ours: its Origin has to be this very host - the
// Host header, or what a reverse proxy in front says the browser asked for
// (X-Forwarded-Host; a page's script can't set either on a handshake). A
// proxy that hides both needs PUBLIC_ORIGINS, e.g. "https://drill.example.com".
function sameOrigin(req) {
  let origin;
  try {
    origin = new URL(req.headers.origin);
  } catch {
    return false; // no Origin at all: not a browser page
  }
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (origin.host === req.headers.host || (forwarded && origin.host === forwarded)) return true;
  return String(process.env.PUBLIC_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean).includes(origin.origin);
}

// Codes a server may put in a close frame (1005/1006 etc. are reserved).
function closeCode(code) {
  return code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1011;
}

// Call once with the http.Server (see server.js).
function attachSignalingProxy(server, { gatewayUrl, cookieSecret }) {
  const upstreamUrl = `${gatewayUrl.replace(/^http/, 'ws')}/api/signaling/ws`;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const refuse = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (req.url.split('?')[0] !== PATH) return refuse(404, 'Not Found');
    if (!sameOrigin(req)) return refuse(403, 'Forbidden');
    const token = tokenFrom(req, cookieSecret);
    if (!token) return refuse(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (browser) => bridge(browser, token));
  });

  function bridge(browser, token) {
    const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: `Bearer ${token}` }, maxPayload: MAX_FRAME_BYTES });
    let queued = [];
    let alive = true;

    upstream.on('open', () => {
      for (const data of queued) upstream.send(data);
      queued = null;
    });
    upstream.on('message', (data, isBinary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
    });
    browser.on('message', (data, isBinary) => {
      const frame = isBinary ? data : data.toString('utf8');
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      else if (queued && queued.length < MAX_QUEUED) queued.push(frame);
    });

    // Either side closing closes the other. A gateway that refuses the
    // handshake (401: the token expired meanwhile; 502: signaling is down)
    // shows up as an 'unexpected-response'.
    upstream.on('close', (code, reason) => browser.close(closeCode(code), reason.toString().slice(0, 100)));
    upstream.on('unexpected-response', (request, response) => {
      response.resume();
      browser.close(response.statusCode === 401 ? 4401 : 1013, response.statusCode === 401 ? 'log in again' : 'signaling unavailable');
    });
    upstream.on('error', () => { if (browser.readyState === WebSocket.OPEN) browser.close(1013, 'signaling unavailable'); });
    browser.on('close', () => { clearInterval(ping); upstream.terminate(); });
    browser.on('error', () => browser.terminate());

    // The signaling service's own heartbeat only proves this server is
    // alive, so a browser that vanished (a closed laptop) is noticed here.
    browser.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return browser.terminate();
      alive = false;
      browser.ping();
    }, PING_MS);
    ping.unref?.();
  }

  return wss;
}

module.exports = { attachSignalingProxy, tokenFrom, sameOrigin, closeCode };
