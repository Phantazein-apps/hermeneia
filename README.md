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

Hermeneia can optionally push a copy of incoming WhatsApp events to a remote [Epistole](https://github.com/Phantazein-apps/epistole) Cloudflare Worker so that its `semantic_search` indexes WhatsApp history alongside email. **Off by default.** Enabling the mirror does not change any existing behavior — sends, media, and the local `messages.db` all still live here.

### What it does

- After each durable local write (message, chat, contact), best-effort POSTs a copy to `POST /api/wa/push` on your Epistole instance.
- Batches events (1.5s debounce, 50-event flush) and sends one-way over HTTPS with a Bearer token.
- Sends a heartbeat every ~60s per connected account.
- One-shot backfill via the `epistole_backfill` MCP tool — walks existing `messages.db` for an account and ships it in batches.

### What it does NOT do

- **No media bytes are uploaded.** Only metadata (media type, filename, caption).
- **No remote sends.** Epistole cannot send WhatsApp messages through Hermeneia — the channel is push-only, Hermeneia → Epistole.
- **No state dependency.** If Epistole is unreachable, the call is dropped after a short backoff; Hermeneia keeps running. Lossy by design.

### Configuration

Set these environment variables before launching Hermeneia:

```bash
EPISTOLE_MIRROR_URL=https://your-epistole-host
EPISTOLE_MIRROR_TOKEN=<same secret WA_BRIDGE_TOKEN as on Epistole>
# Optional — comma-separated account-id allowlist; default is all accounts
EPISTOLE_MIRROR_ACCOUNTS=personal
```

If either `URL` or `TOKEN` is unset, the mirror is a complete no-op.

### Initial backfill

From Claude Desktop, once the mirror env vars are set:

> "Run `epistole_backfill` on account `personal`."

The tool pushes chats and contacts first, then messages newest-first in batches (default 100). You can cap runs with `max_batches` if you want to trickle a large history.

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
