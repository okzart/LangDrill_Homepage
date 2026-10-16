// Presentation layer for the community's posts - what users write, with
// pictures, like on a social network (Content Sharing's /posts, through the
// gateway at /api/posts). A first, simple version meant to grow: writing
// practice with the vocabulary of one's drills and AI help come later.
//
//   GET  /community/posts?author=<userId>   the page: a box to write a post, then the posts, newest first
//   GET  /community/posts/more?before=&author=   the next posts, as HTML (the page's "Load more")
//   POST /community/posts/images            a picture (raw body; the page shrinks it first) → { url }
//   POST /community/posts                   { text, images: [url] } → { id }
//   POST /community/posts/:id/edit          { text, images } → { id } (author only)
//   POST /community/posts/:id/delete        → back to the page (author, or an admin)
//   GET  /community/media/:name             a post's picture (proxied, cached)
//
// Registered before routes/communityRoutes.js so "posts" and "media" aren't
// taken as set ids.
const express = require('express');
const { requireLogin } = require('../middleware/requireLogin');
const AsyncHandler = require('../middleware/asyncHandler');
const Avatar = require('../services/avatar');
const Session = require('../middleware/session');
const { GatewayError } = require('../errors');

const PAGE = 10;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MEDIA_NAME = /^[a-f0-9]{64}\.(jpg|png|webp|gif)$/;

class PostsRoutes {
  constructor(gatewayClient) {
    this.gatewayClient = gatewayClient;
    this.router = express.Router();

    this.router.get('/community/posts', requireLogin, AsyncHandler.wrap(this.show.bind(this)));
    this.router.get('/community/posts/more', requireLogin, AsyncHandler.wrap(this.more.bind(this)));
    this.router.post(
      '/community/posts/images',
      express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_UPLOAD_BYTES }),
      AsyncHandler.wrap(this.uploadImage.bind(this))
    );
    this.router.post('/community/posts', AsyncHandler.wrap(this.create.bind(this)));
    this.router.post('/community/posts/:id/edit', AsyncHandler.wrap(this.edit.bind(this)));
    this.router.post('/community/posts/:id/delete', requireLogin, AsyncHandler.wrap(this.remove.bind(this)));
    this.router.get('/community/media/:name', requireLogin, AsyncHandler.wrap(this.media.bind(this)));
  }

  // A post as the views want it: pictures at this site's own address, and
  // whether the viewer may change or delete it.
  static view(post, req) {
    return {
      ...post,
      images: (post.images || []).map((img) => ({ ...img, src: `/community/media/${String(img.url).replace('/media/', '')}` })),
      mine: post.authorId === req.auth.user.sub,
      canDelete: post.authorId === req.auth.user.sub || req.auth.user.role === 'admin',
      edited: post.updatedAt && post.updatedAt - post.createdAt > 60 * 1000,
    };
  }

  // One page of posts (with the authors' pictures) → { posts, next }.
  async page(req, { author, before }) {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (author) qs.set('author', author);
    if (before) qs.set('before', String(before));
    const result = await this.gatewayClient.get(`/api/posts?${qs}`, req.auth.token);
    const posts = await Avatar.withAuthorAvatars(this.gatewayClient, req.auth.token, result.posts || []);
    return { posts: posts.map((p) => PostsRoutes.view(p, req)), next: result.next };
  }

  async show(req, res) {
    const author = typeof req.query.author === 'string' && req.query.author ? req.query.author : '';
    const [{ posts, next }, limits] = await Promise.all([
      this.page(req, { author }),
      this.gatewayClient.get('/api/posts/limits', req.auth.token),
    ]);
    res.render('posts', {
      posts,
      next,
      author,
      authorName: author ? (posts[0]?.author || '') : '',
      limits,
      deleted: req.query.deleted === '1',
    });
  }

  async more(req, res) {
    const author = typeof req.query.author === 'string' ? req.query.author : '';
    const { posts, next } = await this.page(req, { author, before: Number(req.query.before) || null });
    res.set('X-Next', next ? String(next) : '');
    res.render('posts-more', { posts });
  }

  // JSON answers for the page's script; the service's own message on a 400.
  fail(req, res, err) {
    if (!(err instanceof GatewayError)) {
      console.error(err);
      return res.status(502).json({ error: req.t('Posting is unavailable right now') });
    }
    if (err.status === 401) Session.clearToken(res);
    res.status(err.status).json({ error: err.status >= 502 ? req.t('Posting is unavailable right now') : req.t(err.message) });
  }

  async uploadImage(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: req.t('Choose a picture first.') });
    try {
      res.status(201).json(await this.gatewayClient.postRaw('/api/posts/images', req.body, 'application/octet-stream', req.auth.token));
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  static fields(body) {
    return { text: typeof body?.text === 'string' ? body.text : '', images: Array.isArray(body?.images) ? body.images : [] };
  }

  async create(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    try {
      const post = await this.gatewayClient.post('/api/posts', PostsRoutes.fields(req.body), req.auth.token);
      res.status(201).json({ id: post.id });
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  async edit(req, res) {
    if (!req.auth) return res.status(401).json({ error: req.t('Not logged in') });
    try {
      const post = await this.gatewayClient.patch(`/api/posts/${encodeURIComponent(req.params.id)}`, PostsRoutes.fields(req.body), req.auth.token);
      res.json({ id: post.id });
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  async remove(req, res) {
    await this.gatewayClient.delete(`/api/posts/${encodeURIComponent(req.params.id)}`, req.auth.token);
    const back = typeof req.body?.author === 'string' && req.body.author ? `&author=${encodeURIComponent(req.body.author)}` : '';
    res.redirect(`/community/posts?deleted=1${back}`);
  }

  // Pictures are named by their content, so they never change: cached hard.
  async media(req, res) {
    if (!MEDIA_NAME.test(req.params.name)) return res.status(404).end();
    const { buffer, contentType } = await this.gatewayClient.getBinary(`/api/media/${req.params.name}`);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }
}

module.exports = PostsRoutes;
