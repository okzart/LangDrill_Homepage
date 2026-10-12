// The signaling connection: a WebSocket that speaks the LanguageDrill
// signaling protocol (protocol.js, served by signaling-service), reconnects
// by itself, and hands each message to whoever subscribed to its type.
//
// No UI and no browser globals beyond what is passed in, so the same logic
// ports to a mobile client (React Native / Flutter): give it a WebSocket
// factory that connects with the user's token and it does the rest.
//
//   var client = new SignalingClient({ url: 'wss://host/call/ws', protocol: SignalingProtocol });
//   client.on('call.invite', function (message) { ... });
//   client.on('state', function (state) { ... });   // 'connecting' | 'open' | 'closed'
//   client.connect();
//   client.send('call.invite', { callId: id, to: userId, payload: { mode: 'call' } });
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignalingClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000]; // then 15 s for good
  var MAX_QUEUED = 100; // call messages held while the socket is down

  // options:
  //   url            the WebSocket address
  //   protocol       the SignalingProtocol object
  //   createSocket   (url) → WebSocket-like; defaults to `new WebSocket(url)`
  //   setTimeout / clearTimeout / random   for tests
  function SignalingClient(options) {
    this.url = options.url;
    this.protocol = options.protocol;
    this.createSocket = options.createSocket || function (url) { return new WebSocket(url); };
    this.setTimeout = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    this.clearTimeout = options.clearTimeout || function (id) { clearTimeout(id); };
    this.random = options.random || Math.random;
    this.handlers = {}; // event → [fn]
    this.socket = null;
    this.state = 'closed';
    this.wanted = false; // connect() was called and close() wasn't
    this.attempt = 0; // failed connections in a row
    this.timer = null;
    this.queue = []; // frames to send once open
    this.watched = {}; // emails asked about, asked again after a reconnect
    this.everOpened = false;
  }

  SignalingClient.prototype.on = function (event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
    return this;
  };

  SignalingClient.prototype.off = function (event, handler) {
    var list = this.handlers[event] || [];
    var at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  };

  SignalingClient.prototype.emit = function (event, value) {
    (this.handlers[event] || []).slice().forEach(function (handler) { handler(value); });
  };

  SignalingClient.prototype.setState = function (state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  };

  SignalingClient.prototype.connect = function () {
    this.wanted = true;
    if (this.socket || this.timer) return;
    this.open();
  };

  SignalingClient.prototype.open = function () {
    var self = this;
    this.timer = null;
    this.setState('connecting');
    var socket = this.socket = this.createSocket(this.url);
    socket.onopen = function () {
      if (self.socket !== socket) return;
      var again = self.everOpened;
      self.everOpened = true;
      self.attempt = 0;
      self.setState('open');
      // What the server forgot when the old socket died.
      Object.keys(self.watched).forEach(function (email) { self.raw({ type: 'presence.query', payload: { email: email } }); });
      // 'reconnected' before the queue is flushed, so a call can announce
      // itself (call.resume) ahead of the messages that were waiting.
      if (again) self.emit('reconnected');
      var queued = self.queue;
      self.queue = [];
      queued.forEach(function (message) { self.raw(message); });
    };
    socket.onmessage = function (event) {
      if (self.socket !== socket) return;
      var parsed;
      try { parsed = JSON.parse(event.data); } catch (e) { return; }
      var checked = self.protocol.validate(parsed, 'any');
      if (!checked.ok) return; // not something this version understands
      self.emit(checked.message.type, checked.message);
      self.emit('message', checked.message);
    };
    socket.onclose = function (event) {
      if (self.socket !== socket) return;
      self.socket = null;
      self.setState('closed');
      // 4401: the login expired - reconnecting can't help until they log in again.
      if (event && event.code === 4401) {
        self.wanted = false;
        self.emit('unauthorized');
        return;
      }
      if (self.wanted) self.retry();
    };
    socket.onerror = function () { /* a close always follows */ };
  };

  // Reconnect with growing pauses (and some jitter, so a restarted server
  // isn't hit by every client in the same instant).
  SignalingClient.prototype.retry = function () {
    var self = this;
    var base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    if (this.attempt === 3) this.emit('unreachable');
    this.timer = this.setTimeout(function () { self.open(); }, Math.round(base * (0.75 + this.random() * 0.5)));
  };

  SignalingClient.prototype.raw = function (message) {
    this.socket.send(JSON.stringify(message));
  };

  // Sends a message of `type`; `fields`: { callId, to, payload }. Returns
  // false if the message isn't valid (nothing is sent). While the socket is
  // down, call messages wait and go out when it is back.
  SignalingClient.prototype.send = function (type, fields) {
    var message = { type: type, payload: (fields && fields.payload) || {} };
    if (fields && fields.callId) message.callId = fields.callId;
    if (fields && fields.to) message.to = fields.to;
    var checked = this.protocol.validate(message, 'client');
    if (!checked.ok) {
      this.emit('invalid', { type: type, error: checked.error });
      return false;
    }
    if (type === 'presence.query') this.watched[checked.message.payload.email] = true;
    if (this.state === 'open') this.raw(checked.message);
    else if (type !== 'presence.query' && this.queue.length < MAX_QUEUED) this.queue.push(checked.message);
    return true;
  };

  // Call when the device regains its network, to skip the rest of a pause.
  SignalingClient.prototype.reconnectNow = function () {
    if (!this.wanted || this.socket) return;
    if (this.timer) this.clearTimeout(this.timer);
    this.attempt = 0;
    this.open();
  };

  SignalingClient.prototype.close = function () {
    this.wanted = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    var socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000);
    this.setState('closed');
  };

  return SignalingClient;
});
