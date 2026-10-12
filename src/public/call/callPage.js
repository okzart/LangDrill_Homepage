// The /call page: the user interface around SignalingClient and PeerSession
// (the two files next to this one hold all the call logic and know nothing
// about this page). Finds the other person by email, rings them, answers
// when rung, and shows the call with its controls.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var t = window.t;
  var Protocol = window.SignalingProtocol;
  var errorBox = $('call-error'), infoBox = $('call-info');

  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; infoBox.hidden = true; }
  function showInfo(message) { infoBox.textContent = message; infoBox.hidden = false; errorBox.hidden = true; }
  function clearMessages() { errorBox.hidden = true; infoBox.hidden = true; }

  if (!Protocol || !window.SignalingClient || !window.PeerSession) {
    showError(t('Video calls are unavailable right now (is signaling-service running?)'));
    return;
  }
  // Browsers only hand out the camera on HTTPS (or localhost).
  var insecure = !window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection;
  if (insecure) showError(t('Video calls need a secure (https) connection and a browser that supports them - open this site over https.'));

  var HANDOFF_KEY = 'ld_call_accept'; // an invitation accepted on another page (incoming.js)
  var client = new window.SignalingClient({ url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/call/ws', protocol: Protocol });
  var view = 'idle'; // idle | outgoing | incoming | in-call
  var call = null; // { id, peerId, peerEmail, mode, role }
  var session = null;
  var peer = null; // the person looked up: { userId, email, online }
  var ringTimer = null;
  var micOn = true, camOn = true;
  // Set when the page was opened for one particular person (from the Friends
  // page): { email, mode }. The "start a call" form is then replaced by a
  // panel about that person.
  var direct = null;

  var FAILURES = {
    insecure_context: t('Video calls need a secure (https) connection and a browser that supports them - open this site over https.'),
    permission_denied: t('The browser was not allowed to use the camera and microphone. Allow them for this site and try again.'),
    no_devices: t('No camera or microphone was found on this device.'),
    device_busy: t('The camera or microphone is being used by another app.'),
    media_error: t('The camera or microphone could not be started.'),
    ice_config: t('Video calls are unavailable right now (is signaling-service running?)'),
    connection_failed: t('The connection failed. Check your network and try again.'),
    connection_failed_no_turn: t('The two networks do not allow a direct connection (a strict firewall or mobile network), and no relay server is set up. Try another network.'),
  };

  function show(next) {
    view = next;
    $('start').hidden = next !== 'idle' || !!direct;
    $('direct').hidden = next !== 'idle' || !direct;
    $('ringing').hidden = next !== 'outgoing';
    $('incoming').hidden = next !== 'incoming';
    $('in-call').hidden = next !== 'in-call';
    refreshStart();
  }

  function refreshStart() {
    var ready = view === 'idle' && client.state === 'open' && !insecure && !!peer && peer.online && !!peer.userId;
    $('btn-call').disabled = !ready;
    $('btn-stream').disabled = !ready;
    if (direct) {
      $('direct-call').disabled = !ready;
      $('direct-call').textContent = direct.mode === 'stream' ? t('Live stream (they watch you)') : t('Video call');
      $('direct-text').textContent = !peer ? t('Checking whether {email} is online…', { email: direct.email })
        : peer.online ? t('{email} is online.', { email: direct.email })
          : t('{email} is not online right now. This updates as soon as they open LanguageDrill.', { email: direct.email });
    }
  }

  // ---- Finding the other person ---------------------------------------------

  function typedEmail() { return $('peer-email').value.trim().toLowerCase(); }

  function check() {
    clearMessages();
    var email = typedEmail();
    peer = null;
    refreshStart();
    if (!email) return;
    var line = $('presence-line');
    line.className = 'status';
    if (!client.send('presence.query', { payload: { email: email } })) { line.textContent = t('That does not look like an email address.'); return; }
    line.textContent = client.state === 'open' ? t('Checking…') : t('Connecting…');
  }
  $('check-btn').addEventListener('click', check);
  $('peer-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); check(); } });
  $('peer-email').addEventListener('input', function () { peer = null; $('presence-line').textContent = ''; refreshStart(); });

  client.on('presence.update', function (message) {
    var p = message.payload;
    if (p.email !== typedEmail()) return; // an answer about someone looked up earlier
    peer = { userId: p.userId, email: p.email, online: p.online };
    var line = $('presence-line');
    line.className = 'status ' + (p.online ? 'on' : 'off');
    line.textContent = p.online ? t('{email} is online.', { email: p.email })
      : p.userId ? t('{email} is not online right now. This updates as soon as they open LanguageDrill.', { email: p.email })
        : t('{email} has not opened LanguageDrill yet, or the address is wrong. This updates as soon as they do.', { email: p.email });
    refreshStart();
  });

  // ---- Calling ---------------------------------------------------------------

  function startCall(mode) {
    if (view !== 'idle' || !peer || !peer.online) return;
    clearMessages();
    call = { id: Protocol.newCallId(), peerId: peer.userId, peerEmail: peer.email, mode: mode, role: 'caller' };
    client.send('call.invite', { callId: call.id, to: call.peerId, payload: { mode: mode } });
    $('ringing-text').textContent = t('Calling {email}…', { email: call.peerEmail });
    show('outgoing');
    ringTimer = setTimeout(function () {
      client.send('call.cancel', { callId: call.id, to: call.peerId, payload: { reason: 'timeout' } });
      backToIdle();
      showInfo(t('No answer.'));
    }, Protocol.RING_TIMEOUT_MS);
  }
  $('btn-call').addEventListener('click', function () { startCall('call'); });
  $('btn-stream').addEventListener('click', function () { startCall('stream'); });
  $('btn-cancel').addEventListener('click', function () {
    if (view !== 'outgoing') return;
    client.send('call.cancel', { callId: call.id, to: call.peerId, payload: {} });
    backToIdle();
  });

  function backToIdle() {
    clearTimeout(ringTimer);
    call = null;
    session = null;
    show('idle');
  }

  var mine = function (message) { return call && message.callId === call.id; };

  client.on('call.accept', function (message) {
    if (view !== 'outgoing' || !mine(message)) return;
    clearTimeout(ringTimer);
    beginSession();
  });
  client.on('call.reject', function (message) {
    if (view !== 'outgoing' || !mine(message)) return;
    var email = call.peerEmail;
    backToIdle();
    showInfo(t('{email} declined the call.', { email: email }));
  });
  client.on('error', function (message) {
    if (!mine(message)) return;
    var code = message.payload.code;
    if (view === 'outgoing' || view === 'incoming') {
      backToIdle();
      showError(code === Protocol.ERRORS.PEER_OFFLINE ? t('That person is not online.')
        : code === Protocol.ERRORS.BUSY ? t('That person (or you) is already in another call.')
          : code === Protocol.ERRORS.NO_SUCH_CALL ? t('That call has already ended.')
            : t('The call could not be started.'));
    } else if (view === 'in-call' && code === Protocol.ERRORS.NO_SUCH_CALL && session) {
      session.end('ended', true); // the server no longer knows this call
    }
  });

  // ---- Being called ----------------------------------------------------------

  client.on('call.invite', function (message) {
    if (view !== 'idle') {
      client.send('call.reject', { callId: message.callId, to: message.from, payload: { reason: 'busy' } });
      return;
    }
    clearMessages();
    call = { id: message.callId, peerId: message.from, peerEmail: message.payload.fromEmail || t('Someone'), mode: message.payload.mode, role: 'callee' };
    $('incoming-text').textContent = message.payload.mode === 'stream'
      ? t('{email} wants to show you a live stream. Your camera stays off.', { email: call.peerEmail })
      : t('{email} is calling you (video call).', { email: call.peerEmail });
    show('incoming');
  });
  client.on('call.cancel', function (message) {
    if (view !== 'incoming' || !mine(message)) return;
    var email = call.peerEmail, elsewhere = message.payload.reason === 'answered_elsewhere';
    backToIdle();
    showInfo(elsewhere ? t('The call was answered in another tab.') : t('Missed call from {email}.', { email: email }));
  });
  $('btn-accept').addEventListener('click', function () {
    if (view !== 'incoming') return;
    client.send('call.accept', { callId: call.id, to: call.peerId, payload: {} });
    beginSession();
  });
  $('btn-reject').addEventListener('click', function () {
    if (view !== 'incoming') return;
    client.send('call.reject', { callId: call.id, to: call.peerId, payload: { reason: 'declined' } });
    backToIdle();
  });

  // Arriving from the Friends page: /call?email=<friend>&start=call|stream
  // fills the email in and starts that kind of call as soon as the friend
  // shows as online. The address is tidied so a reload doesn't call again.
  var autoStart = null;
  (function () {
    var params = new URLSearchParams(location.search);
    var email = (params.get('email') || '').trim().toLowerCase();
    if (!email) return;
    $('peer-email').value = email;
    if (Protocol.MODES.indexOf(params.get('start')) !== -1) autoStart = params.get('start');
    direct = { email: email, mode: autoStart || 'call' };
    if (window.history && history.replaceState) history.replaceState(null, '', location.pathname);
  })();
  client.on('presence.update', function (message) {
    if (!autoStart || message.payload.email !== typedEmail()) return;
    var mode = autoStart;
    autoStart = null; // one attempt: if they are offline the page just says so
    if (message.payload.online && view === 'idle' && !insecure) startCall(mode);
  });
  $('direct-call').addEventListener('click', function () { if (direct) startCall(direct.mode); });
  $('direct-other').addEventListener('click', function () {
    direct = null;
    autoStart = null;
    peer = null;
    $('peer-email').value = '';
    $('presence-line').textContent = '';
    clearMessages();
    show('idle');
  });

  // An invitation accepted from another page arrives here through
  // sessionStorage (see incoming.js): answer it as soon as we are connected.
  function takeHandoff() {
    var raw = null;
    try { raw = sessionStorage.getItem(HANDOFF_KEY); sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var invite;
    try { invite = JSON.parse(raw); } catch (e) { return; }
    if (!invite || Date.now() - invite.at > Protocol.RING_TIMEOUT_MS) return; // too old to still be ringing
    call = { id: invite.callId, peerId: invite.from, peerEmail: invite.fromEmail || t('Someone'), mode: invite.mode, role: 'callee' };
    client.send('call.accept', { callId: call.id, to: call.peerId, payload: {} });
    beginSession();
  }

  // ---- In the call -------------------------------------------------------------

  function fetchIceConfig() {
    return fetch('/call/ice-config', { headers: { Accept: 'application/json' } }).then(function (res) {
      if (res.status === 401) { location.href = '/login?next=/call'; throw new Error('Not logged in'); }
      if (!res.ok) throw new Error('ice-config ' + res.status);
      return res.json();
    });
  }

  function setPill(kind, text) {
    var pill = $('status-pill');
    pill.className = 'pill ' + kind;
    pill.textContent = text;
  }

  function refreshControls() {
    var sending = session && session.sendsMedia();
    $('btn-mic').hidden = !sending;
    $('btn-cam').hidden = !sending;
    $('local-video').hidden = !sending || !session.localStream;
    $('btn-mic').textContent = micOn ? t('Mute') : t('Unmute');
    $('btn-mic').classList.toggle('off', !micOn);
    $('btn-cam').textContent = camOn ? t('Camera off') : t('Camera on');
    $('btn-cam').classList.toggle('off', !camOn);
    $('btn-upgrade').hidden = !session || session.mode !== 'stream';
    var note = '';
    if (session && session.mode === 'stream') {
      note = call.role === 'caller' ? t('You are streaming to {email}. They can see and hear you; you cannot see them.', { email: call.peerEmail })
        : (session.remoteStream ? '' : t('Waiting for the stream from {email}…', { email: call.peerEmail }));
    } else if (session && !session.remoteStream) {
      note = t('Connecting to {email}…', { email: call.peerEmail });
    }
    $('stage-note').textContent = note;
  }

  function beginSession() {
    micOn = camOn = true;
    $('call-notice').textContent = '';
    $('remote-video').srcObject = null;
    $('local-video').srcObject = null;
    session = new window.PeerSession({ signaling: client, callId: call.id, peerId: call.peerId, mode: call.mode, role: call.role, fetchIceConfig: fetchIceConfig });
    var current = session;
    session.on('localstream', function (stream) { $('local-video').srcObject = stream; refreshControls(); });
    session.on('remotestream', function (stream) {
      $('remote-video').srcObject = stream;
      var playing = $('remote-video').play();
      if (playing && playing.catch) playing.catch(function () {}); // autoplay refusals resolve on the next click
      refreshControls();
    });
    session.on('mode', function () {
      $('call-notice').textContent = t('This is now a two-way video call.');
      refreshControls();
    });
    session.on('notice', function (notice) {
      $('call-notice').textContent = notice.code === 'no_camera' ? t('No camera was found - you are sending sound only.')
        : notice.code === 'permission_denied' ? t('The browser was not allowed to use the camera and microphone, so you are still only watching.')
          : (FAILURES[notice.code] || '');
    });
    session.on('state', function (state, detail) {
      if (current !== session) return;
      if (state === 'starting') setPill('wait', t('Getting ready…'));
      else if (state === 'connecting') setPill('wait', t('Connecting…'));
      else if (state === 'connected') setPill('good', t('Connected'));
      else if (state === 'reconnecting') setPill('wait', t('Connection lost - reconnecting…'));
      else {
        var email = call.peerEmail;
        $('remote-video').srcObject = null;
        $('local-video').srcObject = null;
        backToIdle();
        if (state === 'failed') showError(FAILURES[detail] || FAILURES.connection_failed);
        else showInfo(detail && FAILURES[detail] ? t('{email} could not join: {reason}', { email: email, reason: FAILURES[detail] }) : t('The call with {email} has ended.', { email: email }));
      }
      refreshControls();
    });
    show('in-call');
    setPill('wait', t('Getting ready…'));
    refreshControls();
    session.start();
  }

  $('btn-mic').addEventListener('click', function () { if (session) { micOn = !micOn; session.setMicEnabled(micOn); refreshControls(); } });
  $('btn-cam').addEventListener('click', function () { if (session) { camOn = !camOn; session.setCameraEnabled(camOn); refreshControls(); } });
  $('btn-upgrade').addEventListener('click', function () { if (session) session.upgradeToCall(); });
  $('btn-end').addEventListener('click', function () { if (session) session.end(); });

  // ---- Connection to the signaling server ------------------------------------

  var handoffTaken = false;
  client.on('state', function (state) {
    refreshStart();
    if (state === 'open') {
      if (!handoffTaken) { handoffTaken = true; takeHandoff(); }
      if (typedEmail() && !peer) check();
      if (view === 'in-call') $('call-notice').textContent = '';
    } else if (view === 'in-call') {
      // The call itself goes on: it doesn't pass through the server.
      $('call-notice').textContent = t('Lost contact with the call server - reconnecting. The call itself continues.');
    }
  });
  client.on('unreachable', function () { if (view !== 'in-call') showError(t('Video calls are unavailable right now (is signaling-service running?)')); });
  client.on('unauthorized', function () { showError(t('You have been logged out. Log in again to make calls.')); });

  // A changed network (Wi-Fi → mobile data): reconnect and repair at once.
  function networkChanged() {
    client.reconnectNow();
    if (session) session.networkChanged();
  }
  window.addEventListener('online', networkChanged);
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', networkChanged);

  // Leaving the page hangs up, so the other side isn't left looking at a frozen picture.
  window.addEventListener('pagehide', function () {
    if (session) session.end('left');
    else if (view === 'outgoing' && call) client.send('call.cancel', { callId: call.id, to: call.peerId, payload: {} });
  });

  show('idle');
  client.connect();
})();
