// Rings on every page but /call: keeps a signaling connection open while the
// user is anywhere on the site, and shows a small dialog when someone calls.
// Accepting hands the invitation to the /call page (through sessionStorage),
// which answers it; declining answers right here. Loaded from _nav.pug.
(function () {
  'use strict';
  if (!window.SignalingProtocol || !window.SignalingClient || location.pathname === '/call') return;
  var t = window.t, Protocol = window.SignalingProtocol;
  var HANDOFF_KEY = 'ld_call_accept';
  var client = new window.SignalingClient({ url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/call/ws', protocol: Protocol });
  var ringing = null; // { callId, from, fromEmail, mode, at }
  var box = null, timer = null;

  function hide() {
    clearTimeout(timer);
    ringing = null;
    if (box) box.remove();
    box = null;
  }

  function button(label, primary, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.style.marginTop = '0';
    b.addEventListener('click', onClick);
    return b;
  }

  client.on('call.invite', function (message) {
    if (ringing) { // already ringing for someone else
      client.send('call.reject', { callId: message.callId, to: message.from, payload: { reason: 'busy' } });
      return;
    }
    ringing = { callId: message.callId, from: message.from, fromEmail: message.payload.fromEmail || '', mode: message.payload.mode, at: Date.now() };
    box = document.createElement('div');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-live', 'assertive');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:1000;max-width:22rem;padding:14px 16px;background:#fff;border:1px solid #d5d9e0;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.22);font-size:0.95rem;';
    var text = document.createElement('p');
    text.style.margin = '0 0 10px';
    var who = ringing.fromEmail || t('Someone');
    text.textContent = ringing.mode === 'stream' ? t('{email} wants to show you a live stream. Your camera stays off.', { email: who }) : t('{email} is calling you (video call).', { email: who });
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';
    row.appendChild(button(t('Accept'), true, function () {
      try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(ringing)); } catch (e) { /* the call page will say the call is gone */ }
      location.href = '/call';
    }));
    row.appendChild(button(t('Decline'), false, function () {
      client.send('call.reject', { callId: ringing.callId, to: ringing.from, payload: { reason: 'declined' } });
      hide();
    }));
    box.appendChild(text);
    box.appendChild(row);
    document.body.appendChild(box);
    timer = setTimeout(hide, Protocol.RING_TIMEOUT_MS + 5000); // the caller gave up; its cancel normally arrives first
  });
  client.on('call.cancel', function (message) { if (ringing && message.callId === ringing.callId) hide(); });
  client.on('call.end', function (message) { if (ringing && message.callId === ringing.callId) hide(); });
  window.addEventListener('online', function () { client.reconnectNow(); });
  client.connect();
})();
