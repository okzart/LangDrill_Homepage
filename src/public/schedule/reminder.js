// "It's time for your call": shows a small dialog, on whatever page of the
// site the user is on, at the moment a video call they agreed to is due to
// start. (The service also leaves both people a message at that moment -
// this is the part that catches the eye.) Loaded from _nav.pug.
//
// One request per page load for the agreed calls of the next day
// (GET /schedule/upcoming); a timer does the rest. Each call is announced
// once per browser, remembered in localStorage so a reload doesn't repeat it.
(function () {
  'use strict';
  var t = window.t, LOCALE = window.LD_LANG === 'ko' ? 'ko-KR' : 'en-US';
  var KEY = 'ld_meeting_announced';
  var MAX_TIMER_MS = 2147483647;

  function announced() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function remember(id) {
    try {
      var seen = announced(), cutoff = Date.now() - 3 * 24 * 3600 * 1000;
      Object.keys(seen).forEach(function (key) { if (seen[key] < cutoff) delete seen[key]; });
      seen[id] = Date.now();
      localStorage.setItem(KEY, JSON.stringify(seen));
    } catch (e) { /* shown again on the next page, at worst */ }
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

  function show(meeting) {
    if (announced()[meeting.id] || new Date(meeting.endAt) <= new Date()) return;
    remember(meeting.id);
    var name = meeting.with ? meeting.with.displayName : '';
    var callUrl = meeting.with && meeting.with.email ? '/call?email=' + encodeURIComponent(meeting.with.email) + '&start=call' : '/schedule';
    var box = document.createElement('div');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-live', 'assertive');
    box.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:1000;width:min(26rem,calc(100vw - 32px));padding:16px 18px;background:#fff;border:1px solid #d5d9e0;border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,0.28);font-size:0.95rem;';
    var title = document.createElement('p');
    title.style.cssText = 'margin:0 0 4px;font-weight:700;font-size:1.05rem;';
    title.textContent = t('It\'s time for your video call with {name}.', { name: name });
    var detail = document.createElement('p');
    detail.style.cssText = 'margin:0 0 12px;color:#555;';
    var start = new Date(meeting.startAt), end = new Date(meeting.endAt);
    var fmt = function (d) { return d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }); };
    // One side rings, the other answers - otherwise both would call at once
    // and find each other busy. The one who proposed the call rings.
    detail.textContent = fmt(start) + ' - ' + fmt(end) + ' · ' + (meeting.mine
      ? t('Call them now.')
      : t('{name} will call you - stay on this site to answer. You can also call them yourself.', { name: name }));
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    row.appendChild(button(meeting.mine ? t('Start call') : t('Call them'), meeting.mine, function () { location.href = callUrl; }));
    row.appendChild(button(meeting.mine ? t('Later') : t('OK, I\'ll wait'), !meeting.mine, function () { box.remove(); }));
    box.appendChild(title);
    box.appendChild(detail);
    box.appendChild(row);
    document.body.appendChild(box);
  }

  fetch('/schedule/upcoming', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : { meetings: [] }; })
    .then(function (body) {
      (body.meetings || []).forEach(function (meeting) {
        var wait = new Date(meeting.startAt).getTime() - Date.now();
        if (wait <= 0) show(meeting); // it has started (and not ended): say so now
        else if (wait < MAX_TIMER_MS) setTimeout(function () { show(meeting); }, wait);
      });
    })
    .catch(function () {});
})();
