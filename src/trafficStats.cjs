// Traffic statistics for one Node service - the same file in the API gateway
// (canonical copy: LanguageDrill_APIGateway/src/trafficStats.cjs) and in every
// microservice, kept identical by scripts/sync-traffic-stats.sh. No
// dependencies, CommonJS (.cjs) so both CommonJS and ES-module services can
// load it. Homepage's admin Traffic page shows it, for each service, through
// the gateway's GET /admin/services.
//
// What is recorded: every request when its response finishes - the route it
// matched (a pattern such as "/sets/:id", or for the gateway the configured
// route prefix - never the full URL, the query or who sent it), the method,
// the status, how long it took and how many bytes went in and out; open
// WebSockets. Plus the process itself: CPU, memory and event-loop delay.
// Nothing is written anywhere: the numbers start over when the process
// restarts, and memory stays fixed - a ring of one-second buckets for the
// last hour, one of one-minute buckets for the last day, and per-route
// totals with the last LATENCY_SAMPLES durations for percentiles.
//
// It must never slow down or break the traffic it watches: per request it
// only reads a clock and the socket's byte counters and adds to a few
// numbers, after the response has finished; it never touches a body, a
// stream or a WebSocket message. Any error while recording is swallowed. The
// heavier work - building a snapshot - happens only when someone asks, at
// most once a second per time range (cached). TRAFFIC_STATS=off turns it off.
//
// Bytes are measured on the connection, not by reading the body (bodies are
// streamed): what the socket read and wrote since the previous request on it
// finished - headers included. Keep-alive connections carry one request at a
// time, so each request gets its own share.
//
// Using it:
//   const { TrafficMonitor } = require('./trafficStats.cjs');
//   const traffic = new TrafficMonitor('content-sharing');
//   app.use(traffic.express());                        // Express: before the routes
//   app.get('/internal/traffic', traffic.expressHandler());
//   traffic.fastify(app);                              // Fastify: hook + GET /internal/traffic
// GET /internal/traffic?window=5m|1h|24h answers the snapshot. It is meant for
// the gateway only: the gateway never proxies an /internal/ path, the
// services listen on internal addresses, and when STATS_TOKEN is set the
// request must carry it as X-Stats-Token.

const { monitorEventLoopDelay } = require('perf_hooks');

const SECOND_BUCKETS = 3600;
const MINUTE_BUCKETS = 1440;
const LATENCY_SAMPLES = 500;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'];

// The charts' time windows: how far back, and how wide each point is.
const WINDOWS = {
  '5m': { span: 5 * 60, step: 5 },
  '1h': { span: 60 * 60, step: 60 },
  '24h': { span: 24 * 60 * 60, step: 15 * 60 },
};

function emptyBucket(at) {
  return { at, count: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, ms: 0, bytesIn: 0, bytesOut: 0 };
}

// What `socket` read and wrote since this was last asked about it.
function socketDelta(socket) {
  if (!socket) return { bytesIn: 0, bytesOut: 0 };
  const read = socket.bytesRead || 0;
  const written = socket.bytesWritten || 0;
  const delta = { bytesIn: read - (socket.ldTrafficRead || 0), bytesOut: written - (socket.ldTrafficWritten || 0) };
  socket.ldTrafficRead = read;
  socket.ldTrafficWritten = written;
  return delta;
}

function statusClass(status) {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

// Fixed-size ring of time buckets, `width` seconds each.
class Ring {
  constructor(size, width) {
    this.size = size;
    this.width = width;
    this.buckets = new Array(size).fill(null);
  }

  bucket(nowSec) {
    const at = Math.floor(nowSec / this.width) * this.width;
    const i = Math.floor(at / this.width) % this.size;
    if (!this.buckets[i] || this.buckets[i].at !== at) this.buckets[i] = emptyBucket(at);
    return this.buckets[i];
  }

  // The buckets from `from` (seconds) to now, oldest first; gaps as empty buckets.
  since(fromSec, nowSec) {
    const out = [];
    const last = Math.floor(nowSec / this.width) * this.width;
    for (let at = Math.floor(fromSec / this.width) * this.width; at <= last; at += this.width) {
      const b = this.buckets[Math.floor(at / this.width) % this.size];
      out.push(b && b.at === at ? b : emptyBucket(at));
    }
    return out;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

class TrafficMonitor {
  // `name`: the service, as the Traffic page shows it.
  constructor(name = 'service', now = () => Date.now()) {
    this.name = name;
    this.now = now;
    this.enabled = process.env.TRAFFIC_STATS !== 'off';
    this.cpu = { at: process.hrtime.bigint(), usage: process.cpuUsage() };
    try {
      this.loopDelayResolutionMs = 20;
      this.loopDelay = monitorEventLoopDelay({ resolution: this.loopDelayResolutionMs });
      this.loopDelay.enable();
      // Not kept alive by the histogram's timer.
      if (this.loopDelay.unref) this.loopDelay.unref();
    } catch {
      this.loopDelay = null;
    }
    this.startedAt = now();
    this.seconds = new Ring(SECOND_BUCKETS, 1);
    this.minutes = new Ring(MINUTE_BUCKETS, 60);
    this.routes = new Map();
    this.inFlight = 0;
    this.websockets = 0;
    this.websocketsTotal = 0;
  }

  route(key) {
    if (!this.routes.has(key)) {
      this.routes.set(key, { route: key, count: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, ms: 0, maxMs: 0, bytesIn: 0, bytesOut: 0, samples: [], next: 0, methods: {} });
    }
    return this.routes.get(key);
  }

  // Node http middleware: counts the request in flight, and records it when
  // the response is done (or the client went away). `routeOf(req)` names the
  // route the request matched - or returns a function naming it when the
  // response is done - or null for one to leave out.
  middleware(routeOf) {
    return (request, response, next) => {
      const key = routeOf(request);
      if (!key) {
        // Left out of the statistics: its bytes are passed over, so the next
        // request on this connection is measured from where this one ended.
        response.on('finish', () => {
          try {
            socketDelta(request.socket);
          } catch (error) {
            TrafficMonitor.warn(error);
          }
        });
        return next();
      }
      const started = process.hrtime.bigint();
      this.inFlight++;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.inFlight--;
        try {
          // A response closed before it was sent (the client left) counts as 499.
          const status = response.writableFinished ? response.statusCode : 499;
          const route = typeof key === 'function' ? key() : key;
          this.record(route, request.method, status, Number(process.hrtime.bigint() - started) / 1e6, socketDelta(request.socket));
        } catch (error) {
          TrafficMonitor.warn(error);
        }
      };
      response.on('finish', finish);
      response.on('close', finish);
      next();
    };
  }

  record(key, method, status, ms, bytes = { bytesIn: 0, bytesOut: 0 }) {
    const cls = statusClass(status);
    const nowSec = this.now() / 1000;
    for (const b of [this.seconds.bucket(nowSec), this.minutes.bucket(nowSec)]) {
      b.count++;
      b[cls]++;
      b.ms += ms;
      b.bytesIn += bytes.bytesIn;
      b.bytesOut += bytes.bytesOut;
    }
    const r = this.route(key);
    r.count++;
    r[cls]++;
    r.ms += ms;
    r.bytesIn += bytes.bytesIn;
    r.bytesOut += bytes.bytesOut;
    r.maxMs = Math.max(r.maxMs, ms);
    r.methods[method] = (r.methods[method] || 0) + 1;
    if (r.samples.length < LATENCY_SAMPLES) r.samples.push(ms);
    else r.samples[r.next] = ms;
    r.next = (r.next + 1) % LATENCY_SAMPLES;
  }

  // A WebSocket opened on `socket` for route `key`; returns the function to
  // call when it closes, which adds the bytes it carried (the handshake
  // included) to that moment's traffic and to the route.
  websocketOpened(socket, key) {
    this.websockets++;
    this.websocketsTotal++;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.websockets--;
      try {
        this.websocketClosed(socket, key);
      } catch (error) {
        TrafficMonitor.warn(error);
      }
    };
  }

  websocketClosed(socket, key) {
    const bytes = socketDelta(socket);
    const nowSec = this.now() / 1000;
    for (const b of [this.seconds.bucket(nowSec), this.minutes.bucket(nowSec)]) {
      b.bytesIn += bytes.bytesIn;
      b.bytesOut += bytes.bytesOut;
    }
    if (key) {
      const r = this.route(key);
      r.bytesIn += bytes.bytesIn;
      r.bytesOut += bytes.bytesOut;
    }
  }

  // Express (or plain Node http) middleware, registered before the routes.
  // A request is filed under the pattern of the route that answered it
  // ("/sets/:id"), taken at the moment Express picks that route - while
  // `baseUrl` still holds the routers' mount paths, which Express clears
  // again on the way out. Anything no route took (static files, 404s) is
  // "(other)". /health and /internal/* are left out.
  express() {
    if (!this.enabled) return (req, res, next) => next();
    return this.middleware((request) => {
      const path = (request.originalUrl || request.url || '').split('?')[0];
      if (path === '/health' || path.startsWith('/internal/')) return null;
      let route = null;
      let pattern = null;
      Object.defineProperty(request, 'route', {
        configurable: true,
        enumerable: true,
        get: () => route,
        set: (value) => {
          route = value;
          if (value && typeof value.path === 'string') pattern = `${request.baseUrl || ''}${value.path}`;
        },
      });
      return () => pattern || '(other)';
    });
  }

  // Express handler for GET /internal/traffic - that exact path only (Express
  // would also match "/Internal/traffic" and the like).
  expressHandler() {
    return (req, res, next) => {
      if (req.path !== '/internal/traffic') return next();
      const answer = this.answer(req.headers, req.query && req.query.window);
      res.status(answer.status).type('application/json').send(answer.body);
    };
  }

  // Fastify: a hook that records every request under its route pattern, and
  // the GET /internal/traffic route. Call before the other routes.
  fastify(app) {
    if (this.enabled) {
      const record = this.middleware((request) => {
        const path = (request.url || '').split('?')[0];
        if (path === '/health' || path.startsWith('/internal/')) return null;
        return () => request.ldRoute || '(other)';
      });
      app.addHook('onRequest', (request, reply, done) => {
        request.raw.ldRoute = (request.routeOptions && request.routeOptions.url) || request.routerPath || null;
        record(request.raw, reply.raw, done);
      });
    }
    app.get('/internal/traffic', async (request, reply) => {
      const answer = this.answer(request.headers, request.query && request.query.window);
      reply.code(answer.status).type('application/json');
      return answer.body;
    });
  }

  // The answer to GET /internal/traffic: { status, body (a JSON string) }.
  answer(headers, windowKey) {
    const token = process.env.STATS_TOKEN;
    if (token && headers['x-stats-token'] !== token) return { status: 403, body: JSON.stringify({ error: 'Wrong or missing X-Stats-Token' }) };
    if (!this.enabled) return { status: 404, body: JSON.stringify({ error: 'Traffic statistics are turned off (TRAFFIC_STATS=off)' }) };
    return { status: 200, body: this.snapshotJson(windowKey) };
  }

  // The process: CPU use since the previous call (% of one core), memory,
  // event-loop delay (p50 / p99 / max ms since the previous call - how long
  // work waited for the process), uptime, Node version.
  processStats() {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage();
    const wallUs = Number(now - this.cpu.at) / 1000;
    const cpuUs = (usage.user - this.cpu.usage.user) + (usage.system - this.cpu.usage.system);
    this.cpu = { at: now, usage };
    const mem = process.memoryUsage();
    const out = {
      cpuPercent: wallUs > 0 ? Math.round((cpuUs / wallUs) * 1000) / 10 : 0,
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      loopDelayMs: null,
    };
    if (this.loopDelay && this.loopDelay.count > 0) {
      // The histogram's samples include the sampling interval itself; what
      // is left is the time work actually waited.
      const ms = (ns) => Math.max(0, Math.round((ns / 1e6 - this.loopDelayResolutionMs) * 100) / 100);
      out.loopDelayMs = { p50: ms(this.loopDelay.percentile(50)), p99: ms(this.loopDelay.percentile(99)), max: ms(this.loopDelay.max) };
      this.loopDelay.reset();
    }
    return out;
  }

  // A failure in the statistics is logged (once a minute at most), never
  // passed on to the request it was recording.
  static warn(error) {
    const now = Date.now();
    if (now - (TrafficMonitor.lastWarning || 0) < 60 * 1000) return;
    TrafficMonitor.lastWarning = now;
    console.warn(`traffic statistics: ${error?.message || error}`);
  }

  // #build, cached for a second per time range: several admins watching, or
  // a fast poll, cost the gateway one build a second at most.
  snapshot(windowKey = '5m') {
    const key = WINDOWS[windowKey] ? windowKey : '5m';
    const now = this.now();
    this.cache = this.cache || {};
    const hit = this.cache[key];
    if (hit && now - hit.now < 1000) return hit;
    return (this.cache[key] = this.build(key));
  }

  // The snapshot as the JSON body GET /admin/traffic sends, cached with it
  // (`extra` is added once per build), so a poll costs no encoding either.
  snapshotJson(windowKey = '5m', extra = {}) {
    const snap = this.snapshot(windowKey);
    if (!snap.json) Object.defineProperty(snap, 'json', { value: JSON.stringify({ service: this.name, ...snap, process: this.processStats(), ...extra }) });
    return snap.json;
  }

  // Everything the Traffic page needs, for one of WINDOWS:
  // { startedAt, now, window, step, inFlight, websockets, websocketsTotal,
  //   totals, series: [{ at, count, 2xx..5xx, avgMs }], routes: [...] }.
  build(windowKey) {
    const win = WINDOWS[windowKey] || WINDOWS['5m'];
    const now = this.now();
    const nowSec = now / 1000;
    const from = nowSec - win.span + win.step;
    const source = win.span <= SECOND_BUCKETS ? this.seconds : this.minutes;
    const raw = source.since(Math.max(from, nowSec - source.size * source.width + source.width), nowSec);
    // Regroup the raw buckets into points `step` seconds wide.
    const points = new Map();
    const first = Math.floor(from / win.step) * win.step;
    for (let at = first; at <= nowSec; at += win.step) points.set(at, emptyBucket(at));
    for (const b of raw) {
      const at = Math.floor(b.at / win.step) * win.step;
      const p = points.get(at);
      if (!p) continue;
      p.count += b.count;
      for (const c of STATUS_CLASSES) p[c] += b[c];
      p.ms += b.ms;
      p.bytesIn += b.bytesIn;
      p.bytesOut += b.bytesOut;
    }
    const series = [...points.values()].map((p) => ({
      at: p.at * 1000,
      count: p.count,
      '2xx': p['2xx'],
      '3xx': p['3xx'],
      '4xx': p['4xx'],
      '5xx': p['5xx'],
      avgMs: p.count ? Math.round((p.ms / p.count) * 10) / 10 : null,
      bytesIn: p.bytesIn,
      bytesOut: p.bytesOut,
    }));
    const routes = [...this.routes.values()].map((r) => {
      const sorted = [...r.samples].sort((a, b) => a - b);
      return {
        route: r.route,
        count: r.count,
        '2xx': r['2xx'],
        '3xx': r['3xx'],
        '4xx': r['4xx'],
        '5xx': r['5xx'],
        avgMs: r.count ? Math.round((r.ms / r.count) * 10) / 10 : 0,
        p95Ms: Math.round(percentile(sorted, 95) * 10) / 10,
        maxMs: Math.round(r.maxMs * 10) / 10,
        bytesIn: r.bytesIn,
        bytesOut: r.bytesOut,
        methods: r.methods,
      };
    }).sort((a, b) => b.count - a.count);
    const totals = routes.reduce((t, r) => {
      t.count += r.count;
      for (const c of STATUS_CLASSES) t[c] += r[c];
      t.bytesIn += r.bytesIn;
      t.bytesOut += r.bytesOut;
      return t;
    }, { count: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, bytesIn: 0, bytesOut: 0 });
    // Requests per second over the last minute, and its average latency.
    const lastMinute = this.seconds.since(nowSec - 59, nowSec);
    const minuteCount = lastMinute.reduce((n, b) => n + b.count, 0);
    const minuteMs = lastMinute.reduce((n, b) => n + b.ms, 0);
    return {
      startedAt: this.startedAt,
      now,
      window: WINDOWS[windowKey] ? windowKey : '5m',
      step: win.step,
      inFlight: this.inFlight,
      websockets: this.websockets,
      websocketsTotal: this.websocketsTotal,
      lastMinute: {
        count: minuteCount,
        perSecond: Math.round((minuteCount / 60) * 100) / 100,
        avgMs: minuteCount ? Math.round((minuteMs / minuteCount) * 10) / 10 : null,
        errors: lastMinute.reduce((n, b) => n + b['5xx'], 0),
        bytesIn: lastMinute.reduce((n, b) => n + b.bytesIn, 0),
        bytesOut: lastMinute.reduce((n, b) => n + b.bytesOut, 0),
      },
      totals,
      series,
      routes,
    };
  }
}

module.exports = { TrafficMonitor, WINDOWS };
