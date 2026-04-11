#!/usr/bin/env node
// Hermeneia — WhatsApp bridge for Claude
//
// Single process that runs:
// 1. WhatsApp Web connection via Baileys (QR auth, message sync)
// 2. MCP server via stdio (14 tools for Claude Desktop)
// 3. Local HTTP server for QR code display (only during setup)
//
// Usage:
//   node dist/index.js              # production (bundled)
//   npx tsx src/index.ts            # development

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WhatsAppBridge } from "./bridge.js";
import { initStore } from "./store.js";
import { registerTools } from "./tools.js";
import { startQRServer, stopQRServer } from "./qr-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (msg: string) => console.error(`[hermeneia] ${msg}`);

// ── Data directory ──────────────────────────────────────────────────
// .mcpb sets HERMENEIA_DATA_DIR; fallback to ./data relative to the script
const dataDir =
  process.env.HERMENEIA_DATA_DIR ??
  process.env.WHATSAPP_DATA_DIR ??
  join(__dirname, "..", "data");

const qrPort = parseInt(process.env.HERMENEIA_QR_PORT ?? "3456", 10);

// ── Initialize ──────────────────────────────────────────────────────

async function main() {
  log("Starting Hermeneia...");
  log(`Data directory: ${dataDir}`);

  // 1. Initialize SQLite store
  await initStore(dataDir);
  log("Message store ready");

  // 2. Start WhatsApp bridge
  const bridge = new WhatsAppBridge(dataDir);
  bridge.setQrPort(qrPort);

  bridge.on("qr", (qr: string) => {
    // QR generated — ensure the setup page is running, pass QR string immediately
    startQRServer(bridge, qrPort, qr);
  });

  bridge.on("connected", () => {
    log("WhatsApp authenticated — tools are ready");
  });

  bridge.on("message", (msg: any) => {
    const dir = msg.isFromMe ? "→" : "←";
    const preview = msg.content?.substring(0, 60) ?? "[media]";
    log(`${dir} ${msg.sender}: ${preview}`);
  });

  await bridge.start();

  // 3. Start MCP server (stdio transport for Claude Desktop)
  const mcpServer = new Server(
    {
      name: "hermeneia",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerTools(mcpServer, bridge);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("MCP server running on stdio");

  // ── Graceful shutdown ───────────────────────────────────────────

  const shutdown = async () => {
    log("Shutting down...");
    stopQRServer();
    await bridge.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[hermeneia] Fatal error:", err);
  process.exit(1);
});
