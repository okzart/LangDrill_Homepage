// Stand-ins for the browser pieces PeerSession and SignalingClient are given:
// timers driven by hand, a signaling connection that records what is sent,
// and an RTCPeerConnection that follows the real signaling-state rules.
const path = require('path');

// The protocol the signaling service serves; the same file the browser loads.
const Protocol = require(path.join(__dirname, '..', '..', 'signaling-service', 'src', 'protocol', 'protocol.js'));

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    // Moves time forward, running whatever comes due (in order).
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    pending: () => timers.size,
  };
}

// Lets queued promise callbacks run.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeSignaling() {
  const handlers = {};
  return {
    sent: [],
    on(type, handler) { (handlers[type] = handlers[type] || []).push(handler); },
    off(type, handler) { handlers[type] = (handlers[type] || []).filter((h) => h !== handler); },
    send(type, fields) { this.sent.push({ type, ...fields }); return true; },
    // A message arriving from the other side.
    deliver(type, payload, callId = 'call-12345') { (handlers[type] || []).slice().forEach((h) => h({ type, callId, from: 'peer', payload: payload || {} })); },
    listeners: (type) => (handlers[type] || []).length,
    types() { return this.sent.map((m) => m.type); },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type); },
  };
}

function fakeTrack(kind) {
  return { kind, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

function fakeStream(kinds = ['audio', 'video']) {
  const tracks = kinds.map(fakeTrack);
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

// getUserMedia that answers from a list: a stream, or an error name to throw.
function fakeGetUserMedia(...answers) {
  const calls = [];
  const fn = (constraints) => {
    calls.push(constraints);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof answer === 'string') return Promise.reject(Object.assign(new Error(answer), { name: answer }));
    return Promise.resolve(answer || fakeStream(constraints.video ? ['audio', 'video'] : ['audio']));
  };
  fn.calls = calls;
  return fn;
}

let sdpCounter = 0;
class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.added = []; // remote candidates given to addIceCandidate
    this.offerOptions = [];
    this.closed = false;
    this.log = [];
  }

  addTrack(track) {
    const transceiver = { direction: 'sendrecv', sender: { track, replaceTrack: async (next) => { transceiver.sender.track = next; } }, receiver: { track: { kind: track.kind } } };
    this.transceivers.push(transceiver);
    return transceiver.sender;
  }

  getTransceivers() { return this.transceivers; }

  async createOffer(options) {
    this.offerOptions.push(options);
    return { type: 'offer', sdp: `offer-${++sdpCounter}` };
  }

  async createAnswer() {
    if (this.signalingState !== 'have-remote-offer') throw new Error(`createAnswer in ${this.signalingState}`);
    return { type: 'answer', sdp: `answer-${++sdpCounter}` };
  }

  async setLocalDescription(description) {
    this.log.push(`local:${description.type}`);
    if (description.type === 'rollback') {
      this.signalingState = 'stable';
      this.localDescription = null;
    } else if (description.type === 'offer') {
      this.signalingState = 'have-local-offer';
      this.localDescription = description;
    } else {
      if (this.signalingState !== 'have-remote-offer') throw new Error(`answer in ${this.signalingState}`);
      this.signalingState = 'stable';
      this.localDescription = description;
    }
  }

  async setRemoteDescription(description) {
    this.log.push(`remote:${description.type}`);
    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error(`remote offer in ${this.signalingState}`);
      this.signalingState = 'have-remote-offer';
      // Answering an offer creates receive-only transceivers for what it carries.
      if (this.transceivers.length === 0) {
        for (const kind of ['audio', 'video']) {
          const transceiver = { direction: 'recvonly', sender: { track: null, replaceTrack: async (next) => { transceiver.sender.track = next; } }, receiver: { track: { kind } } };
          this.transceivers.push(transceiver);
        }
      }
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error(`remote answer in ${this.signalingState}`);
      this.signalingState = 'stable';
    }
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error('candidate before remote description');
    this.added.push(candidate);
  }

  close() { this.closed = true; this.signalingState = 'closed'; }

  // The browser reporting a change of connection state.
  becomes(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
}

module.exports = { Protocol, fakeTimers, settle, fakeSignaling, fakeStream, fakeGetUserMedia, FakePeerConnection };
