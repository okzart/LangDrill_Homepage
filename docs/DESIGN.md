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
| `views/_nav.pug` | The site's top bar (`nav.site`), social-network style: logo + set search (→ `/community?q=`) on the left, five tabs in the middle with the icon above its label - Home, Community, Studio, Chat, Friends - plus a "More" dropdown for every other page (Messages, Schedule, Assignments, Meeting summary, Video call, Scan, Passages, Progress, Around me), so the bar stays short as pages are added (the current page gets a light-blue fill and underline; a page under "More" lights that tab up) (`res.locals.currentPath`, set in `currentUser.js`), and an EN | 한국어 segment, an Admin pill menu, the avatar (→ `/profile`) and log out on the right. On phones the tabs become a fixed bottom tab bar. |
| `views/mixins/feed.pug` | `+feedPost(post)` (author avatar, relative time via `Intl.RelativeTimeFormat`, item previews with blanks highlighted and inline ▶ for clips, Open / Download / Share), `+avatar(name, size)` (stable colour per name). Shared by `dashboard.pug` and `feed-posts.pug`. |
| `views/mixins/icons.pug` | `+icon(name, size)` inline stroke icons and `+brandMark(size)`. |
| `src/i18n/index.js` | UI language (English / Korean). gettext-style: templates call `t('English text', { vars })` and page scripts call `window.t(...)` (`views/_i18n.pug`, included from `_style.pug`); `ko.json` maps the exact English string to Korean, and anything missing falls back to English. `@patterns` in the dictionary translates messages carrying numbers (mostly relayed from backend services). The choice is the `ld_lang` cookie set by `GET /lang/:code?next=` (the nav's EN / 한국어 switch); without it, the browser's `Accept-Language` decides. Exposes `lang`, `t`, `langReturn` to views and `req.t` to routes (route-made JSON errors are translated with it). Korean mode loads Noto Sans KR / Noto Serif KR for Hangul and sets `word-break: keep-all`. |
| `src/i18n/build-ko.py` → `src/i18n/ko.json` | The Korean dictionary's source (edit the .py, run it). `npm run i18n:check` (`scripts/i18n-check.js`) lists every `t('...')` literal with no Korean entry. |
| `views/mixins/authShell.pug` | `+authShell(title, subtitle)` - the split layout (brand panel + form card) used by login, register and the email-confirmation pages. |
| `views/mixins/progressCharts.pug` | The progress dashboard, shared by `/progress` and `/admin/users/:id/progress`: stat tiles (level/XP, streak, study time, sentences, average accuracy, saved items), a daily-goal meter, a Mon-Sun activity column chart, accuracy-by-type bars with an average line, badges, and a table view of every number. Drawn client-side from the embedded record; on the admin page it redraws live from the edit form. |
| `src/routes/communityRoutes.js` | `/community` (List and Create tabs - List's rows carry inline Update/Delete), `/community/:id`, and the publish/update/download/unpublish actions. Private sets: the publish/edit form has "Who can see it" (Everyone / Only me), Studio's save forms a "Private - only I can see it" box, the set page shows who can see it with an owner-only switch, and the list marks private sets with a 🔒 Private badge; Content Sharing does the hiding (see guidebook 04). A vocab set made from a private listening set is private too, and the assignment form doesn't offer private sets (the student couldn't open them). |
| `src/routes/chatRoutes.js` | `/chat` (chat page for the self-hosted LLM, optionally spoken aloud, with voice input), `POST /chat/transcribe` (relays a browser recording to the gateway's `/api/stt/transcriptions` as multipart and returns `{ text }` - never stored), `POST /chat/completions` (forwards the page's messages to the gateway's `/api/llm` route with the session token and pipes the streamed reply, Server-Sent Events, back to the browser) and `POST /chat/speech` (same, for one sentence of speech from `/api/tts`, piped back as `audio/mpeg` - never written to disk). The tutor's instructions (the system prompt) are decided by the server: only an admin sees and can edit them on the page, and any system message in a non-admin's request is dropped. `?place=` (from the Map's "Practise with the AI tutor") is accepted only if it names one of the Map's place kinds (`/api/places/categories`, cached), and the server writes the role-play instructions for it. |
| `src/routes/passagesRoutes.js` | `/passages` (example passage for the user's expressions, read aloud with word highlighting), `GET /passages/sets/:id` (a vocab drill set's items as `{ expression, example, meaning }` for the page's picker) and `POST /passages/generate`, which relays the request to the gateway's `/api/passages` and returns its JSON (text + base64 MP3 + timings) with `Cache-Control: no-store` - nothing is stored. |
| `src/services/vocabExpressions.js` | Maps a vocab drill item to a passage expression: `expression` = the answer's text from the first to the last blank, words counted with the mobile app's tokenizer (`[A-Za-z']+`), blank words compared without edge punctuation (blanks often hide only part of an idiom, e.g. "[off] the [ground]"), `example` = `answer`, `meaning` = `keyKo` (else `ko`). Items without blanks are skipped. |
| `src/services/voiceOptions.js` | The English narration voice list (`GET /api/sets/voices`) shaped for a `<select>`; shared by Community's vocab builder and Passages. |
| `src/routes/listeningRoutes.js` | `/admin/listening` (admin test bench for tts-service-listening / Dia2) and `POST /admin/listening/generate`, which relays to the gateway's `/api/listening/generate` via `gatewayClient.postLong` (undici fetch with a 15-minute timeout - Node's built-in fetch gives up after 5 minutes without response headers). Admin-only: a heavy GPU job for producing listening material. |
| `src/routes/studioRoutes.js` | `/studio` - make listening drills from your own audio/video or a voice recording made on the page. `POST /studio/transcribe` streams the multipart upload through to the gateway's `/api/split/transcribe` (`gatewayClient.postStream`, never buffered here); `POST /studio/clip` sends the extracted mp3 + `start`/`end` to `/api/split/cut`, stores the clip via `/api/sets/clips`, and answers `{ audioUrl, duration }`; `POST /studio/publish` rebuilds each item from known fields (`dictation`/`full`/`choice`/`order`, `answer`, `ko?`, `blanks` recomputed from `[A-Za-z']+` positions for `dictation` only, `options` = the answer plus at least one wrong sentence for `choice` only, `audioUrl` must be a clip URL) and publishes a listening set. Or, instead of a new set, the items are added to an existing listening set: `GET /studio/sets?q=` searches (`GET /api/sets?type=listening&q=`, newest 20), `GET /studio/sets/:id` loads one, and `POST /studio/sets/:id/update` re-reads the set, keeps the current items the page didn't remove (taken from the service, not the page, so item kinds Studio can't make pass through untouched), appends the new ones and `PATCH`es it - owner-only, a non-owner gets a "publish as a new set instead" message. Stateless: the page keeps the extracted mp3 in memory and re-sends it with each crop. |
| `src/routes/callRoutes.js` | `/call` - peer-to-peer video calls (WebRTC) with another logged-in user, found by email: a two-way call or a one-way live stream. Serves the page, `GET /call/ice-config` (→ `/api/signaling/ice-config`) and `GET /call/protocol.js` (the signaling protocol, exactly as signaling-service serves it). The signaling WebSocket `/call/ws` is carried to the gateway by `src/services/signalingProxy.js` (attached to the HTTP server in `server.js`): it reads the login cookie, checks the page's Origin, opens `/api/signaling/ws` with the token and passes frames both ways. All call logic is in `src/public/call/` (`signalingClient.js`, `peerSession.js` - no UI code; `callPage.js`; `incoming.js`, which rings on every other page). Media never passes through this server. See `docs/p2p-video.md` in the gateway repo. |
| `src/routes/friendsRoutes.js` | `/friends` - the user's friends (each with a live online mark from the page's signaling connection, and Video call / Live stream links to `/call?email=…&start=…`), the friend requests waiting in either direction, and a form to ask someone by email. Plain forms that redirect back with `?done=` / `?error=`; everything goes to Authentication's `/api/friends`. |
| `src/routes/avatarRoutes.js` | Profile images: `GET /avatar/:userId` fetches anyone's from Authentication with the caller's token (an `<img>` can't send one); `POST /profile/avatar` and `/profile/avatar/remove` set and remove your own from the profile page: after picking a file the user chooses the square part to use (drag to move; zoom with a slider, the wheel or a pinch; arrow keys and +/- too), and the page scales that to 256 px in the browser before sending it. `src/services/avatar.js` maps Authentication's `avatarUrl` to this site's `/avatar/...` and remembers the logged-in user's own in the `ld_avatar` cookie (set at login, refreshed on `/profile` and on change, dropped at logout) so the top bar can show it on every page without a lookup. `withAuthorAvatars` there adds each community set's author image (`authorId` from Content Sharing → one `GET /api/auth/avatars?ids=` for the whole page). Shown in the top bar, on the home page (your own, each post's author, top creators), the profile page, the friends list, and next to the author on the Community list and a set's page; where there is no image (or it fails to load) the initial shows instead. |
| `src/routes/usersRoutes.js` | `/users/:id` - another user's public profile, where every profile image on the site links (`+avatar(name, size, image, userId)` in `views/mixins/feed.pug`): the name they go by and their image, the sets they published, and the friend action that fits (add, withdraw, accept/decline, or - between friends - their email and the call buttons). Never shows an email to a non-friend. Your own id redirects to `/profile`. |
| `src/routes/messagesRoutes.js` | `/messages` - the messages users leave each other: the list of conversations (last message, unread mark), one conversation (`/messages/:userId`, with a write box; while open it polls `/messages/:userId/new?after=` every few seconds), and `GET /messages/unread`, which a script in `_nav.pug` asks on every page to light a dot on "More". Reached from a profile page or the friends list (Message). Message text is always rendered as text. |
| `src/routes/scheduleRoutes.js` | `/schedule` - a month calendar of video calls arranged with other users. The page is drawn in the browser by `src/public/schedule/schedule.js` (times are UTC on the server; only the browser knows the user's zone): pick a day, a half-hour start slot (busy and past ones are disabled), who and how long, and invite; lists of invitations to answer, upcoming calls and invitations awaiting an answer; around its time an agreed call has a Start call link. `src/public/schedule/reminder.js`, loaded on every page from `_nav.pug`, pops up "It's time for your video call" at the start time (one fetch of the day's agreed calls per page load, then a timer; announced once per browser) - the one who proposed the call is told to ring, the other to expect it. Reached from More → Schedule, a profile page, or the friends list. |
| `src/routes/assignmentsRoutes.js` | `/assignments` - homework one user gives a friend: `/assignments` (given to me, given by me, with progress), `/assignments/new` (pick a friend, a title, an optional note and due date, and from the community sets tick "Drill" and/or "Flash-card listening" per set - task names and types are taken from Content Sharing, not the form), `/assignments/:id` (the tasks; the student confirms and ticks them, the teacher can cancel). The assignment also arrives as a notice in the two people's chat (`views/message-thread.pug`), with a Confirm button while it is waiting. Reached from More → Assignments, the friends list, or a friend's profile. |
| `src/routes/extractRoutes.js` | `/community/:id/extract` - "Make a vocab set" from a listening set (a button on its page): the AI (Content Sharing's `/study/analyze`, the same as Scan) picks the vocabulary and expressions worth learning from the set's sentences - a long set a part at a time - and the page lists every pick with its meaning, its sentence with the word highlighted, and the Korean, all editable and each with a checkbox. Where a picked sentence is one of the set's own, the set's Korean is used. "New sentence" (per pick, or for every ticked one) asks llm-service for a fresh example sentence using the word or expression - different from its current one - with its Korean (`POST /community/:id/extract/sentences`, eight at a time); the blanks are found in the new sentence word for word, a reply that doesn't contain the word is dropped, and the original can be restored. Nothing is saved until the user chooses a new vocab set or one of their own and confirms; items are rebuilt with `ScanRoutes.cleanItems` (blanks re-read from the sentence), and adding to an existing set skips items it already has. |
| `src/routes/summaryRoutes.js` + `views/summary.pug` | `/summary` - "Summarize as a meeting" (More → Meeting summary, or a button on a listening set's page): the user ticks listening sets (up to 20; the number beside each is the order they are joined in), "Gather the sentences" puts every set's sentences into one transcript, and "Summarize the meeting" has llm-service summarize it as one meeting - overview, key points, decisions, action items, open questions - in English or Korean. The sentences have no speaker names. llm-service takes at most 8,000 characters per request, so a transcript over 6,500 characters is cut into parts at sentence boundaries (`/summary/gather` returns them); the page sends the parts two at a time to `POST /summary/notes`, showing "Summarizing part 3 of 13", then `POST /summary/merge` condenses the notes while they are still too long and writes the summary from them. A transcript over 450,000 characters (about 70 parts) is refused. The reply's headings are parsed into sections (`SummaryRoutes.parseSummary`); nothing is stored. |
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
| `GET /community` (`?tab=list\|create`; List's `?editId=` loads a row's inline editor), `GET /community/:id` (`?page=`, `?limit=10\|20\|50\|100` from the pager's "Per page" picker - a set's items are shown 20 per page by default, by field, never as raw JSON; vocab's Play button plays the page on screen) | login | `GET /api/sets`, `GET /api/sets/:id` |
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
| `POST /studio/transcribe` (multipart `file` + `language` = `en`/`ko`/`auto`, from the page's file picker or its MediaRecorder recording; ≤ 300 MB, ≤ 2 h; optional `part` - a recording longer than 30 min comes back one part at a time, `part: { index, count, start, end }` in the response, and the page offers a "Part n" chip per part - it measures the file in the browser to offer them before the first upload - with Transcribe sending the file again for the part picked; JSON `{ error }` on failure) | login | `POST /api/split/transcribe` (audio-split-service → stt-service; the page posts it with `XMLHttpRequest` to show a progress bar - upload %, then a moving bar with elapsed time while the audio is extracted and transcribed, then download % - and a Cancel button): the audio track as a compact mp3 (base64; from a video only the sound), words with timings and sentences. The page shows the transcript as clickable words per sentence - first click / second click selects a range, or "Use" takes a whole sentence; the crop is cut inside the real pauses the service found in the audio (`breaks` - the word times alone are too rough, and neighbouring clips would share sound) and can be nudged by ear |
| `POST /studio/clip?start=&end=` (raw `audio/mpeg` body = the extracted mp3; clip ≤ 120 s; JSON) | login | `POST /api/split/cut` (mono mp3, 20 ms fades) → `POST /api/sets/clips` (Content Sharing stores it as `/audio/<sha256>.mp3`) → `{ audioUrl, duration }`. The item (type, answer text - editable, blanks picked by clicking words, optional Korean) joins the page's draft list |
| `GET /studio/sets?q=` (the page's "Add to an existing listening set" search, as you type; JSON `{ sets, total }`) | login | `GET /api/sets?type=listening&q=` (newest 20 shown) |
| `GET /studio/sets/:id` (JSON) | login | `GET /api/sets/:id` → `{ id, name, desc, author, items }`; `400` for a non-listening set. The page lists the current items (each can be removed / undone) above the new ones and fills in the set's name, description and author |
| `POST /studio/sets/:id/update` `{ name, desc?, author?, keep: [index…], items }` (JSON) | login | `GET /api/sets/:id`, then `PATCH /api/sets/:id` with the kept current items + the new ones. Owner-only: a `403` becomes "Only the person who published this set can add to it - publish your items as a new set instead." |
| `POST /studio/clips?ranges=start-end,start-end,...` (raw `audio/mpeg` body, ≤ 150 ranges; used by "Add all sentences" and the automatic mode) | login | The same crop + store as `/studio/clip`, for many clips from one upload: six `POST /api/split/cut` + `POST /api/sets/clips` pairs at a time, answered as newline-delimited JSON while they finish (`{ i, audioUrl, duration }` or `{ i, error }` per range, then `{ done: true }`) so the page can show progress. The automatic mode translates (two `/community/translate` requests at a time) while this runs |
| `POST /studio/publish` `{ name, desc?, author?, items }` (JSON) | login | `POST /api/sets` with `type: "listening"`; the page then opens `/community/:id`, which plays each item's clip. Unpublished clips are deleted by Content Sharing's audio janitor after about an hour The page's "Transcribe and publish automatically" button chains the same three calls with no editing in between: every part of the recording is transcribed, every sentence cropped into a `full` item, each given its Korean meaning (`POST /community/translate`, optional, English recordings only - a failure there never blocks publishing), and the items published - split evenly into several sets (`Name (1/2)`, `Name (2/2)`) when there are more than 300. If it stops half-way, the items made so far go into the page's draft |
| `GET /scan` | login | — |
| `POST /scan/ocr` (multipart `file` + `language` = `auto`/`en` + `auto_rotate`; ≤ 20 MB; JSON `{ error }` on failure) | login | `POST /api/ocr/ocr` (ocr-service). The page fills its text box with the result and outlines the lines that were read on the picture preview |
| `POST /scan/analyze` `{ text, level }` (JSON) | login | `POST /api/study/analyze` (Content Sharing → llm-service) → sentences with Korean, vocabulary and expression cards (each ticked by default, with its sentence and the word highlighted). ▶ on a sentence speaks it through `/chat/speech` |
| `POST /scan/publish` `{ name, author?, desc?, items }` (JSON) | login | `POST /api/sets` with `type: "vocab"` (Content Sharing narrates each sentence via tts-service); the page then opens `/community/:id` |
| `GET /admin/listening` | admin | `GET /api/listening/voices` (voice pickers; shows an error banner if tts-service-listening is unreachable) |
| `POST /admin/listening/generate` `{ script, voices?, format?, seed?, cfg_scale?, temperature? }` (called by the page's `fetch`; other fields are dropped; JSON `{ error }` on failure) | admin | `POST /api/listening/generate` (`response: "json"`) → audio (base64) + words with speakers. The page plays it with a speaker-grouped read-along transcript, offers the audio and a timestamps JSON as downloads, and keeps this visit's takes in memory for comparison |
| `GET /admin/users`, `POST .../update`, `.../delete` | admin | `GET/POST/PATCH/DELETE /api/admin/api/users...` |
| `GET/POST /admin/users/:id/progress`, `.../delete` | admin | `GET/PATCH/DELETE /api/progress/admin/users/:id` - the same dashboard as `/progress` above the edit form, previewing edits live before Save |
| `GET /admin/storage`, `POST /admin/storage/audio-dir` (`path`, `deleteOld?` - a form) | admin | `GET /api/sets/admin/storage` (where the audio folder and the MongoDB database are, their sizes per collection, and free disk space), `POST /api/sets/admin/storage/audio-dir` (moves the audio folder: copies the files, switches Content Sharing over, remembers the choice). MongoDB's own data folder is shown but can't be changed from here |
| `GET /call`, `GET /call/ice-config`, `GET /call/protocol.js`, WebSocket `/call/ws` | login | `GET /api/signaling/ice-config`, `GET /api/signaling/protocol.js`, WebSocket `/api/signaling/ws` (signaling-service). Camera and microphone go browser to browser, not through any server |
| `GET /friends`; `POST /friends/request` (`email`), `/friends/requests/:id/accept`, `/decline`, `/withdraw`, `/friends/:userId/remove` | login | `GET /api/friends`, `POST /api/friends/requests`, `POST /api/friends/requests/:id/accept` · `/decline`, `DELETE /api/friends/requests/:id`, `DELETE /api/friends/:userId` (Authentication) |
| `GET /avatar/:userId`; `POST /profile/avatar` (raw image body), `POST /profile/avatar/remove` (page `fetch`, JSON `{ avatarUrl }` / `{ error }`) | login | `GET /api/auth/avatars/:userId`, `PUT /api/auth/me/avatar`, `DELETE /api/auth/me/avatar` (Authentication) |
| `POST /profile/nickname` (`nickname`; the profile page's form) | login | `PATCH /api/auth/me` → a new token, which replaces the session cookie's (the display name travels in the token), then `POST /api/sets/author/refresh` so the user's published sets show it at once. Login calls the same refresh. The read-only Author box on the set forms shows this name |
| `GET /users/:id`, `POST /users/:id/friend` | login | `GET /api/auth/users/:id`, `GET /api/friends/status/:id`, `GET /api/sets` (filtered to that author here), `POST /api/friends/requests { userId }` |
| `GET /messages`, `GET /messages/:userId`, `POST /messages/:userId` (`text`), `GET /messages/:userId/new?after=`, `GET /messages/unread` | login | `GET /api/messages`, `GET /api/messages/with/:userId` (`?before=` / `?after=`), `POST /api/messages`, `GET /api/messages/unread` (Authentication) |
| `GET /schedule` (`?with=<userId>`), `GET /schedule/data?from=&to=`, `GET /schedule/upcoming`, `POST /schedule`, `POST /schedule/:id/accept` · `/decline` · `/cancel` (all but the page: JSON for the page's script) | login | `GET /api/meetings`, `POST /api/meetings`, `POST /api/meetings/:id/accept` · `/decline`, `DELETE /api/meetings/:id`, `GET /api/friends` (who can be picked) (Authentication) |
| `GET /assignments`, `GET /assignments/new?to=`, `POST /assignments`, `GET /assignments/:id`, `POST /assignments/:id/confirm` · `/tasks/:taskId` · `/cancel` | login | `GET /api/assignments`, `POST /api/assignments`, `GET /api/assignments/:id`, `POST /api/assignments/:id/confirm`, `POST /api/assignments/:id/tasks/:taskId`, `DELETE /api/assignments/:id` (Authentication); `GET /api/friends`, `GET /api/sets` for the form |
| `GET /community/:id/extract`, `POST /community/:id/extract` `{ part, level }` → the picks (JSON), `POST /community/:id/extract/sentences` (and `POST /community/sentences`, the same for the set editor's "✨ New sentence with the blanked words" - vocab and dictation items: the AI writes a different sentence using the words picked as blanks, steered by the item's Korean keyword, and fills in its Korean; Undo puts the old sentence back) `{ level, items: [{ term, meaning, avoid? }] }` (1-8) → `{ sentences: [{ answer, ko, blanks } | null] }` via `POST /api/llm/chat/completions`, `POST /community/:id/extract/save` `{ mode: "new" \| "existing", name?, desc?, targetId?, items }` → `{ id, added, skipped }` | login | `GET /api/sets/:id`, `GET /api/sets?type=vocab` (the user's own, to add to), `POST /api/study/analyze` (llm-service), then `POST /api/sets` or `PATCH /api/sets/:id` (owner-only; Content Sharing narrates the new sentences) |
| `POST /community/:id/visibility` `{ visibility: "public" \| "private" }` (the set page's "Make private" / "Make public", shown to the owner) → back to the set page | login | `PATCH /api/sets/:id` (owner-only) |
| `GET /summary?sets=a,b` (page, those sets ticked), `POST /summary/gather` `{ sets }` → `{ sources, sentences: [{ source, text }], chars, parts: [{ from, to }] }`, `POST /summary/notes` `{ text }` (one part) → `{ notes }`, `POST /summary/merge` `{ notes: [..], language }` → the summary, `POST /summary/summarize` (all in one request) `{ sets, language: "en" \| "ko" }` → `{ overview, sections: [{ title, items }], language, sources, sentenceCount, parts, seconds }` | login | `GET /api/sets?type=listening`, `GET /api/sets/:id`, `POST /api/llm/chat/completions` (notes: one; merge: one per condensing chunk, then one for the summary) |

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
