// Hermeneia — WhatsApp bridge via Go/whatsmeow subprocess
//
// Spawns a compiled Go binary that handles WhatsApp Web connection,
// auth, history sync, and contact resolution. Communicates via
// newline-delimited JSON over stdin/stdout.

import { spawn, type ChildProcess } from "child_process";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { createInterface } from "readline";
import { upsertChat, storeMessage, upsertContact, incrementUnread } from "./store.js";
import type { BridgeStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (msg: string) => console.error(`[hermeneia] ${msg}`);

// Platform-specific binary name
function getBinaryName(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  return `hermeneia-bridge-${platform}-${arch}${ext}`;
}

export class WhatsAppBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private dataDir: string;
  private _accountId: string;
  private _connected = false;
  private _authenticated = false;
  private _currentQR: string | null = null;
  private _displayName: string | null = null;
  private _phone: string | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private reqCounter = 0;

  constructor(dataDir: string, accountId = "default") {
    super();
    this.dataDir = dataDir;
    this._accountId = accountId;
  }

  get accountId(): string {
    return this._accountId;
  }

  get displayName(): string | null {
    return this._displayName;
  }

  set displayName(name: string | null) {
    this._displayName = name;
  }

  get phone(): string | null {
    return this._phone;
  }

  set phone(phone: string | null) {
    this._phone = phone;
  }

  get status(): BridgeStatus {
    return {
      connected: this._connected,
      authenticated: this._authenticated,
      qr_url: this._currentQR ? `http://localhost:${this.qrPort}/setup` : null,
    };
  }

  get isConnected(): boolean {
    return this._connected && this._authenticated;
  }

  // Kept for API compatibility (qr-server uses it)
  get socket(): null {
    return null;
  }

  private qrPort = 3456;

  setQrPort(port: number) {
    this.qrPort = port;
  }

  async start(): Promise<void> {
    // Find the Go binary — check next to bundle first, then project root
    let binaryPath: string;
    const platformBinary = getBinaryName();
    const genericBinary = "hermeneia-bridge";

    // Try platform-specific name first, then generic
    for (const name of [platformBinary, genericBinary]) {
      const candidate = join(__dirname, name);
      try {
        const { accessSync } = await import("fs");
        accessSync(candidate);
        binaryPath = candidate;
        break;
      } catch {}
    }

    if (!binaryPath!) {
      // Fallback: check if go-bridge was built in project root (dev mode)
      const devPath = join(__dirname, "..", "dist", genericBinary);
      try {
        const { accessSync } = await import("fs");
        accessSync(devPath);
        binaryPath = devPath;
      } catch {
        throw new Error(
          `Go bridge binary not found. Looked for:\n` +
            `  ${join(__dirname, platformBinary)}\n` +
            `  ${join(__dirname, genericBinary)}\n` +
            `  ${devPath}`
        );
      }
    }

    log(`Starting Go bridge: ${binaryPath}`);
    log(`Data directory: ${this.dataDir}`);

    this.proc = spawn(binaryPath, [this.dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse JSON events from Go binary's stdout
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const evt = JSON.parse(line);
        this.handleEvent(evt);
      } catch (err) {
        log(`Invalid JSON from bridge: ${line}`);
      }
    });

    // Forward stderr (Go bridge logs) to our stderr
    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(text);
    });

    this.proc.on("exit", (code) => {
      log(`Go bridge exited with code ${code}`);
      this._connected = false;
      if (code !== 0 && code !== null) {
        this.emit("error", new Error(`Bridge process exited with code ${code}`));
      }
    });

    this.proc.on("error", (err) => {
      log(`Go bridge spawn error: ${err.message}`);
    });
  }

  private handleEvent(evt: any): void {
    switch (evt.type) {
      case "qr":
        this._currentQR = evt.data;
        this._authenticated = false;
        this.emit("qr", evt.data);
        log("QR code generated — open the setup page to scan");
        break;

      case "connected":
        this._connected = true;
        this._authenticated = true;
        this._currentQR = null;
        // Extract phone/name from connected event if provided
        if (evt.jid) {
          this._phone = evt.jid.split("@")[0] ?? null;
        }
        if (evt.push_name) {
          this._displayName = evt.push_name;
        }
        this.emit("connected");
        log(`Connected to WhatsApp! (account: ${this._accountId})`);
        break;

      case "account_info":
        if (evt.phone) this._phone = evt.phone;
        if (evt.name) this._displayName = evt.name;
        this.emit("account_info", { phone: this._phone, name: this._displayName });
        break;

      case "logged_out":
        this._connected = false;
        this._authenticated = false;
        this._currentQR = null;
        this.emit("logged_out");
        log("Logged out — restart to re-authenticate");
        break;

      case "message": {
        const timestamp = evt.timestamp;
        const chatJid = evt.chat_jid;
        const sender = evt.sender;
        const isFromMe = evt.is_from_me ?? false;
        const content = evt.content ?? "";
        const mediaType = evt.media_type ?? null;
        const messageId = evt.id;
        const pushName = evt.push_name ?? null;
        const mediaInfo = evt.media_info ? JSON.stringify(evt.media_info) : null;

        // Update chat + increment unread for incoming messages
        upsertChat(this._accountId, chatJid, null, timestamp);
        if (!isFromMe) {
          incrementUnread(this._accountId, chatJid);
        }

        // Store message
        if (content || mediaType) {
          storeMessage(
            this._accountId,
            messageId,
            chatJid,
            sender,
            content,
            timestamp,
            isFromMe,
            mediaType,
            null,
            mediaInfo
          );
        }

        this.emit("message", {
          id: messageId,
          chatJid,
          sender,
          content,
          isFromMe,
          timestamp,
          mediaType,
          pushName,
        });
        break;
      }

      case "chat":
        upsertChat(this._accountId, evt.jid, evt.name || null, evt.last_message_time, {
          unreadCount: evt.unread_count ?? undefined,
          archived: evt.archived ?? undefined,
          parentGroupJid: evt.parent_group_jid || undefined,
          isParentGroup: evt.is_parent_group ?? undefined,
        });
        break;

      case "contact":
        upsertContact(this._accountId, {
          id: evt.id,
          lid: evt.lid || null,
          phoneJid: evt.phone_jid || null,
          name: evt.name || null,
          notify: evt.notify || null,
          verifiedName: evt.verified_name ?? null,
        });
        break;

      case "contacts_ready":
        log(`Contacts ready: ${evt.count} contacts loaded`);
        break;

      case "error":
        log(`Bridge error: ${evt.message}`);
        break;

      case "response": {
        const pending = this.pendingRequests.get(evt.req_id);
        if (pending) {
          this.pendingRequests.delete(evt.req_id);
          pending.resolve({
            success: evt.success,
            message: evt.message ?? (evt.success ? "OK" : "Failed"),
          });
        }
        break;
      }
    }
  }

  // ── Public actions (called by MCP tools) ───────────────────────

  private sendCommand(cmd: any): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        resolve({ success: false, message: "Bridge process not running" });
        return;
      }

      const id = `req_${++this.reqCounter}`;
      cmd.id = id;
      this.pendingRequests.set(id, { resolve, reject });

      this.proc.stdin.write(JSON.stringify(cmd) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ success: false, message: "Command timed out" });
        }
      }, 30_000);
    });
  }

  async sendMessage(
    recipient: string,
    text: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.isConnected) {
      return { success: false, message: "Not connected to WhatsApp" };
    }
    return this.sendCommand({ cmd: "send_message", recipient, text });
  }

  async downloadMedia(
    messageId: string,
    chatJid: string,
    mediaInfo?: any,
    saveDir?: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.isConnected) {
      return { success: false, message: "Not connected to WhatsApp" };
    }
    return this.sendCommand({
      cmd: "download_media",
      message_id: messageId,
      chat_jid: chatJid,
      media_info: mediaInfo ?? undefined,
      save_dir: saveDir ?? "",
    });
  }

  async sendFile(
    recipient: string,
    filePath: string,
    caption?: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.isConnected) {
      return { success: false, message: "Not connected to WhatsApp" };
    }
    return this.sendCommand({
      cmd: "send_file",
      recipient,
      path: filePath,
      caption: caption ?? "",
    });
  }

  async stop(): Promise<void> {
    if (this.proc) {
      try {
        this.proc.stdin?.write(JSON.stringify({ cmd: "stop" }) + "\n");
      } catch {}
      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.proc && !this.proc.killed) {
        this.proc.kill();
      }
      this.proc = null;
    }
    this._connected = false;
  }
}
