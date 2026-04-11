// Hermeneia — WhatsApp bridge via Baileys
//
// Single-process WhatsApp Web connection with:
// - QR code auth (served via local HTTP page, not terminal)
// - Message storage to SQLite
// - Send/receive/media support

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { proto } from "@whiskeysockets/baileys";
import { mkdirSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";
import { upsertChat, storeMessage } from "./store.js";
import type { BridgeStatus } from "./types.js";

// Re-export the socket type for tools.ts
export type { WASocket };

const log = (msg: string) => console.error(`[hermeneia] ${msg}`);

export class WhatsAppBridge extends EventEmitter {
  private sock: WASocket | null = null;
  private dataDir: string;
  private authDir: string;
  private _connected = false;
  private _authenticated = false;
  private _currentQR: string | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    this.authDir = join(dataDir, "auth");
    mkdirSync(this.authDir, { recursive: true });
    mkdirSync(join(dataDir, "media"), { recursive: true });
  }

  get status(): BridgeStatus {
    return {
      connected: this._connected,
      authenticated: this._authenticated,
      qr_url: this._currentQR ? `http://localhost:${this.qrPort}/setup` : null,
    };
  }

  get socket(): WASocket | null {
    return this.sock;
  }

  get isConnected(): boolean {
    return this._connected && this._authenticated;
  }

  private qrPort = 3456;

  setQrPort(port: number) {
    this.qrPort = port;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    log(`Connecting to WhatsApp Web v${version.join(".")}...`);

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      printQRInTerminal: false, // We serve QR via HTTP instead
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    // ── Auth events ────────────────────────────────────────────────

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this._currentQR = qr;
        this._authenticated = false;
        this.emit("qr", qr);
        log("QR code generated — open the setup page to scan");
      }

      if (connection === "open") {
        this._connected = true;
        this._authenticated = true;
        this._currentQR = null;
        this.emit("connected");
        log("Connected to WhatsApp!");
      }

      if (connection === "close") {
        this._connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          this._authenticated = false;
          this._currentQR = null;
          this.emit("logged_out");
          log("Logged out — restart to re-authenticate");
        } else if (shouldReconnect) {
          log(`Disconnected (code ${statusCode}), reconnecting in 5s...`);
          this._reconnectTimer = setTimeout(() => this.start(), 5000);
        }
      }
    });

    // ── Message events ─────────────────────────────────────────────

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        this.handleIncomingMessage(msg);
      }
    });

    // ── Chat events ────────────────────────────────────────────────

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        const name = chat.name ?? chat.id?.split("@")[0] ?? null;
        upsertChat(chat.id, name, new Date().toISOString());
      }
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        if (contact.id && contact.name) {
          upsertChat(contact.id, contact.name, new Date().toISOString());
        }
      }
    });
  }

  private handleIncomingMessage(msg: proto.IWebMessageInfo): void {
    if (!msg.key?.remoteJid || !msg.message) return;

    const chatJid = msg.key.remoteJid;
    const sender = msg.key.participant ?? msg.key.remoteJid;
    const isFromMe = msg.key.fromMe ?? false;
    const timestamp = new Date(
      (msg.messageTimestamp as number) * 1000
    ).toISOString();
    const messageId = msg.key.id ?? `${Date.now()}`;

    // Extract text content
    const content = this.extractText(msg.message);

    // Extract media info
    const { mediaType, filename } = this.extractMediaInfo(msg.message);

    // Skip if no content and no media
    if (!content && !mediaType) return;

    // Get push name for contact resolution
    const pushName = msg.pushName ?? null;
    const chatName =
      pushName && !chatJid.endsWith("@g.us") ? pushName : null;

    // Store chat
    upsertChat(chatJid, chatName, timestamp);

    // Store message
    storeMessage(
      messageId,
      chatJid,
      sender,
      content,
      timestamp,
      isFromMe,
      mediaType,
      filename
    );

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
  }

  private extractText(message: proto.IMessage): string {
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text)
      return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption)
      return message.documentMessage.caption;
    return "";
  }

  private extractMediaInfo(message: proto.IMessage): {
    mediaType: string | null;
    filename: string | null;
  } {
    if (message.imageMessage)
      return { mediaType: "image", filename: "image.jpg" };
    if (message.videoMessage)
      return { mediaType: "video", filename: "video.mp4" };
    if (message.audioMessage)
      return { mediaType: "audio", filename: "audio.ogg" };
    if (message.documentMessage)
      return {
        mediaType: "document",
        filename: message.documentMessage.fileName ?? "document",
      };
    return { mediaType: null, filename: null };
  }

  // ── Public actions (called by MCP tools) ───────────────────────

  async sendMessage(
    recipient: string,
    text: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.sock || !this.isConnected) {
      return { success: false, message: "Not connected to WhatsApp" };
    }

    try {
      const jid = this.normalizeJid(recipient);
      await this.sock.sendMessage(jid, { text });
      return { success: true, message: "Message sent successfully" };
    } catch (err: any) {
      return { success: false, message: `Send failed: ${err.message}` };
    }
  }

  async sendFile(
    recipient: string,
    filePath: string,
    caption?: string
  ): Promise<{ success: boolean; message: string }> {
    if (!this.sock || !this.isConnected) {
      return { success: false, message: "Not connected to WhatsApp" };
    }

    try {
      const { readFileSync } = await import("fs");
      const jid = this.normalizeJid(recipient);
      const data = readFileSync(filePath);
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

      let msgContent: any;
      if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
        msgContent = { image: data, caption };
      } else if (["mp4", "avi", "mov"].includes(ext)) {
        msgContent = { video: data, caption };
      } else if (["ogg"].includes(ext)) {
        msgContent = { audio: data, mimetype: "audio/ogg; codecs=opus", ptt: true };
      } else {
        msgContent = {
          document: data,
          fileName: filePath.split("/").pop(),
          caption,
        };
      }

      await this.sock.sendMessage(jid, msgContent);
      return { success: true, message: "File sent successfully" };
    } catch (err: any) {
      return { success: false, message: `Send file failed: ${err.message}` };
    }
  }

  async downloadMedia(
    msg: proto.IWebMessageInfo
  ): Promise<Buffer | null> {
    if (!this.sock) return null;
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return buffer as Buffer;
    } catch {
      return null;
    }
  }

  private normalizeJid(recipient: string): string {
    if (recipient.includes("@")) return recipient;
    // Strip non-digits and build JID
    const digits = recipient.replace(/\D/g, "");
    return `${digits}@s.whatsapp.net`;
  }

  async stop(): Promise<void> {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this._connected = false;
  }
}
