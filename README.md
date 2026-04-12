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
