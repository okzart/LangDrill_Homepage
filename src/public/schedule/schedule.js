// The /schedule page: a month calendar of video calls arranged with other
// users, the time-slot picker and invitation form for a chosen day, and the
// lists of invitations and upcoming calls. All times are kept in UTC by the
// server and shown here in the browser's own time zone.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var t = window.t, LOCALE = window.LD_LANG === 'ko' ? 'ko-KR' : 'en-US';
  var SLOT_MINUTES = 30;
  var FIRST_SLOT_HOUR = 6; // slots offered from 06:00 to 23:30
  var errorBox = $('sched-error'), infoBox = $('sched-info');

  var month = startOfMonth(new Date()); // the month on show
  var monthMeetings = []; // what the grid shows
  var upcoming = []; // what the lists show (from a day ago on)
  var durations = [30];
  var selectedDay = null; // Date at local midnight
  var selectedStart = null; // Date
  var preselected = $('invite-with').options.length ? { id: $('invite-with').value, name: $('invite-with').options[0].textContent } : null;

  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; infoBox.hidden = true; errorBox.scrollIntoView({ block: 'nearest' }); }
  function showInfo(message) { infoBox.textContent = message; infoBox.hidden = false; errorBox.hidden = true; }
  function clearMessages() { errorBox.hidden = true; infoBox.hidden = true; }

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function timeText(d) { return d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }); }
  function dayText(d) { return d.toLocaleDateString(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' }); }
  function whenText(m) {
    var start = new Date(m.startAt), end = new Date(m.endAt);
    return start.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + timeText(start) + ' - ' + timeText(end);
  }
  // A meeting still on the calendar (asked for or agreed).
  function live(m) { return m.status === 'pending' || m.status === 'accepted'; }

  function call(url, options) {
    return fetch(url, options).then(function (res) {
      if (res.status === 401) { location.href = '/login?next=/schedule'; throw new Error(t('Not logged in')); }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || t('Something went wrong.'));
        return body;
      });
    });
  }

  // ---- Loading -----------------------------------------------------------------

  // The six weeks the grid shows for `month`, as [first day, day after the last].
  function gridRange() {
    var first = addDays(month, -month.getDay());
    return [first, addDays(first, 42)];
  }

  function loadMonth() {
    var range = gridRange();
    return call('/schedule/data?from=' + encodeURIComponent(range[0].toISOString()) + '&to=' + encodeURIComponent(range[1].toISOString()))
      .then(function (data) {
        monthMeetings = data.meetings;
        durations = data.durations;
        fillChoices(data.friends);
        renderCalendar();
        renderDay();
      });
  }

  function loadUpcoming() {
    return call('/schedule/data').then(function (data) {
      upcoming = data.meetings;
      renderLists();
    });
  }

  function reload() {
    return Promise.all([loadMonth(), loadUpcoming()]).catch(function (err) { showError(err.message); });
  }

  // Who can be invited (friends, plus anyone the page was opened for) and for how long.
  var choicesFilled = false;
  function fillChoices(friends) {
    if (choicesFilled) return;
    choicesFilled = true;
    var who = $('invite-with');
    friends.forEach(function (friend) {
      if (preselected && preselected.id === friend.id) return;
      var option = document.createElement('option');
      option.value = friend.id;
      option.textContent = friend.displayName;
      who.appendChild(option);
    });
    if (!who.options.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = t('No friends yet - add one, or open a user\'s profile');
      who.appendChild(none);
    }
    var minutes = $('invite-minutes');
    durations.forEach(function (n) {
      var option = document.createElement('option');
      option.value = String(n);
      option.textContent = t('{n} minutes', { n: n });
      if (n === 30) option.selected = true;
      minutes.appendChild(option);
    });
  }

  // ---- Calendar ------------------------------------------------------------------

  function renderCalendar() {
    var grid = $('cal'), today = startOfDay(new Date()), range = gridRange();
    $('cal-title').textContent = month.toLocaleDateString(LOCALE, { year: 'numeric', month: 'long' });
    grid.innerHTML = '';
    for (var w = 0; w < 7; w++) {
      var head = document.createElement('div');
      head.className = 'dow';
      head.textContent = addDays(range[0], w).toLocaleDateString(LOCALE, { weekday: 'short' });
      grid.appendChild(head);
    }
    for (var i = 0; i < 42; i++) {
      (function (day) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'day' + (day.getMonth() !== month.getMonth() ? ' other' : '') + (day < today ? ' past' : '') +
          (sameDay(day, today) ? ' today' : '') + (selectedDay && sameDay(day, selectedDay) ? ' selected' : '');
        var num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(day.getDate());
        cell.appendChild(num);
        var events = monthMeetings.filter(function (m) { return live(m) && sameDay(new Date(m.startAt), day); });
        events.slice(0, 3).forEach(function (m) {
          var ev = document.createElement('span');
          ev.className = 'ev' + (m.status === 'pending' ? ' pending' : '');
          ev.textContent = timeText(new Date(m.startAt)) + ' ' + (m.with ? m.with.displayName : '');
          cell.appendChild(ev);
        });
        if (events.length > 3) {
          var more = document.createElement('span');
          more.className = 'ev pending';
          more.textContent = t('+{n} more', { n: events.length - 3 });
          cell.appendChild(more);
        }
        cell.setAttribute('aria-label', dayText(day) + (events.length ? ' - ' + t('{n} calls', { n: events.length }) : ''));
        cell.addEventListener('click', function () { selectDay(day); });
        grid.appendChild(cell);
      })(addDays(range[0], i));
    }
  }

  $('cal-prev').addEventListener('click', function () { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); loadMonth().catch(function (err) { showError(err.message); }); });
  $('cal-next').addEventListener('click', function () { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); loadMonth().catch(function (err) { showError(err.message); }); });
  $('cal-today').addEventListener('click', function () {
    month = startOfMonth(new Date());
    selectedDay = startOfDay(new Date());
    selectedStart = null;
    loadMonth().catch(function (err) { showError(err.message); });
  });

  function selectDay(day) {
    clearMessages();
    selectedDay = day;
    selectedStart = null;
    if (day.getMonth() !== month.getMonth() || day.getFullYear() !== month.getFullYear()) {
      month = startOfMonth(day);
      loadMonth().catch(function (err) { showError(err.message); });
      return;
    }
    renderCalendar();
    renderDay();
  }

  // ---- The chosen day: its calls, and the slots still free -------------------------

  // Whether [start, end) runs into a call that keeps me busy: one that was
  // agreed, or one I proposed and am waiting on.
  function busy(start, end) {
    return monthMeetings.some(function (m) {
      var holds = m.status === 'accepted' || (m.status === 'pending' && m.mine);
      return holds && new Date(m.startAt) < end && new Date(m.endAt) > start;
    });
  }

  function renderDay() {
    var list = $('day-list'), box = $('slot-box');
    list.innerHTML = '';
    if (!selectedDay) { box.hidden = true; return; }
    $('day-title').textContent = dayText(selectedDay);
    var todays = monthMeetings.filter(function (m) { return live(m) && sameDay(new Date(m.startAt), selectedDay); });
    if (todays.length) {
      var ul = document.createElement('ul');
      ul.className = 'meet';
      todays.forEach(function (m) { ul.appendChild(meetingRow(m)); });
      list.appendChild(ul);
    }
    var dayOver = addDays(selectedDay, 1) <= new Date();
    box.hidden = dayOver;
    if (dayOver) {
      if (!todays.length) list.appendChild(emptyNote(t('Nothing was scheduled that day.')));
      return;
    }
    renderSlots();
  }

  function renderSlots() {
    var slots = $('slots'), now = new Date(), minutes = Number($('invite-minutes').value) || 30;
    slots.innerHTML = '';
    for (var mins = FIRST_SLOT_HOUR * 60; mins < 24 * 60; mins += SLOT_MINUTES) {
      (function (start) {
        var end = new Date(start.getTime() + minutes * 60000);
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = timeText(start);
        var taken = busy(start, end);
        button.disabled = start <= now || taken;
        if (taken) { button.className = 'busy'; button.title = t('You already have a call then'); }
        if (selectedStart && selectedStart.getTime() === start.getTime() && !button.disabled) button.className = 'on';
        button.addEventListener('click', function () { selectedStart = start; renderSlots(); });
        slots.appendChild(button);
      })(new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate(), 0, mins));
    }
    // A slot picked for a shorter call may no longer fit a longer one.
    if (selectedStart && busy(selectedStart, new Date(selectedStart.getTime() + minutes * 60000))) selectedStart = null;
    $('tz-note').textContent = t('Times are in your time zone ({zone}). The other person sees them in theirs.', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local' });
    var ready = !!selectedStart && !!$('invite-with').value;
    $('invite-send').disabled = !ready;
    $('invite-summary').textContent = selectedStart
      ? dayText(selectedStart) + ' · ' + timeText(selectedStart) + ' - ' + timeText(new Date(selectedStart.getTime() + minutes * 60000))
      : t('Pick a start time.');
  }
  $('invite-minutes').addEventListener('change', renderSlots);
  $('invite-with').addEventListener('change', renderSlots);

  $('invite-send').addEventListener('click', function () {
    if (!selectedStart) return;
    clearMessages();
    var button = $('invite-send'), who = $('invite-with');
    var name = who.options[who.selectedIndex].textContent;
    button.disabled = true;
    call('/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ with: who.value, startAt: selectedStart.toISOString(), durationMinutes: Number($('invite-minutes').value), note: $('invite-note').value }),
    })
      .then(function () {
        selectedStart = null;
        $('invite-note').value = '';
        showInfo(t('Invitation sent to {name}. It is on your calendar as soon as they accept.', { name: name }));
        return reload();
      })
      .catch(function (err) { showError(err.message); renderSlots(); });
  });

  // ---- Lists ----------------------------------------------------------------------

  function emptyNote(text) {
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    return p;
  }

  function act(label, primary, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.addEventListener('click', onClick);
    return button;
  }

  function change(m, what, done) {
    clearMessages();
    call('/schedule/' + encodeURIComponent(m.id) + '/' + what, { method: 'POST' })
      .then(function () { showInfo(done); return reload(); })
      .catch(function (err) { showError(err.message); reload(); });
  }

  // One meeting, with the actions that fit it.
  function meetingRow(m) {
    var li = document.createElement('li'), name = m.with ? m.with.displayName : '?', now = new Date();
    var when = document.createElement('div');
    when.className = 'when';
    when.textContent = whenText(m);
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.status === 'accepted' ? t('agreed') : m.mine ? t('waiting for their answer') : t('needs your answer');
    when.appendChild(tag);
    var who = document.createElement('div');
    who.className = 'who';
    var link = document.createElement('a');
    link.href = '/users/' + encodeURIComponent(m.with ? m.with.id : '');
    link.textContent = name;
    who.appendChild(document.createTextNode(t('with') + ' '));
    who.appendChild(link);
    li.appendChild(when);
    li.appendChild(who);
    if (m.note) {
      var note = document.createElement('div');
      note.className = 'note';
      note.textContent = m.note;
      li.appendChild(note);
    }
    var acts = document.createElement('div');
    acts.className = 'acts';
    var over = new Date(m.endAt) <= now;
    if (m.status === 'pending' && !m.mine && !over) {
      acts.appendChild(act(t('Accept'), true, function () { change(m, 'accept', t('Accepted. The call is on your calendar.')); }));
      acts.appendChild(act(t('Decline'), false, function () { change(m, 'decline', t('Invitation declined.')); }));
    } else if (!over) {
      // Around its time an agreed call can be started from here.
      if (m.status === 'accepted' && m.with && m.with.email && new Date(m.startAt).getTime() - now.getTime() < 10 * 60000) {
        var start = document.createElement('a');
        start.className = 'btn';
        start.href = '/call?email=' + encodeURIComponent(m.with.email) + '&start=call';
        start.textContent = t('Start call');
        acts.appendChild(start);
      }
      acts.appendChild(act(m.status === 'pending' ? t('Withdraw') : t('Cancel call'), false, function () {
        if (m.status === 'accepted' && !confirm(t('Cancel the call with {name}?', { name: name }))) return;
        change(m, 'cancel', m.status === 'pending' ? t('Invitation withdrawn.') : t('Call cancelled.'));
      }));
    }
    if (acts.children.length) li.appendChild(acts);
    return li;
  }

  function fill(listId, meetings, emptyText) {
    var list = $(listId);
    list.innerHTML = '';
    if (!meetings.length) { var li = document.createElement('li'); li.appendChild(emptyNote(emptyText)); list.appendChild(li); return; }
    meetings.forEach(function (m) { list.appendChild(meetingRow(m)); });
  }

  function renderLists() {
    var now = new Date();
    var ahead = upcoming.filter(function (m) { return new Date(m.endAt) > now; });
    fill('list-incoming', ahead.filter(function (m) { return m.status === 'pending' && !m.mine; }), t('No invitations waiting for you.'));
    fill('list-upcoming', ahead.filter(function (m) { return m.status === 'accepted'; }), t('No calls scheduled yet.'));
    fill('list-outgoing', ahead.filter(function (m) { return m.status === 'pending' && m.mine; }), t('Nothing waiting.'));
  }

  // The page was opened for one person ("Schedule a call" on their profile):
  // go straight to choosing a time today.
  if (preselected) selectedDay = startOfDay(new Date());
  reload();
  // Keep "Start call" buttons and past slots honest while the page stays open.
  setInterval(function () { renderLists(); if (selectedDay) renderDay(); }, 60000);
})();
