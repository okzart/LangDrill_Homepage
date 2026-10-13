// Presentation layer for /schedule - a calendar of video calls two users
// have agreed on (Authentication's /meetings API, through the gateway's
// /api/meetings). One picks a time slot and invites the other; once
// accepted it is on both calendars, and when its time comes both are told
// (a message from the service, and a pop-up on whatever page they are on -
// src/public/schedule/reminder.js).
//
// The page draws the calendar in the browser (src/public/schedule/
// schedule.js): times are stored in UTC and only the browser knows the
// user's time zone. So besides the page itself, everything here is JSON for
// that script - { error } on failure, 401 included.
//
//   GET  /schedule                  the page (?with=<userId> preselects who)
//   GET  /schedule/data?from=&to=   my meetings in that range, and my friends
//   GET  /schedule/upcoming         agreed calls from now to a day ahead (reminder.js)
//   POST /schedule                  { with, startAt, durationMinutes, note } - invite
//   POST /schedule/:id/accept | /decline | /cancel
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');
const Avatar = require('../services/avatar');

class ScheduleRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/schedule', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.get('/schedule/data', AsyncHandler.wrap(this.data.bind(this)));
    this.router.get('/schedule/upcoming', AsyncHandler.wrap(this.upcoming.bind(this)));
    this.router.post('/schedule', AsyncHandler.wrap(this.create.bind(this)));
    this.router.post('/schedule/:id/accept', this.action((req) => this.gatewayClient.post(`/api/meetings/${encodeURIComponent(req.params.id)}/accept`, undefined, req.auth.token)));
    this.router.post('/schedule/:id/decline', this.action((req) => this.gatewayClient.post(`/api/meetings/${encodeURIComponent(req.params.id)}/decline`, undefined, req.auth.token)));
    this.router.post('/schedule/:id/cancel', this.action((req) => this.gatewayClient.delete(`/api/meetings/${encodeURIComponent(req.params.id)}`, req.auth.token)));
  }

  // A meeting for the page: the other person's image as an address on this site.
  static forPage(meeting) {
    return { ...meeting, with: meeting.with ? { ...meeting.with, avatar: Avatar.siteUrl(meeting.with.avatarUrl) } : null };
  }

  // Someone opened "Schedule a call" on a person's profile: that person is
  // offered in the "with" box even if they aren't a friend.
  async show(req, res) {
    let preselect = null;
    const withId = typeof req.query.with === 'string' ? req.query.with : '';
    if (withId && withId !== req.auth.user.sub) {
      preselect = await this.gatewayClient.get(`/api/auth/users/${encodeURIComponent(withId)}`, req.auth.token)
        .then((user) => ({ id: user.id, displayName: user.displayName }), () => null);
    }
    res.render('schedule', { preselect });
  }

  fail(req, res, err) {
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: req.t('The schedule is unavailable right now.') });
    }
    if (err.status === 401) Session.clearToken(res);
    const down = err.status === 502 || err.status === 504;
    res.status(err.status).json({ error: down ? req.t('The schedule is unavailable right now.') : req.t(err.message) });
  }

  async data(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    res.set('Cache-Control', 'no-store');
    const range = new URLSearchParams();
    for (const key of ['from', 'to']) if (typeof req.query[key] === 'string') range.set(key, req.query[key]);
    try {
      const [calendar, friends] = await Promise.all([
        this.gatewayClient.get(`/api/meetings${range.toString() ? `?${range}` : ''}`, req.auth.token),
        // Who can be picked from a list; without it one can still invite from a profile.
        this.gatewayClient.get('/api/friends', req.auth.token).catch(() => ({ friends: [] })),
      ]);
      res.json({
        meetings: (calendar.meetings || []).map(ScheduleRoutes.forPage),
        durations: calendar.durations || [30],
        friends: (friends.friends || []).map((f) => ({ id: f.id, displayName: f.displayName || f.email })),
      });
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  // Asked by a script on every page: must never be an error, only "nothing".
  async upcoming(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.auth) return res.json({ meetings: [] });
    try {
      const now = Date.now();
      // From a while back, so a call that started before this page loaded still shows.
      const range = new URLSearchParams({ from: new Date(now - 3 * 3600 * 1000).toISOString(), to: new Date(now + 24 * 3600 * 1000).toISOString() });
      const calendar = await this.gatewayClient.get(`/api/meetings?${range}`, req.auth.token);
      res.json({ meetings: (calendar.meetings || []).filter((m) => m.status === 'accepted').map(ScheduleRoutes.forPage) });
    } catch {
      res.json({ meetings: [] });
    }
  }

  async create(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const { startAt, durationMinutes, note } = req.body || {};
    try {
      const meeting = await this.gatewayClient.post('/api/meetings', { with: req.body?.with, startAt, durationMinutes, note }, req.auth.token);
      res.status(201).json({ meeting: ScheduleRoutes.forPage(meeting) });
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  action(call) {
    return AsyncHandler.wrap(async (req, res) => {
      if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
      try {
        res.json({ meeting: ScheduleRoutes.forPage(await call(req)) });
      } catch (err) {
        this.fail(req, res, err);
      }
    });
  }
}

module.exports = ScheduleRoutes;
