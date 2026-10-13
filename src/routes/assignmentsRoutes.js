// Presentation layer for /assignments - homework one user (acting as a
// teacher) gives a friend: a list of community drill sets, each to be done
// as a drill or listened to as flash cards (Authentication's /assignments
// API, through the gateway's /api/assignments). The student confirms it -
// from the chat, where the assignment arrives as a notice, or from its own
// page - and ticks the tasks off; the teacher watches the progress.
//
// Plain pages and forms that redirect, like routes/friendsRoutes.js.
//
//   GET  /assignments                      given to me, and given by me
//   GET  /assignments/new?to=<userId>      the form (friends and sets to pick)
//   POST /assignments                      give it
//   GET  /assignments/:id                  one assignment and its tasks
//   POST /assignments/:id/confirm          (student) "I've seen it"
//   POST /assignments/:id/tasks/:taskId    (student) done=1 | done=0
//   POST /assignments/:id/cancel           (teacher)
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');
const Avatar = require('../services/avatar');

// Only ever send someone back to a page of this site.
function safeBack(value, fallback) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

class AssignmentsRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/assignments', requireLogin, AsyncHandler.wrap(this.list.bind(this)));
    this.router.get('/assignments/new', requireLogin, AsyncHandler.wrap(this.showNew.bind(this)));
    this.router.post('/assignments', requireLogin, AsyncHandler.wrap(this.create.bind(this)));
    this.router.get('/assignments/:id', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/assignments/:id/confirm', requireLogin, AsyncHandler.wrap(this.confirm.bind(this)));
    this.router.post('/assignments/:id/tasks/:taskId', requireLogin, AsyncHandler.wrap(this.tick.bind(this)));
    this.router.post('/assignments/:id/cancel', requireLogin, AsyncHandler.wrap(this.cancel.bind(this)));
  }

  static forPage(assignment) {
    return { ...assignment, with: assignment.with ? { ...assignment.with, avatar: Avatar.siteUrl(assignment.with.avatarUrl) } : null };
  }

  async list(req, res) {
    const { assignments } = await this.gatewayClient.get('/api/assignments', req.auth.token);
    const all = (assignments || []).map(AssignmentsRoutes.forPage);
    res.render('assignments', {
      received: all.filter((a) => !a.mine),
      given: all.filter((a) => a.mine),
      done: ['cancelled'].includes(req.query.done) ? req.query.done : null,
    });
  }

  // What the form needs: the friends who can be given work, and the
  // community sets it can be made of. `values` refills it after an error.
  async renderNew(req, res, { status = 200, error = null, values = {} } = {}) {
    const [friends, sets] = await Promise.all([
      this.gatewayClient.get('/api/friends', req.auth.token),
      this.gatewayClient.get('/api/sets', req.auth.token),
    ]);
    res.status(status).render('assignment-new', {
      friends: (friends.friends || []).map((f) => ({ id: f.id, displayName: f.displayName || f.email })),
      sets: (sets || []).map((s) => ({ id: s.id, name: s.name, type: s.type, author: s.author, count: s.count })),
      error,
      values: { student: '', title: '', note: '', dueLocal: '', drill: [], cards: [], ...values },
    });
  }

  async showNew(req, res) {
    await this.renderNew(req, res, { values: { student: typeof req.query.to === 'string' ? req.query.to : '' } });
  }

  async create(req, res) {
    const body = req.body || {};
    const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
    const values = {
      student: String(body.student || ''),
      title: String(body.title || ''),
      note: String(body.note || ''),
      dueLocal: String(body.dueLocal || ''),
      drill: list(body.drill),
      cards: list(body.cards),
    };
    // Tasks name sets by id; their names and types are taken from Content
    // Sharing here, not from the form, so an assignment can't mislabel a set.
    const sets = new Map(((await this.gatewayClient.get('/api/sets', req.auth.token)) || []).map((s) => [s.id, s]));
    const tasks = [];
    for (const [activity, ids] of [['drill', values.drill], ['cards', values.cards]]) {
      for (const id of ids) {
        const set = sets.get(id);
        if (set) tasks.push({ setId: set.id, setName: set.name, setType: set.type, activity });
      }
    }
    try {
      const made = await this.gatewayClient.post(
        '/api/assignments',
        { student: values.student, title: values.title, note: values.note, dueAt: typeof body.dueAt === 'string' && body.dueAt ? body.dueAt : null, tasks },
        req.auth.token
      );
      res.redirect(`/assignments/${encodeURIComponent(made.id)}?done=given`);
    } catch (err) {
      if (err instanceof GatewayError && [400, 403, 404].includes(err.status)) {
        return this.renderNew(req, res, { status: err.status, error: err.message, values });
      }
      throw err;
    }
  }

  async show(req, res) {
    const assignment = await this.gatewayClient.get(`/api/assignments/${encodeURIComponent(req.params.id)}`, req.auth.token);
    res.render('assignment', {
      a: AssignmentsRoutes.forPage(assignment),
      done: ['given', 'confirmed'].includes(req.query.done) ? req.query.done : null,
      error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    });
  }

  // Runs one change and goes back to the assignment (or, for a confirmation
  // made in the chat, to the chat) - with the service's refusal, if any.
  async change(req, res, call, back, doneCode) {
    try {
      await call();
      res.redirect(doneCode ? `${back}${back.includes('?') ? '&' : '?'}done=${doneCode}` : back);
    } catch (err) {
      if (err instanceof GatewayError && [400, 403, 404, 409].includes(err.status)) {
        return res.redirect(`/assignments/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async confirm(req, res) {
    const page = `/assignments/${encodeURIComponent(req.params.id)}`;
    const back = safeBack(req.body?.back, page);
    await this.change(req, res, () => this.gatewayClient.post(`/api/assignments/${encodeURIComponent(req.params.id)}/confirm`, undefined, req.auth.token), back, back === page ? 'confirmed' : null);
  }

  async tick(req, res) {
    const page = `/assignments/${encodeURIComponent(req.params.id)}`;
    await this.change(req, res, () => this.gatewayClient.post(
      `/api/assignments/${encodeURIComponent(req.params.id)}/tasks/${encodeURIComponent(req.params.taskId)}`,
      { done: req.body?.done !== '0' },
      req.auth.token
    ), page, null);
  }

  async cancel(req, res) {
    await this.change(req, res, () => this.gatewayClient.delete(`/api/assignments/${encodeURIComponent(req.params.id)}`, req.auth.token), '/assignments', 'cancelled');
  }
}

module.exports = AssignmentsRoutes;
