# Hermeneia

WhatsApp bridge for Claude. Drag to install, scan a QR code, chat.

> **ἑρμηνεία** — *interpretation, translation between worlds.*
> From Hermes, messenger of the gods. Part of the [Phantazein](https://phantazein.com) toolkit.

## Install

Download `hermeneia.mcpb` from [Releases](https://github.com/phantazein/hermeneia/releases/latest) and drag it into Claude Desktop.

That's it. No terminal, no Python, no Go, no config files.

## Connect WhatsApp

1. Ask Claude: **"check my WhatsApp status"**
2. A browser page opens with a QR code
3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
4. Scan the code
5. Done — Claude can now read and send your messages

The session persists. You only scan once.

## What Claude can do

- **Read messages** — search, filter by date/contact/chat, get context
- **Send messages** — text, images, videos, documents, voice notes
- **Browse contacts** — search by name or phone number
- **Browse chats** — list all conversations, see last messages

## Privacy

All data stays on your computer. Messages are stored in a local SQLite database. Nothing is sent to any server except WhatsApp's own servers (same as WhatsApp Web).

## Development

```bash
git clone https://github.com/phantazein/hermeneia.git
cd hermeneia
npm install
npm run dev     # run from source
npm run build   # bundle to dist/
npm run pack    # build .mcpb file
```

## Architecture

Single Node.js process that runs three things:

1. **WhatsApp Web** — via [Baileys](https://github.com/WhiskeySockets/Baileys) (WebSocket protocol)
2. **MCP Server** — via [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) (stdio transport)
3. **Setup Page** — local HTTP server for QR code display (only during auth)

```
Claude Desktop ←→ MCP (stdio) ←→ Hermeneia ←→ WhatsApp Web
                                      ↕
                                   SQLite
                                (local messages)
```

## License

MIT — Phantazein S.L.
