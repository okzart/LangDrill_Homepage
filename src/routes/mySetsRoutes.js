// Presentation layer for /my-sets - the drill sets the user published, in
// one place to manage them: sort them into folders, filter and sort them,
// open or edit one, make them private or public, or delete them - one at a
// time or several at once.
//
// Folders are the owner's own way of organizing their sets: nobody else sees
// them, and they change nothing about who can see a set. They nest (up to 5
// levels); deleting one moves its sets and subfolders up a level.
//
//   GET  /my-sets?folder=<id>|none     the page (every set the user owns, private ones too)
//   POST /my-sets/bulk                 { action: "private" | "public" | "delete" | "move", ids, folderId? }
//   POST /my-sets/one                  { one: "<action>:<id>" } - a row's own button (the
//                                      rows sit inside the bulk form, so ticked boxes are ignored)
//   POST /my-sets/folders              { name, parentId? } - a new folder (a subfolder with parentId)
//   POST /my-sets/folders/:id/rename   { name }
//   POST /my-sets/folders/:id/delete
// Every POST goes back to the page, to the folder it came from (`folder`).
//
// Content Sharing decides everything (GET /api/sets?mine=1 lists only the
// caller's sets; PATCH, DELETE and /api/sets/folders are owner-only), so this
// only relays.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');

const ACTIONS = ['private', 'public', 'delete', 'move'];
const NOTICES = [...ACTIONS, 'folder-created', 'folder-renamed', 'folder-deleted'];
const MAX_BULK = 200;

class MySetsRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/my-sets', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post('/my-sets/bulk', requireLogin, AsyncHandler.wrap((req, res) => this.run(req, res, req.body?.action, req.body?.ids)));
    this.router.post('/my-sets/one', requireLogin, AsyncHandler.wrap((req, res) => {
      const [action, ...rest] = String(req.body?.one || '').split(':');
      return this.run(req, res, action, rest.join(':'));
    }));
    this.router.post('/my-sets/folders', requireLogin, AsyncHandler.wrap(this.createFolder.bind(this)));
    this.router.post('/my-sets/folders/:id/rename', requireLogin, AsyncHandler.wrap(this.renameFolder.bind(this)));
    this.router.post('/my-sets/folders/:id/delete', requireLogin, AsyncHandler.wrap(this.deleteFolder.bind(this)));
  }

  async show(req, res) {
    const [sets, folders] = await Promise.all([
      this.gatewayClient.get('/api/sets?mine=1', req.auth.token),
      this.gatewayClient.get('/api/sets/folders', req.auth.token),
    ]);
    const folderIds = new Set((folders || []).map((f) => f.id));
    const rows = (sets || []).map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc || '',
      type: s.type,
      count: s.count || 0,
      downloads: s.downloads || 0,
      sharedAt: s.sharedAt || 0,
      visibility: s.visibility === 'private' ? 'private' : 'public',
      sharedWith: Array.isArray(s.sharedWith) ? s.sharedWith.length : 0,
      folderId: folderIds.has(s.folderId) ? s.folderId : '',
    }));
    const wanted = typeof req.query.folder === 'string' ? req.query.folder : '';
    const notice = NOTICES.includes(req.query.done) ? req.query.done : null;
    res.render('my-sets', {
      rows,
      folders: folders || [],
      folder: wanted === 'none' || folderIds.has(wanted) ? wanted : '',
      totals: {
        sets: rows.length,
        items: rows.reduce((sum, r) => sum + r.count, 0),
        downloads: rows.reduce((sum, r) => sum + r.downloads, 0),
        private: rows.filter((r) => r.visibility === 'private').length,
      },
      result: notice ? { action: notice, n: Number(req.query.n) || 0, failed: Number(req.query.failed) || 0 } : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    });
  }

  // Back to the page, on the folder the form was sent from (and the page of
  // the list it was on, when staying on that folder), with `query`.
  static back(req, res, query, folder = req.body?.folder) {
    const params = new URLSearchParams(query);
    if (typeof folder === 'string' && folder) params.set('folder', folder);
    const page = parseInt(req.body?.page, 10);
    if (folder === req.body?.folder && page > 1) params.set('page', String(page));
    res.redirect(`/my-sets?${params}`);
  }

  // A refusal Content Sharing explains (a bad or duplicate name, a missing
  // folder) is shown on the page; anything else is a real error.
  static refused(err) {
    return err instanceof GatewayError && [400, 404].includes(err.status);
  }

  // One action on every ticked set. Moving is one request; the others are
  // one per set (Content Sharing has no bulk call) - a set that fails is
  // counted and the rest carry on.
  async run(req, res, action, idList) {
    const ids = [...new Set([].concat(idList || []).map(String).filter(Boolean))].slice(0, MAX_BULK);
    if (!ACTIONS.includes(action) || ids.length === 0) return MySetsRoutes.back(req, res, {});
    if (action === 'move') {
      const folderId = typeof req.body?.folderId === 'string' && req.body.folderId ? req.body.folderId : null;
      try {
        const { moved } = await this.gatewayClient.post('/api/sets/folders/move', { ids, folderId }, req.auth.token);
        return MySetsRoutes.back(req, res, { done: 'move', n: moved, failed: ids.length - moved });
      } catch (err) {
        if (!MySetsRoutes.refused(err)) throw err;
        return MySetsRoutes.back(req, res, { error: err.message });
      }
    }
    let n = 0;
    let failed = 0;
    for (const id of ids) {
      const path = `/api/sets/${encodeURIComponent(id)}`;
      try {
        if (action === 'delete') await this.gatewayClient.delete(path, req.auth.token);
        else await this.gatewayClient.patch(path, { visibility: action }, req.auth.token);
        n++;
      } catch (err) {
        if (!(err instanceof GatewayError) || err.status === 401) throw err;
        failed++;
      }
    }
    MySetsRoutes.back(req, res, { done: action, n, failed });
  }

  async createFolder(req, res) {
    try {
      const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
      const folder = await this.gatewayClient.post('/api/sets/folders', { name: req.body?.name, parentId }, req.auth.token);
      MySetsRoutes.back(req, res, { done: 'folder-created' }, folder.id);
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      MySetsRoutes.back(req, res, { error: err.message });
    }
  }

  async renameFolder(req, res) {
    const id = req.params.id;
    try {
      await this.gatewayClient.patch(`/api/sets/folders/${encodeURIComponent(id)}`, { name: req.body?.name }, req.auth.token);
      MySetsRoutes.back(req, res, { done: 'folder-renamed' }, id);
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      MySetsRoutes.back(req, res, { error: err.message }, id);
    }
  }

  // Back on the parent folder (`folder` from the page), where the deleted
  // folder's sets and subfolders now are.
  async deleteFolder(req, res) {
    try {
      const { unfiled } = await this.gatewayClient.delete(`/api/sets/folders/${encodeURIComponent(req.params.id)}`, req.auth.token);
      MySetsRoutes.back(req, res, { done: 'folder-deleted', n: unfiled });
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      MySetsRoutes.back(req, res, { error: err.message }, '');
    }
  }
}

module.exports = MySetsRoutes;
