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
the backend - account login/registration, a progress dashboard,
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
| `src/services/gatewayClient.js` | The one place this app makes an HTTP call - attaches the bearer token, parses the response, throws `GatewayError` on a non-2xx status. Besides JSON calls it can stream a response back (`stream`), relay a request stream untouched (`postStream`, for Studio uploads), post raw bytes (`postRaw`) and multipart (`postMultipart`, `postMultipartBinary`), and wait up to 15 minutes (`postLong`). |
| `src/services/jwt.js` | Decodes (never verifies) a JWT's payload, for display/nav purposes only - see §2 Non-goals. |
| `src/services/progressForm.js` | Parses the shared progress-editing HTML form into the JSON body Progress Stats' PATCH endpoints expect - used by the admin progress editor (`/admin/users/:id/progress`). |
| `src/middleware/session.js` | Reads/writes the signed `ld_token` cookie. |
| `src/middleware/currentUser.js` | Runs on every request; decodes the cookie (if present and unexpired) into `req.auth` / `res.locals.currentUser`. |
| `src/middleware/requireLogin.js` | `requireLogin` (redirects to `/login` if `req.auth` is unset) and `requireAdmin` (403s if `role !== 'admin'`) - route guards. |
| `src/middleware/errorHandler.js` | Maps a thrown `GatewayError` to a redirect-to-login (401) or an error page (anything else); anything not a `GatewayError` is an unexpected bug, logged and answered 500. |
| `src/routes/authRoutes.js` | `/login`, `/register`, `/logout` - the only pages reachable while logged out. |
| `src/routes/dashboardRoutes.js` | `/`, `/dashboard` (the home feed), `/feed?type=&offset=` (next 8 posts as an HTML fragment for "Load more"; `X-Has-More` / `X-Next-Offset` headers) and `/profile`. Home is laid out like a social network: community sets are the feed's posts (newest first, `?type=` filter, each with its first 3 items via `GET /api/sets/:id`), with a shortcuts rail on the left and your progress (`GET /api/progress/me`), trending sets (most downloads) and top creators (most sets) on the right. |
| `src/routes/progressRoutes.js` | `/progress` - the caller's progress as a read-only dashboard (admins get an Edit button to their own record in the admin editor). |
| `views/_style.pug` | The shared design system every page includes, following `reference_designs/LanguageDrill Home.html`: a steel-blue ramp (`--blue-100` #eef6ff … `--blue-900` #1d2d3d, accent #5980a6) on cool neutrals with a faint 32px blueprint grid behind the page, #f5f5f8 cards with 18px radius, pill buttons; Barlow for text and Barlow Condensed for headings and buttons (Noto Sans KR for Hangul, always loaded). Styles plain elements - `section` cards, buttons (neutral by default; `type=submit`, `.btn`, `.primary` are the filled accent pill; `.soft`, `.danger`, `.link`), inputs, tables, `.error`/`.success`, `mark` (blanked words). Older token names (`--violet`, `--gold`, ...) are kept and now hold the blue ramp, so page styles keep working. |
| `views/_nav.pug` | The site's top bar (`nav.site`), social-network style: logo + set search (→ `/community?q=`) on the left, tabs in the middle with the icon above its label (the current page gets a light-blue fill and underline) (`res.locals.currentPath`, set in `currentUser.js`), and an EN | 한국어 segment, an Admin pill menu, the avatar (→ `/profile`) and log out on the right. On phones the tabs become a fixed bottom tab bar. |
| `views/mixins/feed.pug` | `+feedPost(post)` (author avatar, relative time via `Intl.RelativeTimeFormat`, item previews with blanks highlighted and inline ▶ for clips, Open / Download / Share), `+avatar(name, size)` (stable colour per name). Shared by `dashboard.pug` and `feed-posts.pug`. |
| `views/mixins/icons.pug` | `+icon(name, size)` inline stroke icons and `+brandMark(size)`. |
| `src/i18n/index.js` | UI language (English / Korean). gettext-style: templates call `t('English text', { vars })` and page scripts call `window.t(...)` (`views/_i18n.pug`, included from `_style.pug`); `ko.json` maps the exact English string to Korean, and anything missing falls back to English. `@patterns` in the dictionary translates messages carrying numbers (mostly relayed from backend services). The choice is the `ld_lang` cookie set by `GET /lang/:code?next=` (the nav's EN / 한국어 switch); without it, the browser's `Accept-Language` decides. Exposes `lang`, `t`, `langReturn` to views and `req.t` to routes (route-made JSON errors are translated with it). Korean mode loads Noto Sans KR / Noto Serif KR for Hangul and sets `word-break: keep-all`. |
| `src/i18n/build-ko.py` → `src/i18n/ko.json` | The Korean dictionary's source (edit the .py, run it). `npm run i18n:check` (`scripts/i18n-check.js`) lists every `t('...')` literal with no Korean entry. |
| `views/mixins/authShell.pug` | `+authShell(title, subtitle)` - the split layout (brand panel + form card) used by login, register and the email-confirmation pages. |
| `views/mixins/progressCharts.pug` | The progress dashboard, shared by `/progress` and `/admin/users/:id/progress`: stat tiles (level/XP, streak, study time, sentences, average accuracy, saved items), a daily-goal meter, a Mon-Sun activity column chart, accuracy-by-type bars with an average line, badges, and a table view of every number. Drawn client-side from the embedded record; on the admin page it redraws live from the edit form. |
| `src/routes/communityRoutes.js` | `/community` (List and Create tabs - List's rows carry inline Update/Delete), `/community/:id`, and the publish/update/download/unpublish actions. |
| `src/routes/chatRoutes.js` | `/chat` (chat page for the self-hosted LLM, optionally spoken aloud, with voice input), `POST /chat/transcribe` (relays a browser recording to the gateway's `/api/stt/transcriptions` as multipart and returns `{ text }` - never stored), `POST /chat/completions` (forwards the page's messages to the gateway's `/api/llm` route with the session token and pipes the streamed reply, Server-Sent Events, back to the browser) and `POST /chat/speech` (same, for one sentence of speech from `/api/tts`, piped back as `audio/mpeg` - never written to disk). |
| `src/routes/passagesRoutes.js` | `/passages` (example passage for the user's expressions, read aloud with word highlighting), `GET /passages/sets/:id` (a vocab drill set's items as `{ expression, example, meaning }` for the page's picker) and `POST /passages/generate`, which relays the request to the gateway's `/api/passages` and returns its JSON (text + base64 MP3 + timings) with `Cache-Control: no-store` - nothing is stored. |
| `src/services/vocabExpressions.js` | Maps a vocab drill item to a passage expression: `expression` = the answer's text from the first to the last blank, words counted with the mobile app's tokenizer (`[A-Za-z']+`), blank words compared without edge punctuation (blanks often hide only part of an idiom, e.g. "[off] the [ground]"), `example` = `answer`, `meaning` = `keyKo` (else `ko`). Items without blanks are skipped. |
| `src/services/voiceOptions.js` | The English narration voice list (`GET /api/sets/voices`) shaped for a `<select>`; shared by Community's vocab builder and Passages. |
| `src/routes/listeningRoutes.js` | `/admin/listening` (admin test bench for tts-service-listening / Dia2) and `POST /admin/listening/generate`, which relays to the gateway's `/api/listening/generate` via `gatewayClient.postLong` (undici fetch with a 15-minute timeout - Node's built-in fetch gives up after 5 minutes without response headers). Admin-only: a heavy GPU job for producing listening material. |
| `src/routes/studioRoutes.js` | `/studio` - make listening drills from your own audio/video or a voice recording made on the page. `POST /studio/transcribe` streams the multipart upload through to the gateway's `/api/split/transcribe` (`gatewayClient.postStream`, never buffered here); `POST /studio/clip` sends the extracted mp3 + `start`/`end` to `/api/split/cut`, stores the clip via `/api/sets/clips`, and answers `{ audioUrl, duration }`; `POST /studio/publish` rebuilds each item from known fields (`dictation`/`full`/`choice`/`order`, `answer`, `ko?`, `blanks` recomputed from `[A-Za-z']+` positions for `dictation` only, `options` = the answer plus at least one wrong sentence for `choice` only, `audioUrl` must be a clip URL) and publishes a listening set. Or, instead of a new set, the items are added to an existing listening set: `GET /studio/sets?q=` searches (`GET /api/sets?type=listening&q=`, newest 20), `GET /studio/sets/:id` loads one, and `POST /studio/sets/:id/update` re-reads the set, keeps the current items the page didn't remove (taken from the service, not the page, so item kinds Studio can't make pass through untouched), appends the new ones and `PATCH`es it - owner-only, a non-owner gets a "publish as a new set instead" message. Stateless: the page keeps the extracted mp3 in memory and re-sends it with each crop. |
| `src/routes/scanRoutes.js` | `/scan` - "Scan & Study": a picture of English text → the text → Korean translation, vocabulary and expressions → a vocab drill set. `POST /scan/ocr` streams the multipart upload to the gateway's `/api/ocr/ocr`; `POST /scan/analyze` sends the (possibly corrected) text to `/api/study/analyze`; `POST /scan/publish` rebuilds each picked item (`{ ko, answer, keyKo?, blanks }`, blank words re-read from the sentence) and publishes a `vocab` set. Two steps rather than `/api/study/image` so the user can fix the scan first; the text box also accepts typed/pasted text. |
| `src/routes/adminRoutes.js` | `/admin/users/*` (Authentication's admin API) and `/admin/users/:id/progress` (Progress Stats' admin API) - `requireAdmin`-gated. |

## 4. Pages & the Gateway Calls Behind Them

| Page | Auth | Calls |
|---|---|---|
| `GET/POST /login` | — | `POST /api/auth/login`; a `403` (registered but email not confirmed) shows the code step instead |
| `GET/POST /register` | — | `POST /api/auth/register` (emails a 6-digit code; no account yet) → renders the "Confirm your email" step |
| `POST /register/verify` `{ email, code, password }` (the code step; `password` rides in a hidden field because confirming needs it, page sent `no-store`) | — | `POST /api/auth/register/verify` → creates the account, sets the session cookie, redirects to `/dashboard` |
| `POST /register/resend` | — | `POST /api/auth/register/resend` |
| `GET/POST /register/confirm?token=` (the emailed link; the GET only shows a password form so mail scanners prefetching links can't use it up) | — | `POST /api/auth/register/confirm` `{ token, password }` → session cookie, `/dashboard` |
| `POST /logout` | — | (clears the cookie only - no gateway call; JWTs aren't revocable, see Authentication's `docs/DESIGN.md`) |
| `GET /dashboard?type=` (home feed) | login | `GET /api/sets` (feed, trending, creators), `GET /api/sets/:id` per post on screen (item previews), `GET /api/progress/me` (progress widget; the page still renders without it) |
| `GET /feed?type=&offset=` (the feed's "Load more"; HTML fragment) | login | `GET /api/sets`, then `GET /api/sets/:id` for each of the next 8 |
| `GET /profile` | login | `GET /api/auth/me` |
| `GET /progress` | login | `GET /api/progress/me` (read-only dashboard; progress is recorded by the app, and editing is admin-only via `/admin/users/:id/progress`) |
| `GET /community` (`?tab=list\|create`; List's `?editId=` loads a row's inline editor), `GET /community/:id` | login | `GET /api/sets`, `GET /api/sets/:id` |
| `POST /community/publish` (Create tab) | login | `POST /api/sets` |
| `POST /community/:id/update` (List row's inline "Update" editor) | login | `PATCH /api/sets/:id` (owner-only) |
| `POST /community/translate` `{ sentences }` (1-8 English sentences; the item builder's "Fill all empty Korean prompts with AI" button, which sends the items whose `ko` is empty a batch at a time - `answer`, or `model` for writing; JSON `{ error }` on failure) | login | `POST /api/llm/chat/completions` (non-streaming) → `{ translations }`, same length, `null` where the model gave no Korean line. Nothing is saved until the user saves the set |
| `POST /community/:id/download` | login | `POST /api/sets/:id/download` |
| `POST /community/:id/delete` (set-detail's Unpublish button, and the List row's Delete button) | login | `DELETE /api/sets/:id` (owner-only - a non-owner sees the service's own 403 message) |
| `GET /chat` | login | `GET /api/llm/models` (model name for the header) and `GET /api/tts/voices` (voice picker); the page still renders if either service is down, without the voice picker if tts-service is |
| `POST /chat/completions` (called by the chat page's own `fetch`, answers JSON `{ error }` instead of redirecting) | login | `POST /api/llm/chat/completions` with `stream: true`, streamed back unchanged; cancelled upstream if the browser disconnects |
| `POST /chat/transcribe?language=en\|ko\|auto` (raw `audio/*` body from the page's 🎤 button - MediaRecorder webm/opus, or mp4 on Safari - max 60 s; JSON `{ error }` on failure, 502-504 → "Speech recognition is unavailable right now") | login | `POST /api/stt/transcriptions` (multipart `file` + `language`, stt-service/Whisper) → `{ text }`, put in the message box and sent if "Send after speaking" is on. Browsers only allow the microphone on HTTPS or localhost - on plain http the button is disabled with that hint |
| `POST /chat/speech` `{ text, voice }` (called by the chat page per sentence when "Speak replies" is on, or by a reply's Replay button; JSON `{ error }` on failure) | login | `POST /api/tts/speech` (`response_format: "mp3"`), streamed back as `audio/mpeg` and played as it arrives; cancelled upstream if the browser disconnects |
| `GET /passages` | login | `GET /api/sets/voices` (voice picker) and `GET /api/sets?type=vocab` (drill-set picker); each is omitted if unavailable |
| `GET /passages/sets/:id` (called by the page's picker; JSON) | login | `GET /api/sets/:id` → items mapped by `vocabExpressions.js`; `400` for a non-vocab set |
| `POST /passages/generate` `{ expressions: [{ expression, meaning?, example? }], level, voice }` (called by the page's own `fetch`; JSON `{ error }` on failure). The page builds the list from picked drill items (editable) plus typed rows, max 15 | login | `POST /api/passages` (Content Sharing → llm-service + tts-service). The page plays the returned MP3 from memory and highlights each word at its `startTime`; clicking a word or expression seeks there. Below the passage, a 한국어 번역 panel shows `sentences[].ko`, highlights the Korean sentence being spoken, and plays a sentence when clicked ("Show Korean" toggle, remembered per browser) |
| `GET /studio` | login | — (the recorder is disabled with a hint unless the page is on HTTPS or localhost) |
| `POST /studio/transcribe` (multipart `file` + `language` = `en`/`ko`/`auto`, from the page's file picker or its MediaRecorder recording; ≤ 300 MB, ≤ 30 min of audio; JSON `{ error }` on failure) | login | `POST /api/split/transcribe` (audio-split-service → stt-service; the page posts it with `XMLHttpRequest` to show a progress bar - upload %, then a moving bar with elapsed time while the audio is extracted and transcribed, then download % - and a Cancel button): the audio track as a compact mp3 (base64; from a video only the sound), words with timings and sentences. The page shows the transcript as clickable words per sentence - first click / second click selects a range, or "Use" takes a whole sentence; the crop is padded slightly into the surrounding silence and can be nudged by ear |
| `POST /studio/clip?start=&end=` (raw `audio/mpeg` body = the extracted mp3; clip ≤ 120 s; JSON) | login | `POST /api/split/cut` (mono mp3, 20 ms fades) → `POST /api/sets/clips` (Content Sharing stores it as `/audio/<sha256>.mp3`) → `{ audioUrl, duration }`. The item (type, answer text - editable, blanks picked by clicking words, optional Korean) joins the page's draft list |
| `GET /studio/sets?q=` (the page's "Add to an existing listening set" search, as you type; JSON `{ sets, total }`) | login | `GET /api/sets?type=listening&q=` (newest 20 shown) |
| `GET /studio/sets/:id` (JSON) | login | `GET /api/sets/:id` → `{ id, name, desc, author, items }`; `400` for a non-listening set. The page lists the current items (each can be removed / undone) above the new ones and fills in the set's name, description and author |
| `POST /studio/sets/:id/update` `{ name, desc?, author?, keep: [index…], items }` (JSON) | login | `GET /api/sets/:id`, then `PATCH /api/sets/:id` with the kept current items + the new ones. Owner-only: a `403` becomes "Only the person who published this set can add to it - publish your items as a new set instead." |
| `POST /studio/publish` `{ name, desc?, author?, items }` (JSON) | login | `POST /api/sets` with `type: "listening"`; the page then opens `/community/:id`, which plays each item's clip. Unpublished clips are deleted by Content Sharing's audio janitor after about an hour |
| `GET /scan` | login | — |
| `POST /scan/ocr` (multipart `file` + `language` = `auto`/`en` + `auto_rotate`; ≤ 20 MB; JSON `{ error }` on failure) | login | `POST /api/ocr/ocr` (ocr-service). The page fills its text box with the result and outlines the lines that were read on the picture preview |
| `POST /scan/analyze` `{ text, level }` (JSON) | login | `POST /api/study/analyze` (Content Sharing → llm-service) → sentences with Korean, vocabulary and expression cards (each ticked by default, with its sentence and the word highlighted). ▶ on a sentence speaks it through `/chat/speech` |
| `POST /scan/publish` `{ name, author?, desc?, items }` (JSON) | login | `POST /api/sets` with `type: "vocab"` (Content Sharing narrates each sentence via tts-service); the page then opens `/community/:id` |
| `GET /admin/listening` | admin | `GET /api/listening/voices` (voice pickers; shows an error banner if tts-service-listening is unreachable) |
| `POST /admin/listening/generate` `{ script, voices?, format?, seed?, cfg_scale?, temperature? }` (called by the page's `fetch`; other fields are dropped; JSON `{ error }` on failure) | admin | `POST /api/listening/generate` (`response: "json"`) → audio (base64) + words with speakers. The page plays it with a speaker-grouped read-along transcript, offers the audio and a timestamps JSON as downloads, and keeps this visit's takes in memory for comparison |
| `GET /admin/users`, `POST .../update`, `.../delete` | admin | `GET/POST/PATCH/DELETE /api/admin/api/users...` |
| `GET/POST /admin/users/:id/progress`, `.../delete` | admin | `GET/PATCH/DELETE /api/progress/admin/users/:id` - the same dashboard as `/progress` above the edit form, previewing edits live before Save |

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
