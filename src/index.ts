#!/usr/bin/env node
// Hermeneia — WhatsApp bridge for Claude
//
// Multi-account MCP server that runs:
// 1. Multiple WhatsApp Web connections via Go/whatsmeow (one per account)
// 2. MCP server via stdio (17 tools for Claude Desktop)
// 3. Local HTTP server for QR code display (only during setup)
//
// Usage:
//   node dist/index.js              # production (bundled)
//   npx tsx src/index.ts            # development

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, cpSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { BridgeManager } from "./bridge-manager.js";
import { initStore } from "./store.js";
import { registerTools } from "./tools.js";
import { stopQRServer } from "./qr-server.js";
import { initMirror } from "./mirror.js";
import { acquireLock } from "./lockfile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (msg: string) => console.error(`[hermeneia] ${msg}`);

// ── Data directory ──────────────────────────────────────────────────
// Use a stable location so upgrades preserve WhatsApp sessions and history.
// Environment variables override for custom setups.
function getDataDir(): string {
  if (process.env.HERMENEIA_DATA_DIR) return process.env.HERMENEIA_DATA_DIR;
  if (process.env.WHATSAPP_DATA_DIR) return process.env.WHATSAPP_DATA_DIR;

  // Stable per-platform location
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Hermeneia");
  } else if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Hermeneia");
  }
  return join(homedir(), ".hermeneia");
}

const dataDir = getDataDir();

// Migrate data from old bundle-relative location to stable path
function migrateOldDataDir(): void {
  const oldDir = join(__dirname, "..", "data");
  if (oldDir === dataDir) return; // same location, nothing to do
  if (!existsSync(oldDir)) return; // no old data
  if (existsSync(join(dataDir, "accounts.json"))) return; // already migrated

  log(`Migrating data from ${oldDir} to ${dataDir}`);
  mkdirSync(dataDir, { recursive: true });
  cpSync(oldDir, dataDir, { recursive: true });
  log("Data migration complete");
}

const qrPort = parseInt(process.env.HERMENEIA_QR_PORT ?? "3456", 10);

// ── Initialize ──────────────────────────────────────────────────────

async function main() {
  log("Starting Hermeneia...");
  migrateOldDataDir();
  log(`Data directory: ${dataDir}`);

  // 0. Single-instance guard. Claude Desktop sometimes double-spawns the MCP
  // server (external node + internal NodeService), which lets two whatsmeow
  // sessions fight over the same device keys — cue "Stream replaced" loops.
  if (!acquireLock(dataDir)) {
    // Stay silent and keep the process alive briefly so Claude Desktop sees
    // a graceful startup, then exit. Exiting immediately can cause Desktop
    // to treat it as a crash and respawn — a short delay avoids that.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    process.exit(0);
  }

  // 1. Initialize SQLite store (shared across all accounts)
  await initStore(dataDir);
  log("Message store ready");

  // 1b. Initialize optional Epistole mirror (no-op unless env vars are set)
  const mirrorInfo = initMirror();
  log(`Epistole mirror: ${mirrorInfo.info}`);

  // 2. Start bridge manager (handles multiple WhatsApp accounts)
  const manager = new BridgeManager(dataDir, qrPort);

  manager.setMessageHandler((accountId, msg) => {
    const dir = msg.isFromMe ? "→" : "←";
    const preview = msg.content?.substring(0, 60) ?? "[media]";
    log(`[${accountId}] ${dir} ${msg.sender}: ${preview}`);
  });

  await manager.startup();

  // 3. Start MCP server (stdio transport for Claude Desktop)
  const mcpServer = new Server(
    {
      name: "hermeneia",
      version: "0.4.6",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "You have full access to the user's WhatsApp messages via this server. " +
        "When the user asks about WhatsApp, messages, contacts, or chats, use these tools. " +
        "Use list_messages to search/read messages, list_chats to browse conversations, " +
        "search_contacts to find people, and send_message to send texts.",
    }
  );

  registerTools(mcpServer, manager);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("MCP server running on stdio");

  // ── Graceful shutdown ───────────────────────────────────────────

  const shutdown = async () => {
    log("Shutting down...");
    stopQRServer();
    await manager.stopAll();
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
