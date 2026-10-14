// Presentation layer for the two "manage your sets" pages, built from one
// class (one instance per mode) and one view (views/my-sets.pug):
//
//   /my-sets      "My sets" - the drill sets the user published: sort them
//                 into folders, filter and sort them, open or edit one, make
//                 them private or public, or delete them.
//   /shared-sets  "Shared with me" - the private sets friends shared with
//                 the user: sort them into folders, filter and sort them,
//                 open or download one, copy it into their own sets, or take
//                 it off their list.
// Everything works on one set at a time or several at once.
//
// Folders are the user's own way of organizing (two separate trees, one per
// page): nobody else sees them, and they change nothing about who can see a
// set. They nest (up to 5 levels); deleting one moves its sets and
// subfolders up a level.
//
// For each page (<base> = /my-sets or /shared-sets):
//   GET  <base>?folder=<id>|none&page=<n>  the page
//   POST <base>/bulk                       { action, ids, folderId? } - my sets: "private" |
//                                          "public" | "lock-copy" | "allow-copy" | "delete" | "move";
//                                          shared: "copy" | "leave" | "move"
//   POST <base>/one                        { one: "<action>:<id>" } - a row's own button (the
//                                          rows sit inside the bulk form, so ticked boxes are ignored)
//   POST <base>/folders                    { name, parentId? } - a new folder (a subfolder with parentId)
//   POST <base>/folders/:id/rename         { name }
//   POST <base>/folders/:id/delete
// Every POST goes back to the page, to the folder (and list page) it came from.
//
// Content Sharing decides everything (GET /api/sets?mine=1 / ?shared=1 list
// only the caller's own / shared-with-them sets; PATCH and DELETE are
// owner-only; a person can only take themselves off a share; folders are the
// caller's own), so this only relays.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Avatar = require('../services/avatar');
const { GatewayError } = require('../errors');

const MAX_BULK = 200;
const FOLDER_NOTICES = ['folder-created', 'folder-renamed', 'folder-deleted'];

// What differs between the two pages.
const MODES = {
  mine: {
    base: '/my-sets',
    list: '/api/sets?mine=1',
    scope: 'mine',
    actions: ['private', 'public', 'lock-copy', 'allow-copy', 'delete', 'move'],
  },
  shared: {
    base: '/shared-sets',
    list: '/api/sets?shared=1',
    scope: 'shared',
    actions: ['copy', 'leave', 'move'],
  },
};

class MySetsRoutes {
  constructor(gatewayClient, mode = 'mine') {
    this.gatewayClient = gatewayClient;
    this.mode = mode;
    this.config = MODES[mode];
    this.router = express.Router();
    const base = this.config.base;

    this.router.get(base, requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.post(`${base}/bulk`, requireLogin, AsyncHandler.wrap((req, res) => this.run(req, res, req.body?.action, req.body?.ids)));
    this.router.post(`${base}/one`, requireLogin, AsyncHandler.wrap((req, res) => {
      const [action, ...rest] = String(req.body?.one || '').split(':');
      return this.run(req, res, action, rest.join(':'));
    }));
    this.router.post(`${base}/folders`, requireLogin, AsyncHandler.wrap(this.createFolder.bind(this)));
    this.router.post(`${base}/folders/:id/rename`, requireLogin, AsyncHandler.wrap(this.renameFolder.bind(this)));
    this.router.post(`${base}/folders/:id/delete`, requireLogin, AsyncHandler.wrap(this.deleteFolder.bind(this)));
  }

  async show(req, res) {
    const token = req.auth.token;
    const [listed, folders] = await Promise.all([
      this.gatewayClient.get(this.config.list, token),
      this.gatewayClient.get(`/api/sets/folders?scope=${this.config.scope}`, token),
    ]);
    // On "Shared with me" each row shows who shared it, with their picture.
    const sets = this.mode === 'shared' ? await Avatar.withAuthorAvatars(this.gatewayClient, token, listed || []) : listed || [];
    const folderIds = new Set((folders || []).map((f) => f.id));
    const rows = sets.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc || '',
      type: s.type,
      count: s.count || 0,
      downloads: s.downloads || 0,
      sharedAt: s.sharedAt || 0,
      visibility: s.visibility === 'private' ? 'private' : 'public',
      allowCopy: s.allowCopy !== false,
      sharedWith: Array.isArray(s.sharedWith) ? s.sharedWith.length : 0,
      folderId: folderIds.has(s.folderId) ? s.folderId : '',
      author: s.author || '',
      authorId: s.authorId || '',
      authorAvatar: s.authorAvatar || null,
    }));
    const wanted = typeof req.query.folder === 'string' ? req.query.folder : '';
    const notice = [...this.config.actions, ...FOLDER_NOTICES].includes(req.query.done) ? req.query.done : null;
    // "From" filter on "Shared with me": the people who shared sets, by name.
    const people = [...new Map(rows.filter((r) => r.authorId).map((r) => [r.authorId, r.author])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.render('my-sets', {
      mode: this.mode,
      base: this.config.base,
      rows,
      people,
      folders: folders || [],
      folder: wanted === 'none' || folderIds.has(wanted) ? wanted : '',
      totals: {
        sets: rows.length,
        items: rows.reduce((sum, r) => sum + r.count, 0),
        downloads: rows.reduce((sum, r) => sum + r.downloads, 0),
        private: rows.filter((r) => r.visibility === 'private').length,
        people: people.length,
      },
      result: notice ? { action: notice, n: Number(req.query.n) || 0, failed: Number(req.query.failed) || 0 } : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    });
  }

  // Back to the page, on the folder the form was sent from (and the page of
  // the list it was on, when staying on that folder), with `query`.
  back(req, res, query, folder = req.body?.folder) {
    const params = new URLSearchParams(query);
    if (typeof folder === 'string' && folder) params.set('folder', folder);
    const page = parseInt(req.body?.page, 10);
    if (folder === req.body?.folder && page > 1) params.set('page', String(page));
    res.redirect(params.toString() ? `${this.config.base}?${params}` : this.config.base);
  }

  // A refusal Content Sharing explains (a bad or duplicate name, a missing
  // folder) is shown on the page; anything else is a real error.
  static refused(err) {
    return err instanceof GatewayError && [400, 404].includes(err.status);
  }

  // One set's action: my sets - visibility or delete; shared - a private
  // copy into my own sets (narrating a vocab copy can take a while), or
  // taking myself off the share.
  async one(req, action, id) {
    const token = req.auth.token;
    const path = `/api/sets/${encodeURIComponent(id)}`;
    if (action === 'delete') return this.gatewayClient.delete(path, token);
    if (action === 'copy') return this.gatewayClient.postLong(`${path}/copy`, undefined, token, 5 * 60 * 1000);
    if (action === 'leave') return this.gatewayClient.delete(`${path}/access/${encodeURIComponent(req.auth.user.sub)}`, token);
    if (action === 'lock-copy' || action === 'allow-copy') return this.gatewayClient.patch(path, { allowCopy: action === 'allow-copy' }, token);
    return this.gatewayClient.patch(path, { visibility: action }, token);
  }

  // One action on every ticked set. Moving is one request; the others are
  // one per set (Content Sharing has no bulk call) - a set that fails is
  // counted and the rest carry on.
  async run(req, res, action, idList) {
    const ids = [...new Set([].concat(idList || []).map(String).filter(Boolean))].slice(0, MAX_BULK);
    if (!this.config.actions.includes(action) || ids.length === 0) return this.back(req, res, {});
    if (action === 'move') {
      const folderId = typeof req.body?.folderId === 'string' && req.body.folderId ? req.body.folderId : null;
      try {
        const { moved } = await this.gatewayClient.post('/api/sets/folders/move', { ids, folderId, scope: this.config.scope }, req.auth.token);
        return this.back(req, res, { done: 'move', n: moved, failed: ids.length - moved });
      } catch (err) {
        if (!MySetsRoutes.refused(err)) throw err;
        return this.back(req, res, { error: err.message });
      }
    }
    let n = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.one(req, action, id);
        n++;
      } catch (err) {
        if (!(err instanceof GatewayError) || err.status === 401) throw err;
        failed++;
      }
    }
    this.back(req, res, { done: action, n, failed });
  }

  async createFolder(req, res) {
    try {
      const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
      const folder = await this.gatewayClient.post('/api/sets/folders', { name: req.body?.name, parentId, scope: this.config.scope }, req.auth.token);
      this.back(req, res, { done: 'folder-created' }, folder.id);
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      this.back(req, res, { error: err.message });
    }
  }

  async renameFolder(req, res) {
    const id = req.params.id;
    try {
      await this.gatewayClient.patch(`/api/sets/folders/${encodeURIComponent(id)}`, { name: req.body?.name }, req.auth.token);
      this.back(req, res, { done: 'folder-renamed' }, id);
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      this.back(req, res, { error: err.message }, id);
    }
  }

  // Back on the parent folder (`folder` from the page), where the deleted
  // folder's sets and subfolders now are.
  async deleteFolder(req, res) {
    try {
      const { unfiled } = await this.gatewayClient.delete(`/api/sets/folders/${encodeURIComponent(req.params.id)}`, req.auth.token);
      this.back(req, res, { done: 'folder-deleted', n: unfiled });
    } catch (err) {
      if (!MySetsRoutes.refused(err)) throw err;
      this.back(req, res, { error: err.message }, '');
    }
  }
}

module.exports = MySetsRoutes;
