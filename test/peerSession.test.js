const test = require('node:test');
const assert = require('node:assert/strict');
const PeerSession = require('../src/public/call/peerSession');
const { fakeTimers, settle, fakeSignaling, fakeStream, fakeGetUserMedia, FakePeerConnection } = require('./callMocks');

// A session wired to fakes; → { session, signaling, timers, pc(), states, notices, gum }.
function make(options = {}) {
  const signaling = fakeSignaling();
  const timers = fakeTimers();
  const gum = options.getUserMedia === undefined ? fakeGetUserMedia(undefined) : options.getUserMedia;
  let pc = null;
  const session = new PeerSession({
    signaling,
    callId: 'call-12345',
    peerId: 'peer',
    mode: options.mode || 'call',
    role: options.role || 'caller',
    fetchIceConfig: options.fetchIceConfig || (async () => ({ iceServers: [{ urls: ['stun:stun.test:3478'] }], turn: !!options.turn })),
    createPeerConnection: (config) => { pc = new FakePeerConnection(config); return pc; },
    getUserMedia: gum,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const states = [];
  const notices = [];
  session.on('state', (state, detail) => states.push(detail ? `${state}:${detail}` : state));
  session.on('notice', (notice) => notices.push(notice.code));
  return { session, signaling, timers, pc: () => pc, states, notices, gum };
}

// Caller and callee both started, offer answered, media connected.
async function connected(options = {}) {
  const s = make(options);
  await s.session.start();
  if ((options.role || 'caller') === 'caller') s.signaling.deliver('sdp.answer', { sdp: 'their-answer' });
  else s.signaling.deliver('sdp.offer', { sdp: 'their-offer' });
  await settle();
  s.pc().becomes('connected');
  return s;
}

test('caller, two-way call: sends camera and mic, offers, takes the answer, connects', async () => {
  const s = make();
  let preview = null;
  s.session.on('localstream', (stream) => { preview = stream; });
  await s.session.start();
  assert.deepEqual(s.gum.calls, [{ audio: true, video: true }]);
  assert.deepEqual(s.pc().config, { iceServers: [{ urls: ['stun:stun.test:3478'] }] });
  assert.deepEqual(s.pc().getTransceivers().map((t) => [t.sender.track.kind, t.direction]), [['audio', 'sendrecv'], ['video', 'sendrecv']]);
  assert.equal(preview.getTracks().length, 2);
  const offer = s.signaling.last('sdp.offer');
  assert.deepEqual({ callId: offer.callId, to: offer.to }, { callId: 'call-12345', to: 'peer' });
  assert.equal(offer.payload.sdp, s.pc().localDescription.sdp);
  assert.equal(offer.payload.mode, undefined);

  // Candidates that arrive before the answer wait for it.
  s.signaling.deliver('ice.candidate', { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  await settle();
  assert.equal(s.pc().added.length, 0);
  s.signaling.deliver('sdp.answer', { sdp: 'their-answer' });
  await settle();
  assert.equal(s.pc().remoteDescription.sdp, 'their-answer');
  assert.deepEqual(s.pc().added, [{ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }]);
  s.signaling.deliver('ice.candidate', { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 });
  s.signaling.deliver('ice.candidate', { candidate: '', sdpMid: null, sdpMLineIndex: null }); // end marker
  await settle();
  assert.equal(s.pc().added.length, 2);

  let remote = null;
  s.session.on('remotestream', (stream) => { remote = stream; });
  const theirs = fakeStream();
  s.pc().ontrack({ streams: [theirs] });
  assert.equal(remote, theirs);
  s.pc().becomes('connected');
  assert.deepEqual(s.states, ['starting', 'connecting', 'connected']);
  assert.equal(s.timers.pending(), 0); // the setup timer is gone
});

test('trickle ICE: each local candidate is sent as it is found', async () => {
  const s = await connected();
  s.pc().onicecandidate({ candidate: { candidate: 'candidate:9 1 udp', sdpMid: '0', sdpMLineIndex: 0 } });
  s.pc().onicecandidate({ candidate: null }); // gathering finished
  assert.deepEqual(s.signaling.sent.filter((m) => m.type === 'ice.candidate').map((m) => m.payload), [{ candidate: 'candidate:9 1 udp', sdpMid: '0', sdpMLineIndex: 0 }]);
});

test('one-way stream: the caller only sends, the viewer only receives and needs no camera', async () => {
  const streamer = make({ mode: 'stream', role: 'caller' });
  await streamer.session.start();
  assert.deepEqual(streamer.pc().getTransceivers().map((t) => t.direction), ['sendonly', 'sendonly']);
  assert.equal(streamer.session.sendsMedia(), true);

  const viewer = make({ mode: 'stream', role: 'callee' });
  await viewer.session.start();
  assert.equal(viewer.gum.calls.length, 0); // never asked for the camera
  assert.equal(viewer.signaling.sent.length, 0); // and waits for the offer
  viewer.signaling.deliver('sdp.offer', { sdp: 'stream-offer' });
  await settle();
  assert.deepEqual(viewer.pc().getTransceivers().map((t) => [t.direction, t.sender.track]), [['recvonly', null], ['recvonly', null]]);
  assert.equal(viewer.signaling.last('sdp.answer').payload.sdp, viewer.pc().localDescription.sdp);
  assert.equal(viewer.session.setMicEnabled(false), false); // nothing to mute
});

test('callee: an offer that beats the camera permission prompt is answered once media is ready', async () => {
  let allow;
  const gum = () => new Promise((resolve) => { allow = () => resolve(fakeStream()); });
  const s = make({ role: 'callee', getUserMedia: gum });
  const started = s.session.start();
  await settle();
  s.signaling.deliver('sdp.offer', { sdp: 'early-offer' });
  s.signaling.deliver('ice.candidate', { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 });
  await settle();
  assert.equal(s.pc(), null); // still waiting for the user
  allow();
  await started;
  await settle();
  assert.equal(s.pc().remoteDescription.sdp, 'early-offer');
  assert.equal(s.pc().added.length, 1);
  assert.deepEqual(s.pc().getTransceivers().map((t) => t.direction), ['sendrecv', 'sendrecv']);
  assert.ok(s.signaling.last('sdp.answer'));
});

test('a dropped connection: waits a moment, then restarts ICE, and recovers', async () => {
  const s = await connected();
  s.pc().becomes('disconnected');
  assert.equal(s.session.state, 'reconnecting');
  await s.timers.advance(PeerSession.DISCONNECT_GRACE_MS - 1);
  assert.equal(s.signaling.last('ice.restart'), undefined); // might still heal by itself
  await s.timers.advance(1);
  assert.deepEqual(s.pc().offerOptions.at(-1), { iceRestart: true });
  assert.equal(s.signaling.last('ice.restart').payload.sdp, s.pc().localDescription.sdp);
  s.signaling.deliver('sdp.answer', { sdp: 'restart-answer' });
  await settle();
  s.pc().becomes('connected');
  assert.equal(s.session.state, 'connected');
  assert.equal(s.session.restarts, 0);
  assert.equal(s.timers.pending(), 0);

  // A blip that heals within the grace period restarts nothing.
  const before = s.signaling.sent.length;
  s.pc().becomes('disconnected');
  await s.timers.advance(1000);
  s.pc().becomes('connected');
  await s.timers.advance(60000);
  assert.equal(s.signaling.sent.length, before);
});

test('a connection that cannot be restored fails, saying whether a TURN relay was missing', async () => {
  for (const [turn, code] of [[false, 'connection_failed_no_turn'], [true, 'connection_failed']]) {
    const s = await connected({ turn });
    s.pc().becomes('failed'); // restart 1, at once
    await settle();
    for (let i = 0; i < PeerSession.MAX_RESTARTS; i++) {
      s.signaling.deliver('sdp.answer', { sdp: 'answer' }); // the peer answers, but media never comes back
      await settle();
      await s.timers.advance(PeerSession.RESTART_TIMEOUT_MS);
    }
    assert.equal(s.signaling.sent.filter((m) => m.type === 'ice.restart').length, PeerSession.MAX_RESTARTS);
    assert.equal(s.states.at(-1), `failed:${code}`);
    assert.deepEqual(s.signaling.last('call.end').payload, { reason: code });
    assert.equal(s.pc().closed, true);
  }
});

test('never connecting at all fails after the setup timeout', async () => {
  const s = make();
  await s.session.start();
  s.signaling.deliver('sdp.answer', { sdp: 'answer' });
  await s.timers.advance(PeerSession.SETUP_TIMEOUT_MS);
  assert.equal(s.states.at(-1), 'failed:connection_failed_no_turn');
});

test('a network change restarts ICE at once; an ICE restart from the peer is answered', async () => {
  const s = await connected();
  s.session.networkChanged();
  await settle();
  assert.ok(s.signaling.last('ice.restart'));
  assert.equal(s.session.state, 'reconnecting');
  s.signaling.deliver('sdp.answer', { sdp: 'answer' });
  await settle();
  s.pc().becomes('connected');

  const callee = await connected({ role: 'callee' });
  callee.signaling.deliver('ice.restart', { sdp: 'their-restart-offer' });
  await settle();
  assert.equal(callee.pc().remoteDescription.sdp, 'their-restart-offer');
  assert.equal(callee.signaling.sent.filter((m) => m.type === 'sdp.answer').length, 2);
});

test('both sides offering at once: the caller keeps its offer, the callee backs off and answers', async () => {
  const caller = await connected();
  caller.session.networkChanged(); // caller's restart offer is out...
  await settle();
  caller.signaling.deliver('ice.restart', { sdp: 'callee-restart' }); // ...when the callee's arrives
  await settle();
  assert.equal(caller.pc().signalingState, 'have-local-offer'); // unchanged, still waiting for the answer
  assert.equal(caller.signaling.sent.filter((m) => m.type === 'sdp.answer').length, 0);

  const callee = await connected({ role: 'callee' });
  callee.session.networkChanged();
  await settle();
  assert.equal(callee.pc().signalingState, 'have-local-offer');
  callee.signaling.deliver('ice.restart', { sdp: 'caller-restart' });
  await settle();
  assert.deepEqual(callee.pc().log.slice(-3), ['local:rollback', 'remote:offer', 'local:answer']);
  assert.equal(callee.pc().signalingState, 'stable');
  assert.equal(callee.pc().remoteDescription.sdp, 'caller-restart');
});

test('camera and microphone problems are reported by cause', async () => {
  const cases = [
    [fakeGetUserMedia('NotAllowedError'), 'permission_denied'],
    [fakeGetUserMedia('NotFoundError', 'NotFoundError'), 'no_devices'],
    [fakeGetUserMedia('NotReadableError', 'NotReadableError'), 'device_busy'],
    [fakeGetUserMedia('NotFoundError', 'NotAllowedError'), 'permission_denied'],
    [null, 'insecure_context'], // no mediaDevices: the page isn't on HTTPS
  ];
  for (const [gum, code] of cases) {
    const s = make({ getUserMedia: gum });
    await s.session.start();
    assert.equal(s.states.at(-1), `failed:${code}`, code);
    assert.equal(s.pc(), null);
    assert.deepEqual(s.signaling.last('call.end').payload, { reason: code }); // the other side isn't left waiting
  }
  const noConfig = make({ fetchIceConfig: async () => { throw new Error('502'); } });
  await noConfig.session.start();
  assert.equal(noConfig.states.at(-1), 'failed:ice_config');
  assert.equal(noConfig.gum.calls.length, 0);
});

test('no camera: the call goes ahead with the microphone only', async () => {
  const s = make({ getUserMedia: fakeGetUserMedia('NotFoundError', fakeStream(['audio'])) });
  await s.session.start();
  assert.deepEqual(s.gum.calls, [{ audio: true, video: true }, { audio: true, video: false }]);
  assert.deepEqual(s.notices, ['no_camera']);
  assert.equal(s.session.state, 'connecting');
  assert.equal(s.pc().getTransceivers().length, 1);
  assert.equal(s.session.setCameraEnabled(false), false);
});

test('mute and camera switches act on the local tracks', async () => {
  const s = await connected();
  const [audio, video] = s.session.localStream.getTracks();
  assert.equal(s.session.setMicEnabled(false), true);
  assert.deepEqual([audio.enabled, video.enabled], [false, true]);
  s.session.setCameraEnabled(false);
  s.session.setMicEnabled(true);
  assert.deepEqual([audio.enabled, video.enabled], [true, false]);
});

test('hanging up stops the camera, closes the connection and tells the peer once', async () => {
  const s = await connected();
  const tracks = s.session.localStream.getTracks();
  s.session.end();
  s.session.end();
  assert.equal(s.signaling.sent.filter((m) => m.type === 'call.end').length, 1);
  assert.deepEqual(tracks.map((t) => t.stopped), [true, true]);
  assert.equal(s.pc().closed, true);
  assert.equal(s.states.at(-1), 'ended');
  assert.equal(s.timers.pending(), 0);
  for (const type of ['sdp.offer', 'sdp.answer', 'ice.candidate', 'ice.restart', 'call.end', 'reconnected']) assert.equal(s.signaling.listeners(type), 0, type);
  // Nothing that arrives afterwards does anything.
  s.pc().becomes('failed');
  await s.timers.advance(60000);
  assert.equal(s.states.at(-1), 'ended');
});

test('the peer hanging up ends the session without echoing call.end; other calls are ignored', async () => {
  const s = await connected();
  s.signaling.deliver('call.end', {}, 'another-call-1');
  await settle();
  assert.equal(s.session.state, 'connected');
  s.signaling.deliver('call.end', { reason: 'bye' });
  await settle();
  assert.equal(s.states.at(-1), 'ended:bye');
  assert.equal(s.signaling.last('call.end'), undefined);
  assert.equal(s.session.localStream.getTracks().every((t) => t.stopped), true);
});

test('hanging up during the permission prompt leaves no camera running', async () => {
  let allow;
  const stream = fakeStream();
  const s = make({ getUserMedia: () => new Promise((resolve) => { allow = () => resolve(stream); }) });
  const started = s.session.start();
  await settle();
  s.session.end();
  allow();
  await started;
  assert.equal(stream.getTracks().every((t) => t.stopped), true);
  assert.equal(s.pc(), null);
});

test('stream → call: the streamer asks, and the viewer turns its camera on to answer', async () => {
  const streamer = await connected({ mode: 'stream', role: 'caller' });
  const modes = [];
  streamer.session.on('mode', (mode) => modes.push(mode));
  await streamer.session.upgradeToCall();
  assert.deepEqual(streamer.pc().getTransceivers().map((t) => t.direction), ['sendrecv', 'sendrecv']);
  assert.equal(streamer.signaling.last('sdp.offer').payload.mode, 'call');
  assert.deepEqual(modes, ['call']);
  assert.equal(streamer.gum.calls.length, 1); // it already had its camera
  await streamer.session.upgradeToCall(); // already a call: nothing more
  assert.equal(streamer.signaling.sent.filter((m) => m.type === 'sdp.offer').length, 2);

  const viewer = await connected({ mode: 'stream', role: 'callee' });
  assert.equal(viewer.gum.calls.length, 0);
  viewer.signaling.deliver('sdp.offer', { sdp: 'upgrade-offer', mode: 'call' });
  await settle();
  assert.deepEqual(viewer.gum.calls, [{ audio: true, video: true }]);
  assert.deepEqual(viewer.pc().getTransceivers().map((t) => [t.direction, t.sender.track.kind]), [['sendrecv', 'audio'], ['sendrecv', 'video']]);
  assert.equal(viewer.session.mode, 'call');
  assert.equal(viewer.signaling.sent.filter((m) => m.type === 'sdp.answer').length, 2);
  assert.equal(viewer.session.setMicEnabled(false), true);
});

test('stream → call asked by the viewer; a viewer without a camera stays a viewer', async () => {
  const viewer = await connected({ mode: 'stream', role: 'callee' });
  await viewer.session.upgradeToCall();
  assert.equal(viewer.signaling.last('sdp.offer').payload.mode, 'call');
  assert.deepEqual(viewer.pc().getTransceivers().map((t) => t.sender.track.kind), ['audio', 'video']);

  const blocked = await connected({ mode: 'stream', role: 'callee', getUserMedia: fakeGetUserMedia('NotAllowedError') });
  blocked.signaling.deliver('sdp.offer', { sdp: 'upgrade-offer', mode: 'call' });
  await settle();
  assert.deepEqual(blocked.notices, ['permission_denied']);
  assert.equal(blocked.session.state, 'connected'); // the stream it was watching goes on
  assert.equal(blocked.signaling.sent.filter((m) => m.type === 'sdp.answer').length, 2);
});

test('signaling coming back: the call announces itself, and repairs media only if it suffered', async () => {
  const s = await connected();
  s.signaling.deliver('reconnected');
  await settle();
  assert.deepEqual(s.signaling.sent.slice(-1).map((m) => [m.type, m.callId, m.to]), [['call.resume', 'call-12345', 'peer']]);
  assert.equal(s.signaling.last('ice.restart'), undefined); // media never went through the server

  s.pc().becomes('disconnected');
  s.signaling.deliver('reconnected');
  await settle();
  assert.deepEqual(s.signaling.types().slice(-2), ['call.resume', 'ice.restart']);
});
