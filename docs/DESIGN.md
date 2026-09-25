# LanguageDrill Homepage — Design Document

## 1. Overview

A server-rendered web client for LanguageDrill. Unlike every other repo in
this family (Authentication, Progress Stats, Content Sharing), **this is
not a microservice behind the API Gateway** - it has no gateway route of
its own, owns no data, and verifies no JWT signature. It is a *caller* of
the gateway, in the same position a mobile app or any other frontend would
be: every feature it offers works by logging in through
`POST /api/auth/login` and then calling the gateway's other routes with
the resulting token.

It exists to give people (not just developers pasting tokens into a raw
test page) a real login-gated way to use the features already built across
the backend - account login/registration, self-service progress editing,
community set publishing/browsing, and user/progress administration -
from one site instead of three separate services' individual `/`/`/admin`
test pages. Per the project's own roadmap, this is meant to grow into the
official homepage for LanguageDrill, alongside the mobile app, both backed
by the same microservices.

## 2. Goals / Non-Goals

**Goals**
- Require login for every feature (see §4) - there is no "browse without
  an account" mode here, even though `GET /api/sets` itself is public at
  the gateway. A consistent "log in first" experience matters more for a
  homepage than exposing that one endpoint's laxer rule.
- Every feature calls the gateway, never a backend service directly - so
  this app's behavior stays correct automatically if a service's own
  internal port or path ever changes, as long as the gateway's routes
  don't.
- Reuse capability that already exists server-side (Authentication's admin
  API, Progress Stats' self/admin APIs, Content Sharing's full CRUD) rather
  than re-implementing any of it - this app is presentation only.

**Non-goals**
- No JWT verification, no `JWT_SECRET` - this app never makes an
  authorization decision itself. It decodes (never verifies) its own
  token only to render a nav bar / gate an admin *link* (see
  `services/jwt.js`); every actual permission check happens downstream
  when the gateway/service verifies the real signature.
- No database, no data ownership of any kind.
- No feature this app's own logged-in user can't already do through the
  gateway - e.g. no user-facing content moderation, since Content
  Sharing itself defines no moderation role (see that service's
  `docs/DESIGN.md` §2).

## 3. Architecture

```
  Browser                                                     Backend services
┌──────────┐  session cookie   ┌───────────────────┐  Bearer  ┌──────────────────┐
│  (HTML    │◄─────────────────┤  Homepage server    ├─────────►│  API Gateway       │
│  forms,   │  HTML responses  │  (this repo)         │  token   │  :8080             │
│  no JS    │◄─────────────────┤                        │◄─────────┤                    │
│  required)│                  └───────────────────┘          └─────────┬────────┘
└──────────┘                                                           │ proxies to
                                                          ┌───────────────┼───────────────┐
                                                          ▼               ▼               ▼
                                                  Authentication   Progress Stats   Content Sharing
                                                     :3000             :3002            :3003
```

The session cookie holds the raw JWT Authentication issued - there is no
separate server-side session store (see `middleware/session.js`). Every
route handler pulls `req.auth.token` and forwards it as the `Authorization`
header on its own call(s) to the gateway (`services/gatewayClient.js`).
This app never talks to `:3000`/`:3002`/`:3003` directly.

| File | Responsibility |
|---|---|
| `src/server.js` | Entry point. Loads `.env`, validates `COOKIE_SECRET`, wires the dependency graph, starts the HTTP listener. |
| `src/services/gatewayClient.js` | The one place this app makes an HTTP call - attaches the bearer token, parses the response, throws `GatewayError` on a non-2xx status. |
| `src/services/jwt.js` | Decodes (never verifies) a JWT's payload, for display/nav purposes only - see §2 Non-goals. |
| `src/services/progressForm.js` | Parses the shared progress-editing HTML form into the JSON body Progress Stats' PATCH endpoints expect - used by both the self-service and admin progress routes. |
| `src/middleware/session.js` | Reads/writes the signed `ld_token` cookie. |
| `src/middleware/currentUser.js` | Runs on every request; decodes the cookie (if present and unexpired) into `req.auth` / `res.locals.currentUser`. |
| `src/middleware/requireLogin.js` | `requireLogin` (redirects to `/login` if `req.auth` is unset) and `requireAdmin` (403s if `role !== 'admin'`) - route guards. |
| `src/middleware/errorHandler.js` | Maps a thrown `GatewayError` to a redirect-to-login (401) or an error page (anything else); anything not a `GatewayError` is an unexpected bug, logged and answered 500. |
| `src/routes/authRoutes.js` | `/login`, `/register`, `/logout` - the only pages reachable while logged out. |
| `src/routes/dashboardRoutes.js` | `/`, `/dashboard`, `/profile`. |
| `src/routes/progressRoutes.js` | `/progress` (self-service get/update). |
| `src/routes/communityRoutes.js` | `/community` (List and Create tabs - List's rows carry inline Update/Delete), `/community/:id`, and the publish/update/download/unpublish actions. |
| `src/routes/chatRoutes.js` | `/chat` (chat page for the self-hosted LLM, optionally spoken aloud), `POST /chat/completions` (forwards the page's messages to the gateway's `/api/llm` route with the session token and pipes the streamed reply, Server-Sent Events, back to the browser) and `POST /chat/speech` (same, for one sentence of speech from `/api/tts`, piped back as `audio/mpeg` - never written to disk). |
| `src/routes/passagesRoutes.js` | `/passages` (example passage for the user's expressions, read aloud with word highlighting) and `POST /passages/generate`, which relays the request to the gateway's `/api/passages` and returns its JSON (text + base64 MP3 + timings) with `Cache-Control: no-store` - nothing is stored. |
| `src/services/voiceOptions.js` | The English narration voice list (`GET /api/sets/voices`) shaped for a `<select>`; shared by Community's vocab builder and Passages. |
| `src/routes/adminRoutes.js` | `/admin/users/*` (Authentication's admin API) and `/admin/users/:id/progress` (Progress Stats' admin API) - `requireAdmin`-gated. |

## 4. Pages & the Gateway Calls Behind Them

| Page | Auth | Calls |
|---|---|---|
| `GET/POST /login` | — | `POST /api/auth/login` |
| `GET/POST /register` | — | `POST /api/auth/register`, then `POST /api/auth/login` |
| `POST /logout` | — | (clears the cookie only - no gateway call; JWTs aren't revocable, see Authentication's `docs/DESIGN.md`) |
| `GET /dashboard` | login | — |
| `GET /profile` | login | `GET /api/auth/me` |
| `GET/POST /progress` | login | `GET`/`PATCH /api/progress/me` |
| `GET /community` (`?tab=list\|create`; List's `?editId=` loads a row's inline editor), `GET /community/:id` | login | `GET /api/sets`, `GET /api/sets/:id` |
| `POST /community/publish` (Create tab) | login | `POST /api/sets` |
| `POST /community/:id/update` (List row's inline "Update" editor) | login | `PATCH /api/sets/:id` (owner-only) |
| `POST /community/:id/download` | login | `POST /api/sets/:id/download` |
| `POST /community/:id/delete` (set-detail's Unpublish button, and the List row's Delete button) | login | `DELETE /api/sets/:id` (owner-only - a non-owner sees the service's own 403 message) |
| `GET /chat` | login | `GET /api/llm/models` (model name for the header) and `GET /api/tts/voices` (voice picker); the page still renders if either service is down, without the voice picker if tts-service is |
| `POST /chat/completions` (called by the chat page's own `fetch`, answers JSON `{ error }` instead of redirecting) | login | `POST /api/llm/chat/completions` with `stream: true`, streamed back unchanged; cancelled upstream if the browser disconnects |
| `POST /chat/speech` `{ text, voice }` (called by the chat page per sentence when "Speak replies" is on, or by a reply's Replay button; JSON `{ error }` on failure) | login | `POST /api/tts/speech` (`response_format: "mp3"`), streamed back as `audio/mpeg` and played as it arrives; cancelled upstream if the browser disconnects |
| `GET /passages` | login | `GET /api/sets/voices` (voice picker; omitted if unavailable) |
| `POST /passages/generate` `{ expressions, level, voice }` (called by the page's own `fetch`; JSON `{ error }` on failure) | login | `POST /api/passages` (Content Sharing → llm-service + tts-service). The page plays the returned MP3 from memory and highlights each word at its `startTime`; clicking a word or expression seeks there |
| `GET /admin/users`, `POST .../update`, `.../delete` | admin | `GET/POST/PATCH/DELETE /api/admin/api/users...` |
| `GET/POST /admin/users/:id/progress`, `.../delete` | admin | `GET/PATCH/DELETE /api/progress/admin/users/:id` |

Every login-gated page redirects an unauthenticated visitor to
`/login?next=<original path>` and sends them back there after a successful
login (`routes/authRoutes.js`'s `safeNext`, which only ever allows a
same-site relative path - guards against an open-redirect via a crafted
`next` value).

## 5. A Gateway Config Fix This Feature Needed

Building the admin pages surfaced a stale route: `gateway.config.json`'s
`/api/users` entry pointed at Authentication (`:3000`) with no
`rewriteTo`, but Authentication's admin API is actually mounted at
`/admin`, not `/users` (see that service's `src/server.js`). With no
rewrite, the gateway's own mount-path-stripping behavior left nothing for
Authentication to match, so this route was silently non-functional - not
something anyone had wired up yet, since nothing previously called it. It
was renamed to `/api/admin` with `rewriteTo: "/admin"` (no `requireAuth`
at the gateway, matching `/api/auth` and `/api/sets` - `/admin` mixes a
deliberately-unauthenticated page-shell route with admin-only ones, so the
gateway can't gate the whole prefix uniformly; Authentication's own
`AuthMiddleware.requireAuth`/`requireAdmin` do that per-route instead, the
same reasoning documented in `LanguageDrill_APIGateway/docs/DESIGN.md`).
See that repo's `gateway.config.json`.

## 6. Configuration

Environment variables (see `.env.example`):

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port | `3004` |
| `GATEWAY_URL` | Base URL of the API Gateway - every feature call goes here | `http://localhost:8080` |
| `COOKIE_SECRET` | Signs the session cookie. Server refuses to start if unset. | — (required) |
| `NODE_ENV` | `production` marks the session cookie `Secure` (HTTPS-only) | `development` |

## 7. Known Limitations / Future Work

- No CSRF protection on the POST forms - acceptable for now since every
  mutating action also requires the session cookie (`SameSite=Lax`), but
  worth revisiting before this is a public-facing site.
- Client-side JavaScript is used on `/community`'s item builder only (the
  Create tab, and a List row's inline "Update" editor - see below) -
  inline, no build step, no framework. Every other page is still a full
  page navigation via classic HTML forms with no JS required.
- Community publish/update no longer requires hand-writing JSON: the
  Create tab and a List row's inline editor share a per-drill-type visual
  item builder (`views/mixins/itemBuilder.pug` + the inline script in
  `views/community.pug`) that shows only the fields relevant to the
  chosen type/sub-type (vocab / listening's dictation·full·choice·order /
  writing's compose·free·guided·correct·passage, per
  `LangDrillApp/docs/13.community_content_formats.md` §2), including a
  click-to-blank-word picker so `blanks` doesn't need manual index math.
  A raw-JSON textarea remains available behind an "Advanced" toggle for
  power users, and is what actually gets submitted (the visual builder
  just keeps it in sync).
- Update (`PATCH /api/sets/:id`) is new to Content Sharing and not part of
  the mobile client's mock-server contract - see that service's
  `docs/DESIGN.md` §1. Ownership isn't exposed to this app (see
  `dto/setDto.js`), so every List row's Update/Delete buttons let anyone
  attempt any visible set; the server enforces who actually owns it and
  this app just surfaces the resulting 403.
- The List tab's paging is done here, in-memory, over the full result of
  `GET /api/sets?type=&q=` (`routes/communityRoutes.js#showCommunity`),
  not at ContentSharing or the gateway - that endpoint's bare-array
  response is the same frozen mobile-client contract mentioned above, so
  adding a `{items,total,...}` envelope there to paginate server-side
  would break it. This is the same "revisit if this grows large" tradeoff
  ContentSharing's own `docs/DESIGN.md` §8 already accepts for its
  in-process `q` filtering - fine at today's scale, worth moving
  server-side (with true skip/limit) if the number of published sets
  grows large.
- No way to browse/download community sets without an account, even
  though the gateway itself allows anonymous browsing - see §2 Goals.
