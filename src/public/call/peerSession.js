// One side of one call: an RTCPeerConnection and everything around it -
// getting the ICE servers, the camera and microphone, exchanging the
// offer/answer and ICE candidates over the signaling connection, noticing a
// broken connection and repairing it (ICE restart), and tearing down.
//
// Media goes straight from this peer connection to the other person's. The
// signaling connection only carries the few kilobytes of text they need to
// find each other.
//
// Two modes: 'call' (both send camera and microphone) and 'stream' (only the
// caller sends; the other side receives through recvonly transceivers). A
// stream can become a call mid-session (upgradeToCall).
//
// No UI and no DOM: everything it needs from the platform is passed in, so
// the same logic ports to a mobile client. It reports through events:
//   'state'        (state, detail)  new → starting → connecting → connected
//                                   ⇄ reconnecting → ended | failed
//   'localstream'  (MediaStream)    what this side sends, for a preview
//   'remotestream' (MediaStream)    what the other side sends
//   'mode'         ('call')         a stream became a two-way call
//   'notice'       ({ code })       something worth telling the user that
//                                   doesn't end the call (e.g. no_camera)
//
// Failure codes (the `detail` of 'failed'): insecure_context,
// permission_denied, no_devices, device_busy, media_error, ice_config,
// connection_failed, connection_failed_no_turn (no direct path between the
// two networks and no TURN relay configured).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PeerSession = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SETUP_TIMEOUT_MS = 30 * 1000; // from "connecting" to media flowing
  var DISCONNECT_GRACE_MS = 3 * 1000; // a blip often heals by itself
  var RESTART_TIMEOUT_MS = 10 * 1000; // how long one ICE restart gets
  var MAX_RESTARTS = 3;

  // options:
  //   signaling        a SignalingClient (on/off/send)
  //   callId, peerId   the call, and the other user's id
  //   mode             'call' | 'stream'
  //   role             'caller' (made the invitation, sends in a stream) | 'callee'
  //   fetchIceConfig   () → Promise<{ iceServers, turn }>
  //   createPeerConnection (config) → RTCPeerConnection; default: new RTCPeerConnection(config)
  //   getUserMedia     (constraints) → Promise<MediaStream>; default: navigator.mediaDevices
  //   setTimeout / clearTimeout   for tests
  function PeerSession(options) {
    this.signaling = options.signaling;
    this.callId = options.callId;
    this.peerId = options.peerId;
    this.mode = options.mode;
    this.role = options.role;
    this.fetchIceConfig = options.fetchIceConfig;
    this.createPeerConnection = options.createPeerConnection || function (config) { return new RTCPeerConnection(config); };
    this.getUserMedia = options.getUserMedia !== undefined ? options.getUserMedia : defaultGetUserMedia();
    this.setTimeout = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    this.clearTimeout = options.clearTimeout || function (id) { clearTimeout(id); };

    this.state = 'new';
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.hasTurn = false;
    this.makingOffer = false;
    this.candidates = []; // remote candidates that arrived before the remote description
    this.restarts = 0;
    this.timers = {};
    this.handlers = {};
    this.subscriptions = [];
    this.work = Promise.resolve(); // signaling is handled one message at a time
    this.ready = false; // the peer connection exists and has its media
    this.waiting = []; // signals that arrived before that
  }

  function defaultGetUserMedia() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    return function (constraints) { return navigator.mediaDevices.getUserMedia(constraints); };
  }

  function coded(code, cause) {
    var error = new Error(code);
    error.code = code;
    error.cause = cause;
    return error;
  }

  PeerSession.prototype.on = function (event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
    return this;
  };

  PeerSession.prototype.emit = function (event, a, b) {
    (this.handlers[event] || []).slice().forEach(function (handler) { handler(a, b); });
  };

  PeerSession.prototype.setState = function (state, detail) {
    if (this.state === state || this.isOver()) return;
    this.state = state;
    this.emit('state', state, detail);
  };

  PeerSession.prototype.isOver = function () {
    return this.state === 'ended' || this.state === 'failed';
  };

  // Whether this side sends camera and microphone in the current mode.
  PeerSession.prototype.sendsMedia = function () {
    return this.mode === 'call' || this.role === 'caller';
  };

  PeerSession.prototype.timer = function (name, ms, fn) {
    var self = this;
    this.cancelTimer(name);
    this.timers[name] = this.setTimeout(function () {
      delete self.timers[name];
      fn();
    }, ms);
  };

  PeerSession.prototype.cancelTimer = function (name) {
    if (this.timers[name] !== undefined) this.clearTimeout(this.timers[name]);
    delete this.timers[name];
  };

  // Runs `task` after everything queued before it; a failure fails the call.
  PeerSession.prototype.enqueue = function (task) {
    var self = this;
    this.work = this.work.then(function () {
      if (!self.isOver()) return task();
    }).catch(function (error) {
      self.fail(error && error.code ? error.code : 'media_error', error);
    });
    return this.work;
  };

  PeerSession.prototype.send = function (type, payload) {
    return this.signaling.send(type, { callId: this.callId, to: this.peerId, payload: payload || {} });
  };

  // ---- Start ---------------------------------------------------------------

  // Gets the ICE servers and (if this side sends) the camera and microphone,
  // builds the peer connection and, for the caller, makes the first offer.
  PeerSession.prototype.start = function () {
    var self = this;
    this.setState('starting');
    this.listen();
    return this.enqueue(function () {
      return Promise.resolve()
        .then(function () { return self.fetchIceConfig(); })
        .catch(function (error) { throw coded('ice_config', error); })
        .then(function (config) {
          self.hasTurn = !!config.turn;
          self.iceServers = config.iceServers;
          return self.sendsMedia() ? self.acquireMedia() : null;
        })
        .then(function () {
          if (self.isOver()) return null; // ended while the permission prompt was up
          self.buildPeerConnection();
          self.setState('connecting');
          self.timer('setup', SETUP_TIMEOUT_MS, function () {
            if (self.state === 'connecting') self.fail(self.hasTurn ? 'connection_failed' : 'connection_failed_no_turn');
          });
          self.ready = true;
          var waiting = self.waiting;
          self.waiting = [];
          waiting.forEach(function (handle) { self.enqueue(handle); });
          return self.role === 'caller' ? self.negotiate('sdp.offer') : null;
        });
    });
  };

  // Camera + microphone; with no camera, microphone only (and a notice).
  PeerSession.prototype.acquireMedia = function () {
    var self = this;
    if (!this.getUserMedia) return Promise.reject(coded('insecure_context'));
    var classify = function (error) {
      var name = error && error.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'permission_denied';
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_devices';
      if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'device_busy';
      return 'media_error';
    };
    return this.getUserMedia({ audio: true, video: true })
      .catch(function (error) {
        var code = classify(error);
        if (code === 'permission_denied') throw coded(code, error);
        // No (usable) camera: a voice-only side is still a call.
        return self.getUserMedia({ audio: true, video: false }).then(
          function (stream) { self.emit('notice', { code: 'no_camera' }); return stream; },
          function (second) { throw coded(classify(second) === 'permission_denied' ? 'permission_denied' : code, second); }
        );
      })
      .then(function (stream) {
        if (self.isOver()) { // ended while the prompt was up: don't keep the camera on
          stream.getTracks().forEach(function (track) { track.stop(); });
          return null;
        }
        self.localStream = stream;
        self.emit('localstream', stream);
        return stream;
      });
  };

  PeerSession.prototype.buildPeerConnection = function () {
    var self = this;
    var pc = this.pc = this.createPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = function (event) {
      // Trickle ICE: each candidate goes out as it is found.
      if (event.candidate && event.candidate.candidate) {
        self.send('ice.candidate', { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex });
      }
    };
    pc.ontrack = function (event) {
      var stream = event.streams && event.streams[0];
      if (!stream) return;
      self.remoteStream = stream;
      self.emit('remotestream', stream);
    };
    var watch = function () { self.onConnectionState(); };
    pc.onconnectionstatechange = watch;
    pc.oniceconnectionstatechange = watch;

    if (this.localStream) {
      this.localStream.getTracks().forEach(function (track) { pc.addTrack(track, self.localStream); });
      // A one-way stream: this side sends and takes nothing back. (The
      // viewer adds nothing here: answering the offer gives it recvonly
      // transceivers.)
      if (this.mode === 'stream') pc.getTransceivers().forEach(function (transceiver) { transceiver.direction = 'sendonly'; });
    }
  };

  // ---- Signaling -----------------------------------------------------------

  PeerSession.prototype.listen = function () {
    var self = this;
    var subscribe = function (type, handle) {
      var handler = function (message) {
        if (type !== 'reconnected' && message.callId !== self.callId) return;
        // Offers and candidates can beat the camera permission prompt.
        var task = function () { return handle.call(self, message); };
        if (!self.ready && type !== 'call.end' && type !== 'reconnected') self.waiting.push(task);
        else self.enqueue(task);
      };
      self.signaling.on(type, handler);
      self.subscriptions.push([type, handler]);
    };
    subscribe('sdp.offer', this.onOffer);
    subscribe('ice.restart', this.onOffer);
    subscribe('sdp.answer', this.onAnswer);
    subscribe('ice.candidate', this.onCandidate);
    subscribe('call.end', function (message) { this.end((message.payload && message.payload.reason) || 'ended_by_peer', true); });
    subscribe('reconnected', this.onSignalingBack);
  };

  // Makes an offer and sends it as `type` ('sdp.offer' or 'ice.restart').
  PeerSession.prototype.negotiate = function (type, extra) {
    var self = this;
    var pc = this.pc;
    this.makingOffer = true;
    return pc.createOffer(type === 'ice.restart' ? { iceRestart: true } : undefined)
      .then(function (offer) {
        if (pc.signalingState !== 'stable') return null; // their offer got in first; ours isn't needed
        return pc.setLocalDescription(offer).then(function () {
          var payload = { sdp: pc.localDescription.sdp };
          if (extra && extra.mode) payload.mode = extra.mode;
          self.send(type, payload);
        });
      })
      .then(function () { self.makingOffer = false; }, function (error) { self.makingOffer = false; throw error; });
  };

  // An offer from the other side (also an ICE restart, which is one). If
  // both sides offered at once, the caller's offer wins and the callee
  // drops its own - so exactly one of the two goes through.
  PeerSession.prototype.onOffer = function (message) {
    var self = this;
    var pc = this.pc;
    var collision = this.makingOffer || pc.signalingState !== 'stable';
    if (collision && this.role === 'caller') return null; // ours stands; theirs is ignored
    var rollback = collision ? pc.setLocalDescription({ type: 'rollback' }).catch(function () {}) : Promise.resolve();
    return rollback
      .then(function () { return pc.setRemoteDescription({ type: 'offer', sdp: message.payload.sdp }); })
      .then(function () { return self.drainCandidates(); })
      .then(function () { return message.payload.mode === 'call' && self.mode === 'stream' ? self.becomeTwoWay() : null; })
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { self.send('sdp.answer', { sdp: pc.localDescription.sdp }); });
  };

  PeerSession.prototype.onAnswer = function (message) {
    var self = this;
    if (this.pc.signalingState !== 'have-local-offer') return null; // not waiting for one
    return this.pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp }).then(function () { return self.drainCandidates(); });
  };

  PeerSession.prototype.onCandidate = function (message) {
    var candidate = message.payload;
    if (!candidate.candidate) return null; // end-of-candidates marker
    if (!this.pc.remoteDescription) {
      this.candidates.push(candidate);
      return null;
    }
    // A candidate for an offer that was dropped is expected to fail.
    return this.pc.addIceCandidate(candidate).catch(function () {});
  };

  PeerSession.prototype.drainCandidates = function () {
    var pc = this.pc;
    var queued = this.candidates;
    this.candidates = [];
    return Promise.all(queued.map(function (candidate) { return pc.addIceCandidate(candidate).catch(function () {}); }));
  };

  // The signaling connection dropped and came back (its server restarted,
  // the network changed): tell the server where this call is now, and if the
  // media path suffered too, repair it.
  PeerSession.prototype.onSignalingBack = function () {
    this.send('call.resume', {});
    if (this.ready && this.state !== 'connected') return this.restartIce();
    return null;
  };

  // ---- Connection health ---------------------------------------------------

  PeerSession.prototype.onConnectionState = function () {
    var self = this;
    if (this.isOver() || !this.pc) return;
    var ice = this.pc.iceConnectionState;
    var state = this.pc.connectionState || (ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice);
    if (state === 'connected') {
      this.cancelTimer('setup');
      this.cancelTimer('disconnect');
      this.cancelTimer('restart');
      this.restarts = 0;
      this.setState('connected');
    } else if (state === 'disconnected') {
      if (this.state !== 'connected') return;
      this.setState('reconnecting');
      this.timer('disconnect', DISCONNECT_GRACE_MS, function () { self.enqueue(function () { return self.restartIce(); }); });
    } else if (state === 'failed') {
      this.cancelTimer('disconnect');
      this.enqueue(function () { return self.restartIce(); });
    }
  };

  // A new offer that makes both sides gather candidates again - what gets a
  // call through a changed network. Tried a few times, then the call fails.
  PeerSession.prototype.restartIce = function () {
    var self = this;
    if (this.isOver() || !this.pc) return null;
    // Nothing was ever established to repair: the first exchange is still
    // under way, and the setup timer covers it.
    if (!this.pc.remoteDescription) return null;
    if (this.restarts >= MAX_RESTARTS) {
      this.fail(this.hasTurn ? 'connection_failed' : 'connection_failed_no_turn');
      return null;
    }
    this.restarts += 1;
    this.cancelTimer('setup');
    this.setState('reconnecting');
    this.timer('restart', RESTART_TIMEOUT_MS, function () {
      if (self.state === 'reconnecting') self.enqueue(function () { return self.restartIce(); });
    });
    if (this.pc.signalingState !== 'stable') return null; // an exchange is under way; the timer tries again
    return this.negotiate('ice.restart');
  };

  // Call when the device's network changed (e.g. the browser's "online"
  // event): don't wait for the connection to notice.
  PeerSession.prototype.networkChanged = function () {
    var self = this;
    if (this.isOver() || !this.ready) return;
    this.restarts = 0;
    this.enqueue(function () { return self.restartIce(); });
  };

  // ---- Controls ------------------------------------------------------------

  function setEnabled(stream, kind, on) {
    if (!stream) return false;
    var tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    tracks.forEach(function (track) { track.enabled = on; });
    return tracks.length > 0;
  }

  // Both return false when there is no such track to switch.
  PeerSession.prototype.setMicEnabled = function (on) { return setEnabled(this.localStream, 'audio', on); };
  PeerSession.prototype.setCameraEnabled = function (on) { return setEnabled(this.localStream, 'video', on); };

  // stream → call, in place: this side starts sending (if it wasn't) and
  // receiving (if it wasn't). Used by whoever asks for the switch, and by
  // the other side when the offer announcing it arrives.
  PeerSession.prototype.becomeTwoWay = function () {
    var self = this;
    this.mode = 'call';
    this.emit('mode', 'call');
    var media = this.localStream ? Promise.resolve(this.localStream) : this.acquireMedia().catch(function (error) {
      // No camera or permission: stay a viewer rather than lose the stream.
      self.emit('notice', { code: error.code || 'media_error' });
      return null;
    });
    return media.then(function (stream) {
      return Promise.all(self.pc.getTransceivers().map(function (transceiver) {
        if (!stream) return null;
        var kind = transceiver.receiver && transceiver.receiver.track ? transceiver.receiver.track.kind : transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind;
        var track = stream.getTracks().filter(function (candidate) { return candidate.kind === kind; })[0];
        transceiver.direction = 'sendrecv';
        if (track && transceiver.sender.track !== track) return transceiver.sender.replaceTrack(track);
        return null;
      }));
    });
  };

  // Ask to turn a one-way stream into a two-way call (either side may).
  PeerSession.prototype.upgradeToCall = function () {
    var self = this;
    return this.enqueue(function () {
      if (self.mode !== 'stream' || !self.ready) return null;
      return self.becomeTwoWay().then(function () { return self.negotiate('sdp.offer', { mode: 'call' }); });
    });
  };

  // ---- End -----------------------------------------------------------------

  PeerSession.prototype.teardown = function () {
    var self = this;
    Object.keys(this.timers).forEach(function (name) { self.cancelTimer(name); });
    this.subscriptions.forEach(function (pair) { self.signaling.off(pair[0], pair[1]); });
    this.subscriptions = [];
    this.waiting = [];
    if (this.localStream) this.localStream.getTracks().forEach(function (track) { track.stop(); });
    if (this.pc) {
      this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = null;
      this.pc.close();
    }
  };

  // Hang up. `remote`: the other side already knows (it ended the call).
  PeerSession.prototype.end = function (reason, remote) {
    if (this.isOver()) return;
    if (!remote) this.send('call.end', reason ? { reason: reason } : {});
    this.state = 'ended';
    this.teardown();
    this.emit('state', 'ended', reason);
  };

  PeerSession.prototype.fail = function (code, cause) {
    if (this.isOver()) return;
    this.send('call.end', { reason: code });
    this.state = 'failed';
    this.teardown();
    this.emit('state', 'failed', code, cause);
  };

  PeerSession.SETUP_TIMEOUT_MS = SETUP_TIMEOUT_MS;
  PeerSession.DISCONNECT_GRACE_MS = DISCONNECT_GRACE_MS;
  PeerSession.RESTART_TIMEOUT_MS = RESTART_TIMEOUT_MS;
  PeerSession.MAX_RESTARTS = MAX_RESTARTS;
  return PeerSession;
});
