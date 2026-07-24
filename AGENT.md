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

1. **One self-contained HTML file is the deliverable.** `dist/tasklist.html` contains
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
   suite: BIP-340 official vectors + an independent verifier, bit-for-bit equality with
   a battle-tested reference QR encoder, and a full multiplayer e2e suite. If you touch
   `crypto.js` or `qr.js`, the corresponding tests are not optional. History lesson:
   three subtle QR bugs (reversed format bits, misplaced format copy, reversed RS
   generator polynomial) all produced *plausible-looking* QR codes that no scanner could
   read. Only reference comparison caught them.

6. **Readable source is a feature.** The built file is trimmed (comments/indentation
   stripped) but not minified/mangled. Anyone can view-source and audit what signs with
   their key. Don't add a mangling minifier.

## Repository layout

```
tasklist/
├── AGENT.md            ← you are here
├── build.js            ← assembles dist/tasklist.html from src/ (node build.js)
├── src/
│   ├── template.html   ← markup + all CSS + %%CRYPTO%% %%QR%% %%APP%% placeholders
│   ├── crypto.js       ← secp256k1, BIP-340 Schnorr, SHA-256 (WebCrypto), bech32,
│   │                     nostr event finalization. No deps. Exposes window.NostrCrypto
│   ├── qr.js           ← QR encoder (byte mode, ECC M, v1-10) → SVG. Exposes window.QR
│   └── app.js          ← everything else: state, relay pool, blossom upload, UI
├── test/
│   ├── crypto.test.js  ← BIP-340 vectors + independent Schnorr verifier + bech32 checks
│   ├── qr.test.js      ← renders QRs in Chromium, decodes with OpenCV (python3/cv2)
│   ├── relay.js        ← minimal in-memory nostr relay (uses playwright's bundled ws)
│   └── e2e.js          ← full multiplayer suite: 2 browser contexts + local relay
│                         + mock Blossom server. THE gate for every change.
└── dist/
    └── tasklist.html   ← the deliverable (~48 KB raw, ~16 KB gzipped)
```

Build: `node build.js`. Test: `node test/crypto.test.js && node test/qr.test.js && node test/e2e.js`.
The e2e suite must end with `ALL CHECKS PASSED` before any change ships.

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

- Bare URL → replaceState to a fresh `#listId`. Hash change → full reload.
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
  user data. Keep it XSS-proof.

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
5. **Test.** Add e2e checks: perform the action as Alice, assert Bob sees it live, then
   kill the relay, reload, and assert it renders from cache. Follow the existing
   `check()`/`until()` style in `test/e2e.js`.
6. **Build + full suite.** `node build.js && node test/e2e.js` (plus crypto/QR tests if
   touched). Screenshot review: the suite writes PNGs to `dist/` — look at them.

## Testing infrastructure notes

- Tests need no network. `test/relay.js` is an in-memory nostr relay; `test/e2e.js`
  spins it up with a mock Blossom server (which *enforces* the auth protocol: kind
  24242, matching `x` sha256, signed). Browser contexts get `tasklist.relays` /
  `tasklist.blossom` pointed at localhost via `addInitScript`.
- `ws` server comes from playwright's bundled `utilsBundle` (no npm install needed).
- QR verification is two independent layers: (a) bit-for-bit equality against the
  Kazuhiko Arase encoder bundled inside npm's `qrcode-terminal`
  (`/opt/node*/lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode/`), for
  the same version/ECC across all 8 masks; (b) screenshot → OpenCV decode round-trip.
  Note: OpenCV's *encoder* is buggy (transposed format info) and its detector fails on
  some perfectly crisp synthetic images — treat cv2 as a decoder of rendered PNGs only,
  and treat Arase as ground truth for matrices.
- Two browser contexts = two users (separate localStorage/keys). Assert cross-user
  propagation with polling (`until`), never fixed sleeps.
- If you must debug a "nothing decodes / nothing verifies" crypto-ish failure: extract
  intermediate values (codewords, format bits, signatures) and diff against a reference
  implementation stage by stage. That is how all three historical QR bugs were found.

## Environment constraints (agent sandbox)

The development sandbox may have **no access to npm, pip, apt, or any CDN** (403 on
registry hosts) and cannot reach public relays or blossom servers. This is why the
project vendors nothing and tests everything locally. Do not add steps that require
fetching packages; do not "verify" against live relays from the sandbox — trust the
local relay + protocol-faithful mocks, and flag anything that can only be confirmed
against production (e.g. a new Blossom server's quirks) in your handoff message.

## Invariants checklist (run through before shipping)

- [ ] `dist/tasklist.html` still a single file, no external requests except relays/blossom
- [ ] `node test/crypto.test.js`, `node test/qr.test.js` (if touched), `node test/e2e.js` all green
- [ ] Works offline: reload with relays down renders full state from cache
- [ ] A stranger's malformed/hostile event cannot break rendering (validate + cap all fields)
- [ ] No "nostr" wording in user-facing UI; no new prompts blocking first task entry
- [ ] Old clients ignore your new events; new client tolerates lists created by old ones
- [ ] Raw size still ≈ 50 KB; if you added > 5 KB, justify it
- [ ] Screenshots in `dist/` reviewed after e2e run
