// Hermeneia — Multi-account bridge manager
//
// Manages multiple WhatsAppBridge instances, each with its own
// Go subprocess and data directory.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, cpSync } from "fs";
import { join } from "path";
import { WhatsAppBridge } from "./bridge.js";
import { startQRServer, stopQRServer } from "./qr-server.js";
import { isMirrorEnabled, mirrorHeartbeat, flushAll as flushMirror } from "./mirror.js";
import type { AccountInfo } from "./types.js";

const log = (msg: string) => console.error(`[hermeneia:manager] ${msg}`);

interface AccountEntry {
  id: string;
  name: string | null;
  phone: string | null;
}

export class BridgeManager {
  private bridges = new Map<string, WhatsAppBridge>();
  private dataDir: string;
  private qrPort: number;
  private onMessage?: (accountId: string, msg: any) => void;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  // Tracks exponential-backoff delay per account id for respawn attempts.
  private respawnBackoff = new Map<string, number>();
  // Watchdog timeout: if a connected bridge has received no events for this long, kill + respawn.
  private readonly watchdogTimeoutMs: number;
  private readonly watchdogCheckMs: number;

  constructor(dataDir: string, qrPort: number) {
    this.dataDir = dataDir;
    this.qrPort = qrPort;
    this.watchdogTimeoutMs = parseInt(process.env.HERMENEIA_WATCHDOG_TIMEOUT_MS ?? "300000", 10);
    this.watchdogCheckMs = parseInt(process.env.HERMENEIA_WATCHDOG_CHECK_MS ?? "60000", 10);
  }

  setMessageHandler(handler: (accountId: string, msg: any) => void): void {
    this.onMessage = handler;
  }

  /** Migrate old flat data layout to accounts/ subdirectory */
  private migrateOldLayout(): void {
    const oldWhatsmeow = join(this.dataDir, "whatsmeow.db");
    const accountsDir = join(this.dataDir, "accounts");
    const defaultDir = join(accountsDir, "default");

    if (!existsSync(oldWhatsmeow)) return;
    if (existsSync(join(defaultDir, "whatsmeow.db"))) return;

    log("Migrating old single-account layout to accounts/default/...");
    mkdirSync(defaultDir, { recursive: true });

    // Move whatsmeow.db
    renameSync(oldWhatsmeow, join(defaultDir, "whatsmeow.db"));

    // Move auth/ directory if it exists
    const oldAuth = join(this.dataDir, "auth");
    if (existsSync(oldAuth)) {
      cpSync(oldAuth, join(defaultDir, "auth"), { recursive: true });
      // Don't delete old auth dir — safer to leave it
    }

    // Write initial accounts.json
    this.saveAccounts([{ id: "default", name: null, phone: null }]);
    log("Migration complete");
  }

  /** Start all saved accounts */
  async startup(): Promise<void> {
    this.migrateOldLayout();

    const accounts = this.loadAccounts();
    if (accounts.length === 0) {
      // First run — create default account
      log("No accounts found, creating default account...");
      await this.addAccount("default");
      return;
    }

    for (const account of accounts) {
      await this.startBridge(account.id, account.name, account.phone);
    }

    this.startWatchdog();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.watchdogTick(), this.watchdogCheckMs);
    // Don't keep the process alive just for the watchdog.
    this.watchdogTimer.unref?.();
    log(
      `Watchdog started — check every ${Math.round(this.watchdogCheckMs / 1000)}s, ` +
        `timeout ${Math.round(this.watchdogTimeoutMs / 1000)}s`
    );
  }

  private watchdogTick(): void {
    if (this.shuttingDown) return;
    const now = Date.now();

    for (const [id, bridge] of this.bridges) {
      if (!bridge.isConnected) continue;
      const idle = now - bridge.lastEventTime;

      // Heartbeat to Epistole for every connected, non-stale bridge
      if (isMirrorEnabled()) {
        mirrorHeartbeat(id, bridge.displayName, bridge.phone).catch(() => {});
      }

      if (idle > this.watchdogTimeoutMs) {
        log(
          `Watchdog: no events from "${id}" for ${Math.round(idle / 1000)}s — ` +
            `killing PID ${bridge.pid ?? "?"} and respawning`
        );
        bridge.forceKill("SIGKILL");
        // The bridge's "exit" handler (wired in startBridge) handles respawn.
      }
    }
  }

  /** Add and start a new account */
  async addAccount(id: string): Promise<{ setupUrl: string }> {
    if (this.bridges.has(id)) {
      throw new Error(`Account "${id}" already exists`);
    }

    const accountDir = join(this.dataDir, "accounts", id);
    mkdirSync(accountDir, { recursive: true });

    await this.startBridge(id, null, null);

    // Save to accounts.json
    const accounts = this.loadAccounts();
    if (!accounts.find((a) => a.id === id)) {
      accounts.push({ id, name: null, phone: null });
      this.saveAccounts(accounts);
    }

    const setupUrl = `http://localhost:${this.qrPort}/setup/${id}`;
    return { setupUrl };
  }

  /** Remove an account */
  async removeAccount(id: string): Promise<boolean> {
    const bridge = this.bridges.get(id);
    if (!bridge) return false;

    await bridge.stop();
    this.bridges.delete(id);

    // Remove from accounts.json but leave data dir intact
    const accounts = this.loadAccounts().filter((a) => a.id !== id);
    this.saveAccounts(accounts);

    log(`Removed account: ${id}`);
    return true;
  }

  private async startBridge(id: string, name: string | null, phone: string | null): Promise<void> {
    const accountDir = join(this.dataDir, "accounts", id);
    mkdirSync(accountDir, { recursive: true });

    const bridge = new WhatsAppBridge(accountDir, id);
    bridge.setQrPort(this.qrPort);
    bridge.displayName = name;
    bridge.phone = phone;

    bridge.on("qr", (qr: string) => {
      startQRServer(bridge, this.qrPort, qr, accountDir, id);
    });

    bridge.on("connected", () => {
      log(`Account "${id}" connected`);
      // Update saved account info
      this.updateAccountInfo(id, bridge.displayName, bridge.phone);
    });

    bridge.on("account_info", () => {
      this.updateAccountInfo(id, bridge.displayName, bridge.phone);
    });

    bridge.on("message", (msg: any) => {
      this.onMessage?.(id, msg);
    });

    bridge.on("error", (err: Error) => {
      log(`Bridge error (${id}): ${err.message}`);
    });

    bridge.on("exit", () => {
      if (this.shuttingDown) return;
      // The bridge entry is still in this.bridges (we haven't cleared it).
      // Schedule a respawn with backoff.
      this.scheduleRespawn(id, name, phone);
    });

    this.bridges.set(id, bridge);

    try {
      await bridge.start();
      log(`Started bridge for account: ${id}`);
      // Reset respawn backoff on successful start
      this.respawnBackoff.delete(id);
    } catch (err: any) {
      log(`Failed to start bridge for account "${id}": ${err.message}`);
      this.bridges.delete(id);
      if (!this.shuttingDown) this.scheduleRespawn(id, name, phone);
    }
  }

  private scheduleRespawn(id: string, name: string | null, phone: string | null): void {
    if (this.shuttingDown) return;

    const prev = this.respawnBackoff.get(id) ?? 0;
    const delay = prev === 0 ? 5_000 : Math.min(prev * 2, 30_000);
    this.respawnBackoff.set(id, delay);

    log(`Scheduling respawn of "${id}" in ${Math.round(delay / 1000)}s`);

    setTimeout(() => {
      if (this.shuttingDown) return;
      // Use the latest known name/phone from accounts.json if available.
      const saved = this.loadAccounts().find((a) => a.id === id);
      const n = saved?.name ?? name;
      const p = saved?.phone ?? phone;
      // Drop the stale bridge entry before restarting.
      this.bridges.delete(id);
      this.startBridge(id, n, p).catch((err) => {
        log(`Respawn of "${id}" failed: ${err?.message ?? err}`);
      });
    }, delay).unref?.();
  }

  private updateAccountInfo(id: string, name: string | null, phone: string | null): void {
    const accounts = this.loadAccounts();
    const entry = accounts.find((a) => a.id === id);
    if (entry) {
      if (name) entry.name = name;
      if (phone) entry.phone = phone;
      this.saveAccounts(accounts);
    }
  }

  // ── Accessors ────────────────────────────────────────────────────

  get(accountId: string): WhatsAppBridge | undefined {
    return this.bridges.get(accountId);
  }

  getAll(): Map<string, WhatsAppBridge> {
    return this.bridges;
  }

  getAccountIds(): string[] {
    return Array.from(this.bridges.keys());
  }

  getConnectedIds(): string[] {
    return Array.from(this.bridges.entries())
      .filter(([_, b]) => b.isConnected)
      .map(([id]) => id);
  }

  /** Get bridge for sending. Errors if ambiguous (>1 connected, no id specified). */
  resolveForSend(accountId?: string): WhatsAppBridge | { error: string } {
    if (accountId) {
      const bridge = this.bridges.get(accountId);
      if (!bridge) return { error: `Account "${accountId}" not found` };
      if (!bridge.isConnected) return { error: `Account "${accountId}" is not connected` };
      return bridge;
    }

    const connected = this.getConnectedIds();
    if (connected.length === 0) {
      return { error: "No WhatsApp accounts are connected" };
    }
    if (connected.length === 1) {
      return this.bridges.get(connected[0])!;
    }
    return {
      error: `Multiple accounts connected (${connected.join(", ")}). Please specify which account to send from using the "account" parameter.`,
    };
  }

  getAllAccountInfo(): AccountInfo[] {
    const saved = this.loadAccounts();
    return saved.map((entry) => {
      const bridge = this.bridges.get(entry.id);
      return {
        id: entry.id,
        name: bridge?.displayName ?? entry.name,
        phone: bridge?.phone ?? entry.phone,
        connected: bridge?.isConnected ?? false,
        authenticated: bridge?.status.authenticated ?? false,
      };
    });
  }

  /** Stop all bridges */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const [id, bridge] of this.bridges) {
      log(`Stopping bridge: ${id}`);
      await bridge.stop();
    }
    this.bridges.clear();
    stopQRServer();
    try {
      await flushMirror();
    } catch {}
  }

  // ── Persistence ──────────────────────────────────────────────────

  private accountsPath(): string {
    return join(this.dataDir, "accounts.json");
  }

  private loadAccounts(): AccountEntry[] {
    const path = this.accountsPath();
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return [];
    }
  }

  private saveAccounts(accounts: AccountEntry[]): void {
    writeFileSync(this.accountsPath(), JSON.stringify(accounts, null, 2));
  }
}
