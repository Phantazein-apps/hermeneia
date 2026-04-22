# Hermeneia

WhatsApp bridge for Claude. Drag to install, scan a QR code, chat.

> **ἑρμηνεία** — *interpretation, translation between worlds.*
> From Hermes, messenger of the gods. Part of the [Phantazein](https://phantazein.com) toolkit.

## Install

Download `Hermeneia.mcpb` from [Releases](https://github.com/Phantazein-apps/hermeneia/releases/latest) and drag it into Claude Desktop.

That's it. No terminal, no Python, no Go, no config files.

> **Platform:** macOS (Apple Silicon) only for now.

## Connect WhatsApp

1. Ask Claude: **"check my WhatsApp status"**
2. A browser page opens with a QR code
3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
4. Scan the code
5. Done — Claude can now read and send your messages

The session persists across restarts. You only scan once.

## What Claude can do

- **Read messages** — search, filter by date/contact/chat, get context around any message
- **Unread summary** — "summarize my unread WhatsApp" works out of the box
- **Send messages** — text, images, videos, documents, voice notes
- **Download and view images** — Claude can see photos from your chats, not just file paths
- **Browse contacts** — search by name or phone number
- **Browse chats** — list all conversations with unread counts; archived chats hidden by default
- **Community awareness** — chats show which WhatsApp community they belong to
- **Deep history** — syncs up to 3 years of message history (1000 messages per chat) on first connect

## Multiple WhatsApp Accounts

Connect as many WhatsApp numbers as you want (personal, work, family, etc.):

1. Ask Claude: **"add another WhatsApp account called work"**
2. A new QR page opens — scan it with the other phone
3. Done — Claude can now search and send across all your accounts

All accounts reconnect automatically on restart. When searching messages, Claude searches all accounts by default. When sending, Claude asks which account to use if you have more than one.

**Tools:** `list_accounts`, `add_account`, `remove_account`

## About the security warning

When you install Hermeneia, Claude Desktop shows a warning:

> *"Installing will grant this extension access to everything on your computer. Any developer information shown has not been verified by Anthropic."*

**This warning appears for every third-party extension** — it is not specific to Hermeneia. Anthropic shows it because they haven't reviewed the code. This is the same model as browser extensions, VS Code extensions, or npm packages.

WhatsApp does not offer a public API for personal accounts. Any tool that connects your personal WhatsApp — whether it's WhatsApp Web, a bridge, or an automation tool — uses the same reverse-engineered protocol. This means it cannot go through an official OAuth flow, which is what Anthropic's verified directory would require.

**Until WhatsApp releases an official personal messaging API, this is the only way to build a WhatsApp integration for Claude.** The code is fully open-source — you can read every line at [github.com/Phantazein-apps/hermeneia](https://github.com/Phantazein-apps/hermeneia).

## Privacy

All data stays on your computer. Messages are stored in a local SQLite database under `data/`. Nothing is sent to any server except WhatsApp's own servers (the same servers WhatsApp Web connects to). No telemetry, no cloud, no accounts.

## Architecture

A Go subprocess handles the WhatsApp connection; a Node.js process runs the MCP server and SQLite store.

1. **Go bridge** — [whatsmeow](https://github.com/tulir/whatsmeow) handles the WhatsApp Web protocol, QR auth, history sync, and message sending
2. **MCP server** — [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) exposes 17 tools to Claude via stdio
3. **SQLite** — [sql.js](https://github.com/sql-js/sql.js) stores messages, chats, and contacts locally
4. **Setup page** — local HTTP server for QR code display (only during auth)

```
Claude Desktop ←→ MCP (stdio) ←→ Node.js ←→ Go bridge ←→ WhatsApp
                                    ↕
                                 SQLite
                              (local data)
```

## How Hermeneia compares

*Last updated: April 21, 2026*

Origin chain: [`lharries/whatsapp-mcp`](https://github.com/lharries/whatsapp-mcp) (original, abandoned April 2025) → [`verygoodplugins/whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp) (active fork, Python + Go) → Hermeneia (TypeScript + Go rewrite).

### What Hermeneia adds vs the upstream fork

- **TypeScript MCP layer** (vs Python upstream). Same Go/whatsmeow bridge, but ships as a single Node bundle with no Python toolchain.
- **`.mcpb` drag-and-drop install** vs `git clone` + `uv` setup. Drag onto Claude Desktop, scan QR, done.
- **Multi-account** - connect personal, work, family, business numbers in parallel; Claude searches across all by default. Upstream is single-account.
- **Deep history sync on first connect** (3 years / 1,000 msgs per chat). Upstream syncs forward from connection time only.
- **Inline image display** - `download_media` returns the image so Claude sees photos. Upstream returns file paths.
- **Unread tracking + filtering** using native WhatsApp counts. Upstream has no unread state.
- **Archived chat detection** (excluded by default).
- **Community / parent-group awareness** - chats know which Community they belong to.
- **Full contact resolution** - phone numbers, LIDs, push names, verified names. Upstream stops at JIDs.
- **Device shows as "Claude"** in WhatsApp Linked Devices instead of a generic browser string.
- **17 tools** vs upstream's ~10.

### Vs other WhatsApp MCPs

- **`jlucaso1` (Baileys TS)** - different protocol library; missing whatsmeow's media fidelity. No `.mcpb`, no multi-account.
- **`wweb-mcp` / `fyimail/whatsapp-mcp2`** - Puppeteer + `whatsapp-web.js`. Brittle, breaks on WhatsApp updates. Author flags it as "testing only."
- **41-tool extended fork** - broader tool surface (group admin, presence, webhooks) but less polish (no `.mcpb`, no inline images).
- **WhatsApp Cloud API MCPs** (`wania-kazmi` etc.) - Business API only, can't touch personal accounts. Different product.
- **Commercial bridges** (Composio, Whapi.Cloud, Maytapi, Telinfy) - paid SaaS routing your messages through their cloud. Hermeneia stays local.

### Trade-offs

- macOS Apple Silicon only for now. Upstream runs anywhere Python + Go runs.
- No webhook forwarding for incoming messages (upstream `verygoodplugins` has this).
- No semantic search over message history (IMAP-search-equivalent only).

## Beta: Epistole mirror

> **Not for everyone.** This section only applies if you run (or plan to run) your own [Epistole](https://github.com/Phantazein-apps/epistole) server — a Cloudflare Worker you deploy to your own Cloudflare account. If you don't have one, none of this applies; skip the section and use Hermeneia as-is from your Mac. Setting up Epistole is a separate ~30-minute project; see Epistole's README.

Hermeneia can optionally push a copy of incoming WhatsApp events to a remote Epistole instance so that Epistole's `semantic_search` indexes WhatsApp history alongside email. **Off by default.** Enabling the mirror does not change any existing behavior — sends, media, and the local `messages.db` all still live on your Mac.

### Why would you want this?

The main reason: **mobile access**. Hermeneia is a desktop-only extension — your WhatsApp history is only searchable from the Mac running Claude Desktop. Epistole is a Cloudflare Worker you control, reachable from anywhere you have a Claude app (iOS, Android, web) via the remote MCP protocol. Turning on the mirror means:

- Ask Claude on your phone *"what did Tyler say about Thursday?"* and get hits from WhatsApp + email in the same answer
- Semantic search (not just substring) across your WhatsApp messages — *"the message where my mom sent the Airbnb link"*
- Unified ranking across channels — one query, results from email and WhatsApp interleaved by relevance

It's strictly additive. Your desktop Hermeneia keeps doing everything it did before (sending, media, local search via `list_messages`). The mirror is just a fan-out write pipe for the subset of use cases that benefit from being remote.

### What it mirrors

- After each durable local write (message, chat, contact), best-effort POSTs a copy to `POST /api/wa/push` on your Epistole instance.
- Batches events (1.5s debounce, 50-event flush) and sends one-way over HTTPS with a Bearer token.
- Sends a heartbeat every ~60s per connected account so Epistole knows the bridge is alive.
- One-shot historical backfill via the `epistole_backfill` MCP tool — walks existing `messages.db` for an account and ships it in batches of 100.

### What it does NOT do

- **No media bytes are uploaded.** Only metadata (media type, filename, caption text). Voice notes, photos, docs stay on your Mac.
- **No remote sends.** Epistole cannot send WhatsApp messages through Hermeneia — the channel is push-only, Hermeneia → Epistole. If you ask Claude on your phone "send Tyler a message", that tool isn't exposed. You'd need to be at your Mac.
- **No state dependency.** If Epistole is unreachable, the call is dropped after short exponential backoff; Hermeneia keeps running normally. Lossy by design — the local `messages.db` remains the source of truth.
- **No cloud-locked contacts.** `chat_name` is passed at embedding time only (improves retrieval quality for group-scoped queries); Epistole doesn't store a copy of your contact list beyond what it needs for search.

### Configuration — the usual way (recommended)

After installing v0.4.8+ from [Releases](https://github.com/Phantazein-apps/hermeneia/releases/latest):

1. Claude Desktop → **Settings** → **Extensions** → **WhatsApp (Hermeneia)**
2. Fill in:
   - **Epistole mirror URL** — the base URL of your Epistole server (e.g. `https://mailstore.example.com`). Leave empty to keep the mirror disabled.
   - **Epistole mirror token** — the `WA_BRIDGE_TOKEN` secret, same value as on the Epistole side. Stored locally by Claude Desktop.
   - **Epistole account allowlist** *(optional)* — comma-separated account IDs to mirror, e.g. `personal,work`. Leave empty to mirror **all** connected accounts.
3. Restart the extension (toggle off then on, or fully quit Claude Desktop and relaunch).

On next start, you should see `[hermeneia] Epistole mirror: https://... (all accounts)` in the MCP server log (`~/Library/Logs/Claude/mcp-server-WhatsApp (Hermeneia).log`).

### Configuration — via environment variables

If you run Hermeneia outside Claude Desktop (e.g. `npm run dev` during development), the same env vars apply directly:

```bash
EPISTOLE_MIRROR_URL=https://your-epistole-host
EPISTOLE_MIRROR_TOKEN=<WA_BRIDGE_TOKEN>
EPISTOLE_MIRROR_ACCOUNTS=personal,work   # optional allowlist
```

Either `URL` or `TOKEN` unset → mirror is a complete no-op.

### Where to find your token

The token is a shared password between Epistole (the server) and Hermeneia (this client) — the `WA_BRIDGE_TOKEN` Cloudflare Worker secret on the Epistole side. How you got it depends on when and how you deployed Epistole:

**If you installed Epistole with the WhatsApp bridge enabled** — the installer asked *"Enable WhatsApp bridge endpoint? [y/N]"* and you answered **y**. It generated a random 64-character token, stored it as the Worker secret, and printed the token twice during install with a *"save this now"* callout. That's the token. Paste it into the Hermeneia field. If you didn't save it, jump to *Rotating* below.

**If you deployed Epistole before the WhatsApp bridge shipped, or said "n" at the prompt** — the secret doesn't exist yet. Create it now from inside the Epistole repo:

```bash
# Generate a random value you can paste into both sides
openssl rand -hex 32
# Then set it as the Cloudflare secret (you'll be prompted for the value)
wrangler secret put WA_BRIDGE_TOKEN
wrangler deploy
```

Paste the same value into Hermeneia's **Epistole mirror token** field.

**Rotating (you lost the value or want to refresh it)** — re-run the same two commands with a fresh value, then update Hermeneia's field to match. Nothing breaks; the old token is simply invalidated.

**Cloudflare never shows existing secret values.** That's by design. If the value isn't in your password manager / shell history / `.dev.vars`, rotation is the right answer — it's 30 seconds of work.

Keep the token private. Anyone with it can write mirror data to your Epistole instance (they can't read data back — the push endpoint is one-way — but they could pollute your search index).

### Initial backfill

New messages arriving after you enable the mirror ship automatically. To backfill history that was already in `messages.db` when you enabled it, ask Claude:

> *"Run `epistole_backfill` on account `default`."*

You can cap the run with `max_batches: N` (each batch is 100 messages, newest-first) if you want to trickle a large history over multiple sessions. For a large `personal` account that's tens of thousands of messages, start with `max_batches: 5` to confirm Epistole's ingestion before committing to the whole history.

### Where to run `epistole_backfill`

**Only from a regular Claude Desktop chat** — the normal chat window in the macOS Claude Desktop app. That's the only surface where Hermeneia's tools are visible.

Places the tool *won't* be available:

- **Cowork** — runs your task in the cloud, can only reach remote/cloud MCPs. Hermeneia is a local Mac-only extension.
- **Claude mobile / Claude.ai web** — same reason. They can't reach the Node process sitting on your Mac.
- **Claude Code** (CLI) — uses its own MCP config, doesn't automatically include Claude Desktop's extensions.

If you try to run `epistole_backfill` from any of those and see *"no tool called epistole_backfill available"*, it's not broken — you're on the wrong surface. Switch to a regular Claude Desktop chat.

This split is intentional and is actually the point of the mirror: you **backfill and live-mirror from the Mac** (writer side), then **search the mirrored data from anywhere via Epistole's `semantic_search`** (reader side — works from mobile, web, Cowork, Code, everywhere).

### WhatsApp sync is not exhaustive — and never will be

If a search doesn't find a message you *know* exists in a WhatsApp chat on your phone, check `messages.db` first — odds are the message isn't in Hermeneia either, which means the mirror never had a chance to push it.

WhatsApp's multi-device protocol deliberately delivers only a subset of history to linked devices. In practice:

- Chats with recent two-way activity get deep history sync (often years' worth)
- Chats that have been quiet for several months may get **zero messages** delivered — the server decides they aren't worth the bandwidth
- There is no public or reverse-engineered API to request a specific chat's full history on demand. Every whatsmeow-based client has this limit.

**To nudge specific chat history into Hermeneia**: open that chat in WhatsApp **on your phone** and leave it foregrounded for a minute or two. WhatsApp often pushes `HistorySyncNotification` for the "currently viewed" chat. Sending a message in the chat (then deleting it) is an even stronger signal. Failing that, scrolling back through the chat on the phone can trigger context delivery to linked devices.

New messages arriving going forward are not affected — the live mirror catches them reliably. This limit only affects old history that WhatsApp never handed off.

### Watchdog (independent of the mirror)

Hermeneia monitors each connected bridge for event activity. If no events arrive from a connected account for `HERMENEIA_WATCHDOG_TIMEOUT_MS` (default 5 min), the Go subprocess is SIGKILLed and respawned with exponential backoff (5s → 30s cap). This is always on; the mirror has nothing to do with it.

```bash
HERMENEIA_WATCHDOG_TIMEOUT_MS=300000  # 5 min
HERMENEIA_WATCHDOG_CHECK_MS=60000     # 1 min poll
HERMENEIA_RESPAWN_CAP=5               # give up after N consecutive failed respawns
```

### Session reliability

- **Per-account bridge logs** are written to `<dataDir>/logs/bridge-<accountId>.log` (captures the Go/whatsmeow stderr, invaluable for diagnosing silent session drops).
- When WhatsApp revokes a linked device, Hermeneia catches the `logged_out` event, clears the saved phone, kills the bridge so whatsmeow re-initialises and emits a fresh QR, and fires a **macOS desktop notification** pointing at the setup URL.
- If a bridge fails to stay connected after `HERMENEIA_RESPAWN_CAP` consecutive respawn attempts, Hermeneia stops retrying and notifies you — respawning a genuinely revoked session is futile.

## Development

```bash
git clone https://github.com/Phantazein-apps/hermeneia.git
cd hermeneia
npm install
npm run dev     # run from source
npm run build   # bundle to dist/
npm run pack    # build .mcpb file
```

Requires Go 1.21+ and Node.js 18+.

## License

MIT — Phantazein S.L.
