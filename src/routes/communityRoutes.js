// Presentation layer for /community - browse, publish, update, download, and
// unpublish shared drill sets, organized as two tabs on one page: List
// (browse/search, each row with inline Update/Delete) and Create. Calls
// the API Gateway's /api/sets (Content Sharing service), never that
// service directly (see docs/DESIGN.md §1).
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const { GatewayError } = require('../errors');
const { loadVoiceOptions } = require('../services/voiceOptions');
const Avatar = require('../services/avatar');

const TABS = ['list', 'create'];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
// Items shown per page on a set's own page (/community/:id): the choices
// its "per page" picker offers, and the one used without `?limit=`.
const ITEM_PAGE_SIZES = [10, 20, 50, 100];
const ITEMS_PER_PAGE = 20;

// llm-service caps max_tokens at 1024; ~8 sentences of Korean fit easily
// (same batch size as Content Sharing's PassageTranslator).
const MAX_TRANSLATE_SENTENCES = 8;
const MAX_TRANSLATE_CHARS = 500;
const HANGUL = /[가-힣]/;
const TRANSLATE_PROMPT = `You translate English sentences for Korean learners of English into natural Korean.
Translate each sentence faithfully and completely - it is study material, so do not summarise or embellish. Use polite spoken Korean (…해요 / …입니다).
Greetings and set phrases become what a Korean would actually say (Good evening. -> 안녕하세요.), not word-for-word. Keep each idiom's meaning, not its literal words.
Transliterate names into Hangul (David -> 데이비드). Write only Hangul Korean: never Chinese characters.
You get a numbered list of sentences. Answer with exactly those numbers, one line each: "<n>. <Korean>". Output nothing else.`;

class CommunityRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/community', requireLogin, AsyncHandler.wrap(this.showCommunity.bind(this)));
    this.router.post('/community/publish', requireLogin, AsyncHandler.wrap(this.publish.bind(this)));
    this.router.post('/community/translate', AsyncHandler.wrap(this.translate.bind(this)));
    this.router.post('/community/:id/update', requireLogin, AsyncHandler.wrap(this.update.bind(this)));
    this.router.get('/community/:id', requireLogin, AsyncHandler.wrap(this.showOne.bind(this)));
    this.router.post('/community/:id/download', requireLogin, AsyncHandler.wrap(this.download.bind(this)));
    this.router.post('/community/:id/visibility', requireLogin, AsyncHandler.wrap(this.setVisibility.bind(this)));
    this.router.post('/community/:id/copying', requireLogin, AsyncHandler.wrap(this.setCopying.bind(this)));
    this.router.post('/community/:id/access', requireLogin, AsyncHandler.wrap(this.grantAccess.bind(this)));
    this.router.post('/community/:id/access/:userId/revoke', requireLogin, AsyncHandler.wrap(this.revokeAccess.bind(this)));
    this.router.post('/community/:id/delete', requireLogin, AsyncHandler.wrap(this.remove.bind(this)));
    this.router.get('/community/audio/:filename', requireLogin, AsyncHandler.wrap(this.audio.bind(this)));
  }

  // Renders the /community page: the search/filter and set list, plus the
  // Create tab. On the List tab, `editId` names one set to load in full
  // (including items) so its row can show the item builder pre-filled for
  // editing in place, instead of a separate Update tab/page.
  //
  // Paging happens here, not at the gateway/ContentSharing layer: GET
  // /api/sets already returns every matching set as a bare array, and its
  // response shape is the exact contract the mobile client's mock server
  // implements (see ContentSharing's docs/DESIGN.md §1) - changing it to a
  // `{items,total,...}` envelope to add server-side paging would break
  // that. Slicing the already-fetched, already-filtered array here avoids
  // touching that contract at all (see ContentSharing's docs/DESIGN.md §8
  // for the same "revisit if this grows large" caveat that already
  // applies to its in-process `q` filtering).
  async showCommunity(req, res) {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'list';
    const type = req.query.type || '';
    const q = req.query.q || '';
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (q) qs.set('q', q);
    const path = `/api/sets${qs.toString() ? `?${qs}` : ''}`;
    const allSets = await this.gatewayClient.get(path, req.auth.token);

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const total = allSets.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
    // The page's sets, each with its author's profile image (services/avatar.js).
    const sets = await Avatar.withAuthorAvatars(this.gatewayClient, req.auth.token, allSets.slice((page - 1) * limit, page * limit));

    // `pagerBase` links to a different page of the same filter; `returnTo`
    // additionally pins the current page, so a row's Update/Delete action
    // can bring the user back to exactly where they were instead of
    // resetting to page 1.
    const pagerParams = new URLSearchParams({ tab: 'list' });
    if (type) pagerParams.set('type', type);
    if (q) pagerParams.set('q', q);
    if (limit !== DEFAULT_LIMIT) pagerParams.set('limit', String(limit));
    const pagerBase = pagerParams.toString();
    const returnTo = `${pagerBase}&page=${page}`;

    let editSet = null;
    let editError = null;
    const editId = req.query.editId || '';
    if (tab === 'list' && editId) {
      try {
        editSet = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(editId)}`, req.auth.token);
        editSet.returnTo = returnTo;
      } catch (err) {
        if (err instanceof GatewayError && [403, 404].includes(err.status)) {
          editError = err.message;
        } else {
          throw err;
        }
      }
    }

    const needsBuilder = tab === 'create' || editSet !== null;
    res.render('community', {
      voiceOptions: needsBuilder ? await this.loadVoiceOptions() : null,
      sets,
      type,
      q,
      tab,
      editId,
      editSet,
      editError,
      page,
      limit,
      total,
      totalPages,
      pagerBase,
      returnTo,
      error: req.query.error || null,
      published: req.query.published === '1',
      deleted: req.query.deleted === '1',
      updated: req.query.updated === '1',
    });
  }

  // The item builder's "Fill all empty Korean prompts with AI": { sentences } →
  // { translations }, the same length, null where the model gave no usable
  // Korean line. Called by the page's fetch(), so failures are JSON
  // `{ error }` (401 included) rather than errorHandler.js's pages.
  async translate(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    const sentences = req.body?.sentences;
    const valid = Array.isArray(sentences) && sentences.length > 0 && sentences.length <= MAX_TRANSLATE_SENTENCES
      && sentences.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_TRANSLATE_CHARS);
    if (!valid) {
      return res.status(400).json({ error: req.t('sentences must be 1-{max} non-empty strings', { max: MAX_TRANSLATE_SENTENCES }) });
    }
    const list = sentences.map((s, i) => `${i + 1}. ${s.replace(/\s+/g, ' ').trim()}`).join('\n');
    try {
      const reply = await this.gatewayClient.postLong(
        '/api/llm/chat/completions',
        { messages: [{ role: 'system', content: TRANSLATE_PROMPT }, { role: 'user', content: list }], max_tokens: 1024, temperature: 0.2 },
        req.auth.token,
        3 * 60 * 1000
      );
      res.json({ translations: CommunityRoutes.numberedLines(reply?.choices?.[0]?.message?.content, sentences.length) });
    } catch (err) {
      if (!(err instanceof GatewayError)) {
        console.error(err);
        return res.status(502).json({ error: req.t('Translation is unavailable right now (is llm-service running? scripts/gpu-services.sh status)') });
      }
      const down = err.status === 502 || err.status === 504;
      res.status(err.status).json({ error: down ? req.t('Translation is unavailable right now (is llm-service running? scripts/gpu-services.sh status)') : req.t(err.message) });
    }
  }

  // "<n>. <Korean>" lines → an array of `count` strings; null for a number
  // the reply skipped or answered without any Hangul.
  static numberedLines(text, count) {
    const out = new Array(count).fill(null);
    const body = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\d+)[.)]\s*(.+?)\s*$/);
      if (!m) continue;
      const i = Number(m[1]) - 1;
      if (i >= 0 && i < count && out[i] === null && HANGUL.test(m[2])) out[i] = m[2];
    }
    return out;
  }

  async publish(req, res, next) {
    const { type, name, desc, author, items, voice } = req.body || {};
    const visibility = CommunityRoutes.visibility(req.body?.visibility);
    const copy = CommunityRoutes.copyField(req.body);
    let parsedItems;
    try {
      parsedItems = JSON.parse(items || '[]');
    } catch {
      return this.renderCommunity(res, {
        sets: [], type: '', q: '', tab: 'create', editId: '',
        editSet: { type, name, desc, author, voice, visibility, ...copy, itemsRaw: items },
        editError: null, published: false, deleted: false, updated: false,
        error: 'Items must be valid JSON (an array of objects).',
      });
    }

    try {
      const card = await this.gatewayClient.post(
        '/api/sets',
        { type, name, desc, author, visibility, ...copy, items: parsedItems, ...CommunityRoutes.voiceField(type, voice) },
        req.auth.token
      );
      res.redirect(`/community/${card.id}?published=1`);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 400) {
        return this.renderCommunity(res, {
          sets: [], type: '', q: '', tab: 'create', editId: '',
          editSet: { type, name, desc, author, voice, visibility, ...copy, items: parsedItems },
          editError: null, published: false, deleted: false, updated: false,
          error: err.message,
        });
      }
      next(err);
    }
  }

  // Updates an existing set (List tab's inline "Update" action). Re-renders
  // the List tab with the submitted values preserved on failure, same
  // convention as #publish, rather than losing the user's edits on a
  // redirect. `returnTo` (a hidden field on the item builder form, seeded
  // from the page/filter the row was loaded from - see #showCommunity)
  // sends the user back to that same page/filter rather than resetting to
  // page 1 on success.
  async update(req, res, next) {
    const id = req.params.id;
    const { type, name, desc, author, items, voice, returnTo } = req.body || {};
    const visibility = CommunityRoutes.visibility(req.body?.visibility);
    const copy = CommunityRoutes.copyField(req.body);
    const backTo = returnTo ? `/community?${returnTo}` : '/community?tab=list';
    const listReturnTo = returnTo || 'tab=list';
    let parsedItems;
    try {
      parsedItems = JSON.parse(items || '[]');
    } catch {
      return this.renderCommunity(res, {
        sets: [], type: '', q: '', tab: 'list', editId: id,
        editSet: { id, type, name, desc, author, voice, visibility, ...copy, itemsRaw: items, returnTo },
        editError: null, published: false, deleted: false, updated: false,
        page: 1, limit: DEFAULT_LIMIT, total: 0, totalPages: 1, pagerBase: '', returnTo: listReturnTo,
        error: 'Items must be valid JSON (an array of objects).',
      });
    }

    try {
      await this.gatewayClient.patch(
        `/api/sets/${encodeURIComponent(id)}`,
        { type, name, desc, author, visibility, ...copy, items: parsedItems, ...CommunityRoutes.voiceField(type, voice) },
        req.auth.token
      );
      res.redirect(`${backTo}&updated=1`);
    } catch (err) {
      if (err instanceof GatewayError && [400, 403, 404].includes(err.status)) {
        return this.renderCommunity(res, {
          sets: [], type: '', q: '', tab: 'list', editId: id,
          editSet: { id, type, name, desc, author, voice, visibility, ...copy, items: parsedItems, returnTo },
          editError: null, published: false, deleted: false, updated: false,
          page: 1, limit: DEFAULT_LIMIT, total: 0, totalPages: 1, pagerBase: '', returnTo: listReturnTo,
          error: err.message,
        });
      }
      next(err);
    }
  }

  // Re-renders the community page with a builder form (a failed publish or
  // update), which needs the voice picker's options like #showCommunity.
  async renderCommunity(res, locals) {
    res.render('community', { ...locals, voiceOptions: await this.loadVoiceOptions() });
  }

  // The voice picker's options, or null if unavailable (see
  // services/voiceOptions.js).
  loadVoiceOptions() {
    return loadVoiceOptions(this.gatewayClient);
  }

  // The form's "Allow others to copy" box as { allowCopy }, or nothing when
  // the form didn't have it (so the set keeps what it had).
  static copyField(body) {
    return body?.copyChoice === '1' ? { allowCopy: body.allowCopy === '1' } : {};
  }

  // The set page's copying switch (owner only - Content Sharing refuses
  // anyone else).
  async setCopying(req, res) {
    const id = req.params.id;
    await this.gatewayClient.patch(`/api/sets/${encodeURIComponent(id)}`, { allowCopy: req.body?.allowCopy === '1' }, req.auth.token);
    res.redirect(`/community/${encodeURIComponent(id)}?copying=1`);
  }

  // "public" | "private" from a form; anything else is public.
  static visibility(value) {
    return value === 'private' ? 'private' : 'public';
  }

  // The set page's "Make private" / "Make public" (owner only - Content
  // Sharing refuses anyone else).
  async setVisibility(req, res) {
    const id = req.params.id;
    await this.gatewayClient.patch(`/api/sets/${encodeURIComponent(id)}`, { visibility: CommunityRoutes.visibility(req.body?.visibility) }, req.auth.token);
    res.redirect(`/community/${encodeURIComponent(id)}?visibility=1`);
  }

  // The set page's "Shared with" panel (owner of a private set): give one
  // of their friends access, or take it back. Content Sharing checks that
  // the person is the owner's friend and that the caller owns the set.
  async grantAccess(req, res) {
    const id = req.params.id;
    const userId = String(req.body?.userId || '');
    try {
      await this.gatewayClient.put(`/api/sets/${encodeURIComponent(id)}/access/${encodeURIComponent(userId)}`, undefined, req.auth.token);
      res.redirect(`/community/${encodeURIComponent(id)}?shared=1#access`);
    } catch (err) {
      if (err instanceof GatewayError && [400, 503].includes(err.status)) {
        return res.redirect(`/community/${encodeURIComponent(id)}?accessError=${encodeURIComponent(err.message)}#access`);
      }
      throw err;
    }
  }

  async revokeAccess(req, res) {
    const id = req.params.id;
    await this.gatewayClient.delete(`/api/sets/${encodeURIComponent(id)}/access/${encodeURIComponent(req.params.userId)}`, req.auth.token);
    res.redirect(`/community/${encodeURIComponent(id)}?revoked=1#access`);
  }

  // For the owner of a private set: who has access, and which friends could
  // be given it - { sharedWith, candidates, error }.
  async loadAccess(id, token) {
    try {
      const [access, friends] = await Promise.all([
        this.gatewayClient.get(`/api/sets/${encodeURIComponent(id)}/access`, token),
        this.gatewayClient.get('/api/friends', token),
      ]);
      const has = new Set(access.sharedWith.map((p) => p.id));
      return {
        sharedWith: access.sharedWith,
        candidates: (friends.friends || []).filter((f) => !has.has(f.id)).map((f) => ({ id: f.id, displayName: f.displayName || f.email })),
        error: null,
      };
    } catch (err) {
      if (!(err instanceof GatewayError) || err.status === 401) throw err;
      return { sharedWith: [], candidates: [], error: err.message };
    }
  }

  // Only vocab sets are narrated, so `voice` is only sent for them - and
  // only when one was actually chosen, so Content Sharing applies its
  // default otherwise (e.g. when the picker couldn't be shown).
  static voiceField(type, voice) {
    return type === 'vocab' && voice ? { voice } : {};
  }

  async showOne(req, res) {
    const [set] = await Avatar.withAuthorAvatars(this.gatewayClient, req.auth.token, [
      await this.gatewayClient.get(`/api/sets/${encodeURIComponent(req.params.id)}`, req.auth.token),
    ]);
    const isOwner = !!set.authorId && set.authorId === req.auth.user.sub;
    res.render('set-detail', {
      set,
      access: isOwner && set.visibility === 'private' ? await this.loadAccess(set.id, req.auth.token) : null,
      accessNotice: req.query.shared === '1' ? 'shared' : req.query.revoked === '1' ? 'revoked' : null,
      accessError: typeof req.query.accessError === 'string' ? req.query.accessError : null,
      paging: CommunityRoutes.itemPaging(set, req.query.page, req.query.limit),
      // For the owner-only visibility switch. Delete and Modify are still
      // just attempted, and Content Sharing decides (see #remove below).
      isOwner,
      visibilityChanged: req.query.visibility === '1',
      copyingChanged: req.query.copying === '1',
      downloaded: req.query.downloaded === '1',
      published: req.query.published === '1',
      error: null,
    });
  }

  // One page of a set's items for set-detail.pug: `items` to show, `first`
  // the index of the first of them (so the list keeps numbering through),
  // and the pager's numbers. `limit` is one of ITEM_PAGE_SIZES; `query` is
  // what the pager's links carry besides `page`. Sliced here for the same reason as the set
  // list in #showCommunity - GET /api/sets/:id returns the whole set.
  static itemPaging(set, pageParam, limitParam) {
    const all = Array.isArray(set?.items) ? set.items.filter((it) => it && typeof it === 'object') : [];
    const limit = ITEM_PAGE_SIZES.includes(Number(limitParam)) ? Number(limitParam) : ITEMS_PER_PAGE;
    const totalPages = Math.max(1, Math.ceil(all.length / limit));
    const page = Math.min(Math.max(1, parseInt(pageParam, 10) || 1), totalPages);
    const first = (page - 1) * limit;
    return {
      items: all.slice(first, first + limit),
      first,
      page,
      totalPages,
      total: all.length,
      limit,
      sizes: ITEM_PAGE_SIZES,
      query: limit === ITEMS_PER_PAGE ? '' : `limit=${limit}&`,
    };
  }

  async download(req, res) {
    await this.gatewayClient.post(`/api/sets/${encodeURIComponent(req.params.id)}/download`, undefined, req.auth.token);
    res.redirect(`/community/${req.params.id}?downloaded=1`);
  }

  // Streams a cached vocab-item mp3 (see set-detail.pug) from the gateway's
  // /api/sets/audio/* route. Proxied through here rather than pointing
  // <audio src> straight at the gateway so the gateway itself never needs
  // to be reachable from the browser - this app is the only public entry
  // point (see docs/DESIGN.md §1). Filenames are content hashes, so the
  // response is safe to cache hard on the client.
  async audio(req, res) {
    const { buffer, contentType } = await this.gatewayClient.getBinary(
      `/api/sets/audio/${encodeURIComponent(req.params.filename)}`
    );
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  }

  // Handles both the set-detail page's own Unpublish button (no
  // `returnTo` in the body - original behavior, unchanged) and the List
  // tab's per-row Delete buttons (which send `returnTo`, the page/filter
  // that row was loaded from - see #showCommunity - so success/failure
  // both land back on the same page instead of resetting to page 1).
  async remove(req, res, next) {
    const id = req.params.id;
    const returnTo = req.body?.returnTo;
    try {
      await this.gatewayClient.delete(`/api/sets/${encodeURIComponent(id)}`, req.auth.token);
      res.redirect(returnTo ? `/community?${returnTo}&deleted=1` : '/community?deleted=1');
    } catch (err) {
      if (returnTo && err instanceof GatewayError && [403, 404].includes(err.status)) {
        return res.redirect(`/community?${returnTo}&error=${encodeURIComponent(err.message)}`);
      }
      // 403 here means "not your set" - a routine, expected outcome (not
      // every set's owner is a mystery to the person clicking Delete), so
      // it's shown inline rather than the generic error page.
      if (err instanceof GatewayError && err.status === 403) {
        const set = await this.gatewayClient.get(`/api/sets/${encodeURIComponent(id)}`, req.auth.token);
        return res.render('set-detail', { set, paging: CommunityRoutes.itemPaging(set, 1), isOwner: false, downloaded: false, published: false, error: err.message });
      }
      next(err);
    }
  }
}

module.exports = CommunityRoutes;
