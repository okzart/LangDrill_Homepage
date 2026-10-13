// Presentation layer for /messages - the messages users leave each other
// (Authentication's /messages API, through the gateway's /api/messages). A
// message is plain text that waits for its recipient; everything two people
// wrote each other is one conversation. Anyone can write to anyone, from
// their profile page (/users/:id) or the friends list.
//
//   GET  /messages               my conversations, newest first
//   GET  /messages/unread        { count } - for the top bar's mark (fetch)
//   GET  /messages/:userId       the conversation with that person
//   GET  /messages/:userId/new   ?after=<time>: what arrived since, as JSON -
//                                the page polls this while it is open
//   POST /messages/:userId       leave them a message (form), back to the page
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');
const Avatar = require('../services/avatar');

class MessagesRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/messages', requireLogin, AsyncHandler.wrap(this.list.bind(this)));
    this.router.get('/messages/unread', AsyncHandler.wrap(this.unread.bind(this)));
    this.router.get('/messages/:userId', requireLogin, AsyncHandler.wrap(this.thread.bind(this)));
    this.router.get('/messages/:userId/new', AsyncHandler.wrap(this.newer.bind(this)));
    this.router.post('/messages/:userId', requireLogin, AsyncHandler.wrap(this.send.bind(this)));
  }

  async list(req, res) {
    const { conversations } = await this.gatewayClient.get('/api/messages', req.auth.token);
    res.render('messages', {
      conversations: (conversations || []).map((c) => ({ ...c, avatar: Avatar.siteUrl(c.user.avatarUrl) })),
    });
  }

  // Called by a script on every page, so it must never be an error page -
  // and never a reason to bother the user: any failure is simply "none".
  async unread(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.auth) return res.json({ count: 0 });
    try {
      res.json({ count: (await this.gatewayClient.get('/api/messages/unread', req.auth.token)).count || 0 });
    } catch {
      res.json({ count: 0 });
    }
  }

  async thread(req, res) {
    const { userId } = req.params;
    if (userId === req.auth.user.sub) return res.redirect('/messages');
    const before = typeof req.query.before === 'string' ? `?before=${encodeURIComponent(req.query.before)}` : '';
    const thread = await this.gatewayClient.get(`/api/messages/with/${encodeURIComponent(userId)}${before}`, req.auth.token);
    // An assignment arrives here as a notice and can be confirmed right in
    // the chat - but only while it is still waiting for that, which the
    // notice itself doesn't say.
    let waiting = new Set();
    if (thread.messages.some((m) => m.kind === 'assignment.new' && !m.mine)) {
      const received = await this.gatewayClient.get('/api/assignments?role=received', req.auth.token).catch(() => ({ assignments: [] }));
      waiting = new Set((received.assignments || []).filter((a) => a.status === 'assigned').map((a) => a.id));
    }
    res.render('message-thread', {
      person: { ...thread.user, avatar: Avatar.siteUrl(thread.user.avatarUrl) },
      messages: thread.messages.map((m) => (m.kind === 'assignment.new' && !m.mine && m.assignment && waiting.has(m.assignment.id) ? { ...m, canConfirm: true } : m)),
      hasMore: thread.hasMore,
      older: Boolean(before), // looking at an earlier page: no live updates there
      maxLength: 1000,
      draft: typeof req.query.draft === 'string' ? req.query.draft.slice(0, 1000) : '',
      error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
    });
  }

  // JSON for the open page's poll: { messages } newer than ?after=.
  async newer(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    try {
      const thread = await this.gatewayClient.get(`/api/messages/with/${encodeURIComponent(req.params.userId)}?after=${encodeURIComponent(after)}`, req.auth.token);
      res.json({ messages: thread.messages });
    } catch (err) {
      res.status(err instanceof GatewayError ? err.status : 502).json({ error: req.t('Messages are unavailable right now.') });
    }
  }

  async send(req, res) {
    const back = `/messages/${encodeURIComponent(req.params.userId)}`;
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    try {
      await this.gatewayClient.post('/api/messages', { to: req.params.userId, text }, req.auth.token);
      res.redirect(`${back}#latest`);
    } catch (err) {
      // What was typed comes back with the reason, so it isn't lost.
      if (err instanceof GatewayError && [400, 404, 429].includes(err.status)) {
        return res.redirect(`${back}?error=${encodeURIComponent(err.message)}&draft=${encodeURIComponent(text.slice(0, 1000))}#latest`);
      }
      throw err;
    }
  }
}

module.exports = MessagesRoutes;
