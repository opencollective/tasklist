# tasklist

Instant, shareable, real-time task lists — [tasklist.sh](https://tasklist.sh)

Open the app and you're on a fresh list with its own URL. Type tasks, then share the
link (or QR code): anyone who opens it can add tasks, grab one, comment — with image
and file attachments — and check it off. Everything syncs live between everyone
looking at the same list.

- **No accounts, no signup, no backend.** Nothing to configure, nothing to host.
- **One self-contained HTML file.** `index.html` (~55 KB) contains all markup, CSS,
  cryptography, QR generation, and app logic. Zero runtime dependencies, zero CDN
  imports, no build step. It works copied to any static host, renamed, or opened
  from a USB stick.
- **Offline-first PWA.** Install it to your home screen; the app loads with no
  network, changes are queued on-device and published when you're back online.
- **Multiple lists.** Every list you open stays on your device as a card in a
  stack — collapse, expand, or remove them.

## How it works

Under the hood, tasklist is a [nostr](https://github.com/nostr-protocol/nostr)
client. Every action — creating a task, claiming it, completing it, commenting —
is a signed nostr event published to public relays, and every client rebuilds list
state by folding that append-only event stream. A keypair is silently generated in
your browser on first visit (it never leaves `localStorage`; you can back it up
from the About screen).

| kind  | meaning       | notes                                              |
|-------|---------------|----------------------------------------------------|
| 0     | profile name  | standard nostr profile metadata                    |
| 2100  | create task   | task id = event id                                 |
| 2101  | task action   | claim / unclaim / done / undone / delete           |
| 2102  | list name     | latest wins                                        |
| 2103  | comment       | optional attachment tag                            |
| 24242 | upload auth   | [Blossom](https://github.com/hzrd149/blossom) BUD-02, sent as HTTP header only |

All list events carry a `['t', <listId>]` tag; the list id is 16 random hex
characters carried in the URL fragment. Attachments are uploaded to a Blossom
server (default: `blossom.primal.net`, 10 MB cap).

Default relays: `relay.damus.io`, `nos.lol`, `relay.primal.net`, `offchain.pub`.
Override via `localStorage`: `tasklist.relays` (JSON array of wss URLs) and
`tasklist.blossom` (server URL).

## Files

```
index.html            the entire app — single self-contained file
sw.js                 service worker: offline app-shell cache (PWA)
manifest.webmanifest  PWA manifest
icon-*.png            app icons
AGENT.md              protocol details, invariants, and contributor instructions
```

## Self-hosting

Copy the files above to any static host — that's the whole deployment. `index.html`
alone also works (you lose installability/offline shell, nothing else). There is no
server-side component; "your" instance talks to the same relays, so lists are
portable between instances.

## Development

Edit `index.html` directly — the file is deliberately readable (trimmed, never
minified) so anyone can view-source and audit what signs with their key. Read
[AGENT.md](AGENT.md) first: it documents the event model, the derived-state rules,
the UI contract, and the invariants checklist every change must pass.
