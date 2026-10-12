const test = require('node:test');
const assert = require('node:assert/strict');
const SignalingClient = require('../src/public/call/signalingClient');
const { Protocol, fakeTimers } = require('./callMocks');

class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; this.closedWith = null; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code) { this.closedWith = code; }
  // What the browser would do:
  opens() { this.onopen(); }
  receives(message) { this.onmessage({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
  drops(code = 1006) { this.onclose({ code }); }
}

function make() {
  const timers = fakeTimers();
  const sockets = [];
  const client = new SignalingClient({
    url: 'wss://site.test/call/ws',
    protocol: Protocol,
    createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => 0.5, // no jitter
  });
  const states = [];
  client.on('state', (state) => states.push(state));
  return { client, timers, sockets, states, socket: () => sockets.at(-1) };
}

const invite = { callId: 'call-12345', to: 'user-b', payload: { mode: 'call' } };

test('connects, sends valid messages and refuses invalid ones', () => {
  const s = make();
  s.client.connect();
  s.client.connect(); // twice is once
  assert.equal(s.sockets.length, 1);
  assert.equal(s.socket().url, 'wss://site.test/call/ws');
  s.socket().opens();
  assert.deepEqual(s.states, ['connecting', 'open']);

  assert.equal(s.client.send('call.invite', invite), true);
  assert.deepEqual(s.socket().sent, [{ type: 'call.invite', callId: 'call-12345', to: 'user-b', payload: { mode: 'call' } }]);
  const invalid = [];
  s.client.on('invalid', (problem) => invalid.push(problem.type));
  assert.equal(s.client.send('call.invite', { callId: 'call-12345', to: 'user-b', payload: { mode: 'hologram' } }), false);
  assert.equal(s.client.send('error', { payload: { code: 'x', message: 'y' } }), false); // server-only
  assert.equal(s.socket().sent.length, 1);
  assert.deepEqual(invalid, ['call.invite', 'error']);
});

test('hands each valid incoming message to its subscribers and drops the rest', () => {
  const s = make();
  const got = [];
  const handler = (message) => got.push(message);
  s.client.on('call.invite', handler);
  s.client.on('message', (message) => got.push(`any:${message.type}`));
  s.client.connect();
  s.socket().opens();
  s.socket().receives({ type: 'call.invite', callId: 'call-12345', from: 'user-a', to: 'me', ts: 7, payload: { mode: 'stream', fromEmail: 'a@example.com' } });
  s.socket().receives('not json');
  s.socket().receives({ type: 'made.up', payload: {} });
  s.socket().receives({ type: 'sdp.offer', callId: 'call-12345', to: 'me', payload: {} }); // no sdp
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { type: 'call.invite', callId: 'call-12345', from: 'user-a', to: 'me', ts: 7, payload: { mode: 'stream', fromEmail: 'a@example.com' } });
  assert.equal(got[1], 'any:call.invite');
  s.client.off('call.invite', handler);
  s.socket().receives({ type: 'call.invite', callId: 'call-12345', from: 'user-a', to: 'me', payload: { mode: 'call' } });
  assert.equal(got.length, 3); // only the catch-all heard it
});

test('reconnects with growing pauses and starts over after a success', async () => {
  const s = make();
  let unreachable = 0;
  s.client.on('unreachable', () => { unreachable += 1; });
  s.client.connect();
  s.socket().opens();
  s.socket().drops();
  assert.equal(s.client.state, 'closed');
  for (const pause of [500, 1000, 2000, 4000, 8000, 15000, 15000]) {
    const before = s.sockets.length;
    await s.timers.advance(pause - 1);
    assert.equal(s.sockets.length, before, `still waiting before ${pause} ms`);
    await s.timers.advance(1);
    assert.equal(s.sockets.length, before + 1, `retried after ${pause} ms`);
    s.socket().drops(); // and fails again
  }
  assert.equal(unreachable, 1); // said once, after the third failure
  await s.timers.advance(15000);
  s.socket().opens();
  s.socket().drops();
  const before = s.sockets.length;
  await s.timers.advance(500); // back to the shortest pause
  assert.equal(s.sockets.length, before + 1);
});

test('while disconnected, call messages wait; on reconnect presence is re-asked and "reconnected" comes before the backlog', async () => {
  const s = make();
  const order = [];
  s.client.on('reconnected', () => {
    order.push('reconnected');
    s.client.send('call.resume', { callId: 'call-12345', to: 'user-b', payload: {} });
  });
  s.client.connect();
  s.socket().opens();
  s.client.send('presence.query', { payload: { email: 'Bob@Example.com' } });
  s.socket().drops();
  s.client.send('ice.candidate', { callId: 'call-12345', to: 'user-b', payload: { candidate: 'candidate:1' } });
  s.client.send('presence.query', { payload: { email: 'carol@example.com' } }); // remembered, not queued
  await s.timers.advance(500);
  assert.equal(s.socket().sent.length, 0); // nothing until it is open
  s.socket().opens();
  assert.deepEqual(order, ['reconnected']);
  assert.deepEqual(s.socket().sent.map((m) => m.type), ['presence.query', 'presence.query', 'call.resume', 'ice.candidate']);
  assert.deepEqual(s.socket().sent.slice(0, 2).map((m) => m.payload.email), ['bob@example.com', 'carol@example.com']);
});

test('reconnectNow skips the pause; close stops for good; an expired login stops retrying', async () => {
  const s = make();
  s.client.connect();
  s.socket().opens();
  s.socket().drops();
  s.client.reconnectNow();
  assert.equal(s.sockets.length, 2);
  s.socket().opens();
  s.client.close();
  assert.equal(s.socket().closedWith, 1000);
  assert.equal(s.client.state, 'closed');
  await s.timers.advance(60000);
  assert.equal(s.sockets.length, 2);
  assert.equal(s.timers.pending(), 0);

  const expired = make();
  let unauthorized = 0;
  expired.client.on('unauthorized', () => { unauthorized += 1; });
  expired.client.connect();
  expired.socket().opens();
  expired.socket().drops(4401);
  await expired.timers.advance(60000);
  assert.equal(expired.sockets.length, 1);
  assert.equal(unauthorized, 1);
});
