# tasklist

Instant, shareable, real-time task lists — [tasklist.sh](https://tasklist.sh)

Open the app and you're on a fresh list with its own URL. Type tasks, then share the
link (or QR code): anyone who opens it can add tasks, grab one, comment — with image
and file attachments — and check it off. Everything syncs live between everyone
looking at the same list.

- **No accounts, no signup, no backend.** Nothing to configure, nothing to host.
- **One self-contained HTML file.** `index.html` (~85 KB) contains all markup, CSS,
  cryptography, QR generation, and app logic. Zero runtime dependencies, zero CDN
  imports, no build step. It works copied to any static host, renamed, or opened
  from a USB stick.
- **Offline-first PWA.** Install it to your home screen; the app loads with no
  network, changes are queued on-device and published when you're back online.
- **Multiple lists.** Every list you open stays on your device as a card in a
  stack — collapse, expand, or remove them.
- **Optional title encryption.** Generate and download a private key per list,
  or import a collaborator's key. New task titles are encrypted before publishing
  and decrypted automatically in browsers with the key.

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

## Encrypting task titles

Open **Settings → Title encryption → Generate & download key**. The browser
generates a random 256-bit encryption key, saves it in localStorage for that list,
and downloads `tasklist-key-<listId>.json`. New titles posted from this browser are
encrypted; existing public titles stay public. **Download key** makes another
backup without generating a replacement. Importing a key enables the same behavior
on another device and supports key files from compatible agent clients.

Give the downloaded JSON file to an agent through a private local file or secret
store, and share it separately with collaborators who should read the titles.
It contains the list ID, encryption key, and public fingerprint; it does not
contain your signing identity. The ordinary tasklist URL and QR code never include
the encryption key. See [llms.txt](llms.txt) for the agent wire format.

Encrypted tasks have a **🔓/🔒** button to switch locally between the readable title
and the full ciphertext. The signed event cache and offline publication queue keep
only ciphertext. Missing, invalid, or removed keys never make this browser fall
back to plaintext posting for a list it knows uses encryption. Removing a key from
this device preserves that protection; importing the backup restores access.

Only **task titles** are encrypted. Comments, attachments, list names, identities,
list IDs, timestamps, and completion/assignment activity remain public. Other
clients, including older app versions, can still add public titles to the same
list. This is content encryption, not membership or write-access control. There
is no retroactive encryption or key rotation in this version.

Keep a private backup: clearing site data removes local keys. Any holder of the
key can decrypt titles encrypted with it, including earlier ones. Website scripts
can read localStorage and displayed titles, so this protects against relay readers,
not a compromised website or device. Serve the app over HTTPS (or localhost) for
Web Crypto support. Plain tasklists still work without encryption setup.

The optional Telegram bot has no decryption keys. It displays encrypted titles as
locked tasks, keeps their action buttons working, and declines `/task` additions
when its fetched list history contains encrypted titles. Use the web app or a
compatible agent to add encrypted titles.

## Telegram bot

The `api/` directory is an optional Telegram bot (Vercel functions, still zero
dependencies): every chat, group, channel, or forum topic transparently gets its
own tasklist the first time someone adds a task. Check tasks off with inline
✓ buttons, comment by replying, and a cron poller pushes live activity from the
relays into linked chats. Each Telegram user gets their own nostr keypair
(derived server-side from `TASKLIST_MASTER_SECRET`), so their actions are
attributed by name exactly like a web user's.

Commands: `/task <task>` (any message in a private chat), `/tasks`,
`/tasklist [name or URL]` to switch lists or create one by name, `/unlink`,
`/help`.

Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (set the webhook with
`secret_token`), `TASKLIST_MASTER_SECRET`, `CRON_SECRET`, and an Upstash Redis
KV (`KV_REST_API_URL`/`KV_REST_API_TOKEN`) for chat↔list links and cursors.

## Files

```
index.html            the entire app — single self-contained file
sw.js                 service worker: offline app-shell cache (PWA)
manifest.webmanifest  PWA manifest
icon-*.png            app icons
api/                  Telegram bot (optional; Vercel functions + cron)
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

Run `node --test tests/*.mjs` with Node.js 22+ for dependency-free title
encryption, malformed-event, bot-fold, and official BIP-340 vector checks. The
vectors are from [bitcoin/bips](https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv).
