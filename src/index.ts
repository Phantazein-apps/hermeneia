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

  // 1. Initialize SQLite store (shared across all accounts)
  await initStore(dataDir);
  log("Message store ready");

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
      version: "0.4.0",
    },
    {
      capabilities: {
        tools: {},
      },
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
