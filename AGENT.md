# AGENT.md — Tasklist

Instructions for any agent (or human) working on this project. Read this fully before
changing code. The project is small on purpose; the discipline around it is the product.

## What this is

Tasklist is an instant, shareable, real-time task list. Open the app → you're redirected
to a unique list URL → type tasks → share the URL (link or QR) → anyone who opens it can
add tasks, assign one to themselves, comment (with image/file attachments), and check it
off. Everything syncs live between everyone viewing the same URL.

There is no backend, no accounts, no signup. Under the hood it is a nostr client:
every mutation is a signed nostr event published to public relays, and every client
reconstructs list state by folding those events. The word "nostr" is deliberately never
shown in the UI — users just see a task list that works. Keep it that way.

## Philosophy (the rules that shaped every decision)

1. **One self-contained HTML file is the deliverable.** `index.html` contains
   everything: markup, CSS, crypto, QR generator, app logic. Zero runtime dependencies,
   zero CDN imports, zero build-time npm packages. It must work when copied to any static
   host, renamed, or opened from a USB stick years from now. Never introduce an external
   `<script src>` or a package.json dependency for the app itself.

2. **Zero-friction first run.** No modal walls, no onboarding. A keypair is silently
   generated into localStorage on first visit; the user is "Anon" until a name is needed.
   The only moment we ask for a name is the first *social* action (claiming a task or
   commenting), and even then "Stay anonymous" is one tap away. Any new feature must
   preserve this: never block task entry behind a prompt.

3. **Event-sourced, append-only state.** Nothing is ever mutated or deleted server-side.
   Clients fold an append-only event stream into state (`taskState()` is the reducer).
   New features should follow the same shape: define an event, extend the reducer,
   render from derived state. Last-write-wins by `(created_at, id)` everywhere.

4. **Optimistic and offline-first.** Local events are applied to the UI immediately
   (`processEvent` before/independent of relay ACK), queued in `pending` localStorage,
   and re-sent on reconnect. All received events are cached per-list in localStorage so
   a reload renders instantly and works fully offline. Never add a feature that requires
   a round-trip before the UI responds.

5. **Everything is verified, nothing is trusted from memory.** The crypto and QR code
   in this project are hand-written. They are trustworthy *only* because of the test
   discipline: BIP-340 official vectors + an independent verifier, and bit-for-bit
   equality with a battle-tested reference QR encoder. If you touch the crypto or QR
   script blocks, those verifications are not optional. History lesson:
   three subtle QR bugs (reversed format bits, misplaced format copy, reversed RS
   generator polynomial) all produced *plausible-looking* QR codes that no scanner could
   read. Only reference comparison caught them.

6. **Readable source is a feature.** The file is kept trim but never
   minified/mangled. Anyone can view-source and audit what signs with
   their key. Don't add a mangling minifier.

## Repository layout

```
tasklist/
├── AGENT.md              ← you are here (also served at tasklist.sh/AGENT.md)
├── llms.txt              ← agent-facing protocol summary, served at tasklist.sh/llms.txt
├── index.html            ← THE deliverable: markup, CSS, crypto (secp256k1, BIP-340
│                           Schnorr, bech32 — window.NostrCrypto), QR encoder
│                           (window.QR), and all app logic, in three <script> blocks
├── sw.js                 ← service worker: offline app-shell cache (PWA)
├── manifest.webmanifest  ← PWA manifest        icon-*.png ← app icons
├── vercel.json           ← cron schedule for the bot notifier
└── api/                  ← Telegram bot (Vercel functions; see "The Telegram bot")
```

There is no build step and no checked-in test suite: edit `index.html` directly and
keep it self-contained. Verify changes by driving the app headlessly (Chromium
`--headless=new --dump-dom` with an injected script that points `tasklist.relays`
at a local/dead relay) and, for the bot, by invoking the handlers in `api/` with a
mock Telegram API and asserting the resulting events on the relays. If you touch
the crypto or QR blocks, test against BIP-340 official vectors / a reference QR
encoder — see "Everything is verified" above; history shows plausible-looking
wrong output in both.

Deploys: pushing to `main` on github.com/opencollective/tasklist auto-deploys to
tasklist.sh (Vercel).

## The protocol (event model)

All list events carry tags `['t', listId]` and `['client', 'tasklist']`, plus
`['name', displayName]` when the author has set a name (denormalized so names work
without a profile lookup). The list id is 16 hex chars from the URL fragment (`#abc…`).

| kind  | meaning        | content                | extra tags |
|-------|----------------|------------------------|------------|
| 0     | profile        | JSON `{name}`          | (standard nostr kind 0; no `t` tag) |
| 2100  | create task    | task title (plain text)| — (task id = event id) |
| 2101  | task action    | empty                  | `['e', taskId]`, `['action', claim\|unclaim\|done\|undone\|delete]` |
| 2102  | list metadata  | list name              | — (latest wins) |
| 2103  | comment        | comment text           | `['e', taskId]`, optional `['attachment', url, mime, filename]` |
| 24242 | blossom auth   | "Upload …"             | `['t','upload']`, `['x', sha256]`, `['expiration', ts]` — sent as HTTP header, never to relays |

Derived state rules (see `taskState()` — keep them in one place):
- Events fold in `(created_at, id)` order. Ties break lexicographically by id.
- `claim` sets assignee to its author (takeover allowed); `unclaim` clears it only if
  by the current assignee. `done`/`undone` toggle; anyone may complete. `delete` counts
  only from the task's creator.
- **List owner** = author of the earliest event in the list. This is a heuristic (there
  is no registration event); it's stable in practice because creators always type a task
  or name the list before sharing. The title bar shows the owner's name to everyone.
- Local timestamps are forced monotonic per client (`now()` bumps `lastCreatedAt`) so
  same-second sequences (claim→done) fold in the right order.

Names resolve: own localStorage → kind 0 (latest) → per-event `name` tags → "Anon".
Profiles are fetched via a second subscription (`tlp`) whose author list grows as new
pubkeys appear in the list; it is re-issued (debounced) on growth.

### Relays and Blossom

- Default relays: damus, nos.lol, primal, offchain.pub. Override for testing/self-hosting
  via localStorage `tasklist.relays` (JSON array of wss URLs).
- Publishes go to every open relay; events are deduped by id on receipt. Reconnect uses
  exponential backoff (0.8s → 30s cap) plus a 15s sweep.
- Attachments: Blossom protocol (BUD-02). sha256 the blob, sign a kind 24242 auth event,
  `PUT {server}/upload` with `Authorization: Nostr <base64(event)>`. Default server
  `https://blossom.primal.net`, override via localStorage `tasklist.blossom`. 10 MB cap.
  Attachment URLs from other users are rendered only if they match `^https?://`.

## UI interaction contract (don't regress these)

- Bare URL → replaceState to the most recently opened tasklist that has cached events,
  or to a fresh `#listId` on a first visit. Never mint a new list on a bare URL when the
  device already has one — it shows up as an empty ghost card next to the real lists.
  A new list is created only by an explicit "+ New tasklist". Hash change → full reload.
- New-task input: always focused, Enter adds and keeps focus. Never steal its focus.
- **The circle is the only thing that completes a task, and it works for anyone in one
  tap** — no claim required first. Tapping the row toggles the inline thread, where
  "I'll take this one" / "Take over this task" lets someone optionally signal they plan
  to do a task. Dashed circle = unassigned. Claims, dones, reopens, and creation all
  appear in the thread as system entries interleaved chronologically with comments, so
  the thread is the task's full history.
- Name prompt appears at most once, on first claim/comment, skippable.
- Title bar: `{owner}'s {listname}` — owner name editable only by the owner (opens
  profile-name modal, publishes kind 0); list name editable by anyone (kind 2102).
- Footer holds only connection status + About. About contains the identity backup
  (npub / reveal-and-copy nsec) and the current user's change-name control.
- Re-renders happen on every incoming event: `render()` rebuilds the DOM, so any
  stateful widget (comment drafts, pending attachments, focus) must survive a rebuild —
  see `drafts`, `pendingFiles`, and the `cmt-input` focus-restore pattern in `render()`.
- All user content is inserted via `textContent`/`el()` helper — never innerHTML with
  user data. Keep it XSS-proof. `linkify()` is the one exception that builds elements
  from user text: it only ever matches `https?://…` (so the href scheme can't be
  attacked) and everything around a match stays a text node. Links display shortened
  (`shortUrl()`: no scheme/www, host + first path segment, rest elided) with the full
  URL in `title`.

## The Telegram bot (`api/`)

The bot is the one server-side component, and it is *just another nostr client*:
Vercel functions (`api/telegram.mjs` webhook, `api/cron.mjs` 1-minute notifier) that
sign and publish the same kinds listed above. Rules:

- **Zero npm dependencies here too.** Native `fetch`/`WebSocket` (Node 22+), Upstash
  Redis over REST (`_lib/kv.mjs`), Telegram over HTTPS (`_lib/tg.mjs`).
- `_lib/crypto.mjs` is extracted **verbatim** from index.html's first `<script>`
  block; `_lib/state.mjs` is a port of `processEvent`/`taskState`. If those change in
  index.html, re-sync both — same validation, caps, and fold order, always.
- Per-Telegram-user identity: sk = HMAC(`TASKLIST_MASTER_SECRET`, `tg-user:<id>`)
  mod n (`_lib/bot.mjs`). Losing the master secret orphans every Telegram identity;
  leaking it lets anyone sign as them. It lives only in Vercel env.
- Scopes: every chat gets its own current list, keyed by chatKey = chat id, plus
  `:<threadId>` inside a forum topic (topics are independent lists). Lists are
  auto-created on first /task — never make the user run a setup command first.
  Group-scoped lists are auto-named after the chat title.
- KV state: `chat:{chatKey}` link `{listId, chatId, threadId}`, `chats` set,
  `cursor:{chatKey}` + `seen:{chatKey}` (notification dedupe; a scope's own
  publishes are pre-seeded so it never gets its own actions echoed back),
  `msg:{chatId}:{messageId}` → taskId (reply-to-comment and buttons;
  callback_data carries a 16-char event-id prefix, resolved against a fresh relay
  fetch), `byname:{chatKey}:{slug}` → listId (/tasklist name switching).
- Task messages — from Telegram actions and from cron notifications alike — carry
  ✓ Done plus "I'll take it" while unassigned; claim state is re-checked on tap.
- Stale CTAs self-heal (`_lib/taskmsgs.mjs`): every message displaying a task is
  registered with its base text; when the task's state changes (button tap, or a
  change arriving from the relays via cron), all of them are edited in place —
  original text kept, buttons swapped, a status line appended ('✅ Done — Anna' /
  '👋 Anna is on it'). Activity-log messages are separate sends and are never
  rewritten into something they didn't say; edits only ever append status.
- Command surface: /task, /tasks, /tasklist [name|url], /unlink, /help
  (/add, /list, /newlist, /link kept as hidden aliases).
- Webhook auth = Telegram `secret_token` header; cron auth = Vercel `CRON_SECRET`
  bearer. Always answer the webhook 200 (Telegram retry-storms otherwise).
- Test: `node <scratch>/bot-e2e.mjs` style — mock Telegram API captures sends, mem
  KV, real relays with a throwaway list id, then assert the fold from the relays.

## How to add a feature (the pattern)

Example: "add due dates".

1. **Event first.** Decide the event: e.g. reuse kind 2101 with `['action','due']` and a
   `['due', '<unix>']` tag, or a new kind (next free: 2104). Latest-wins by fold order.
2. **Reducer.** Extend `taskState()` (or add a parallel map like `comments`). Validate
   and length-cap everything read from events — they come from strangers.
3. **Render.** Derive UI from state only. Add controls; publish via `signAndSend()`
   (it applies the event locally first — optimistic by construction).
4. **Cache/compat.** New kinds must be added to the relay REQ filter AND flow through
   `processEvent` so they land in the localStorage cache. Old clients must safely ignore
   your new events (they already ignore unknown kinds/actions — keep that true), and new
   clients must tolerate their absence. Never repurpose an existing kind/action meaning.
5. **Test.** Drive the change headlessly: perform the action as Alice, assert Bob
   (a second profile/context) sees it, then reload with relays unreachable and
   assert it renders from the localStorage cache.
6. **Review the rendered result.** Take headless screenshots and look at them —
   layout regressions don't show up in DOM assertions.

## Testing notes

- Web: run Chromium `--headless=new` against `file://…/index.html#<listid>` with an
  early injected script that (a) sets `localStorage['tasklist.relays']` to a local
  or dead relay so runs never touch public relays, and (b) shims
  `requestAnimationFrame` to `setTimeout` (it stops firing under
  `--virtual-time-budget`, freezing the app's render loop). A shared
  `--user-data-dir` persists localStorage across runs for multi-list/cache flows.
- Bot (`api/`): import the handlers directly, stub the Telegram API with a local
  HTTP server that captures calls, leave KV unset (falls back to in-memory), and
  use a throwaway random list id — then assert the resulting events by fetching
  them back from the relays and folding.
- Two users = two browser profiles / two Telegram user ids (separate keys). Assert
  cross-user propagation by polling, never fixed sleeps.
- QR verification is two independent layers: (a) bit-for-bit equality against a
  reference encoder (Kazuhiko Arase's) for the same version/ECC across all 8 masks;
  (b) screenshot → decode round-trip (OpenCV's *encoder* is buggy — use cv2 only to
  decode rendered PNGs, and treat Arase as ground truth for matrices).
- If you must debug a "nothing decodes / nothing verifies" crypto-ish failure: extract
  intermediate values (codewords, format bits, signatures) and diff against a reference
  implementation stage by stage. That is how all three historical QR bugs were found.

## Invariants checklist (run through before shipping)

- [ ] `index.html` still a single self-contained file; no external requests except
      relays/blossom; no npm dependencies anywhere (app or `api/`)
- [ ] Crypto/QR untouched, or re-verified against reference vectors as above
- [ ] Works offline: reload with relays down renders full state from cache
- [ ] A stranger's malformed/hostile event cannot break rendering (validate + cap all fields)
- [ ] No "nostr" wording in user-facing UI; no new prompts blocking first task entry
- [ ] Old clients ignore your new events; new client tolerates lists created by old ones
- [ ] Raw size still ≈ 60 KB; if you added > 5 KB, justify it
- [ ] Protocol changes reflected in `llms.txt` (the public agent-facing doc) and README
- [ ] Headless screenshots reviewed after the change
