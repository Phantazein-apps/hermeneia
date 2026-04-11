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
  USyncQuery,
  USyncUser,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { proto } from "@whiskeysockets/baileys";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";
import { upsertChat, storeMessage, upsertContact, getAllChatJids } from "./store.js";
import type { BridgeStatus } from "./types.js";

// Re-export the socket type for tools.ts
export type { WASocket };

const log = (msg: string) => console.error(`[hermeneia] ${msg}`);

let debugLogPath: string | null = null;
function debugLog(label: string, data: any): void {
  if (!debugLogPath) return;
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${JSON.stringify(data, null, 2)}\n`;
    appendFileSync(debugLogPath, line);
  } catch {}
}

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
    debugLogPath = join(dataDir, "debug.log");
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
      browser: ["Hermeneia for Claude", "Desktop", "1.0.0"],
      printQRInTerminal: false, // We serve QR via HTTP instead
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,
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

        // Wait for history sync to populate chats, then resolve names
        setTimeout(() => {
          log("Triggering contact name resolution...");
          this.resolveContactNames().catch(err => {
            log(`Contact name resolution failed: ${err.message}`);
            debugLog("resolveContactNames error", err.message);
          });
        }, 10_000);
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
      // "notify" = new real-time message; "append" = history sync batch
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        this.handleIncomingMessage(msg);
      }
    });

    // ── Chat / contact events ───────────────────────────────────────

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        const name = chat.name ?? null;
        const ts = chat.conversationTimestamp
          ? new Date((chat.conversationTimestamp as number) * 1000).toISOString()
          : new Date().toISOString();
        upsertChat(chat.id, name, ts);
      }
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      debugLog("contacts.upsert", contacts.slice(0, 5).map(c => ({
        id: c.id, lid: (c as any).lid, jid: (c as any).jid,
        name: c.name, notify: c.notify, verifiedName: c.verifiedName,
        allKeys: Object.keys(c),
      })));
      log(`contacts.upsert: ${contacts.length} contacts`);
      for (const contact of contacts) {
        if (!contact.id) continue;
        upsertContact({
          id: contact.id,
          lid: (contact as any).lid ?? null,
          phoneJid: (contact as any).jid ?? null,
          name: contact.name ?? null,
          notify: contact.notify ?? null,
          verifiedName: contact.verifiedName ?? null,
        });
      }
    });

    this.sock.ev.on("contacts.update", (updates) => {
      debugLog("contacts.update", updates.slice(0, 5).map(c => ({
        id: c.id, lid: (c as any).lid, jid: (c as any).jid,
        name: c.name, notify: c.notify, verifiedName: c.verifiedName,
        allKeys: Object.keys(c),
      })));
      log(`contacts.update: ${updates.length} contacts`);
      for (const contact of updates) {
        if (!contact.id) continue;
        upsertContact({
          id: contact.id,
          lid: (contact as any).lid ?? null,
          phoneJid: (contact as any).jid ?? null,
          name: contact.name ?? null,
          notify: contact.notify ?? null,
          verifiedName: contact.verifiedName ?? null,
        });
      }
    });

    // ── History sync (fires on first connect with recent conversations) ──

    this.sock.ev.on("messaging-history.set", (data) => {
      const { chats, messages, contacts, isLatest } = data;
      const syncType = (data as any).syncType;
      log(`History sync [type=${syncType}]: ${chats.length} chats, ${messages.length} msgs, ${contacts.length} contacts`);

      // Count how many contacts have names
      const namedContacts = contacts.filter(c => c.notify || c.name || c.verifiedName);
      if (namedContacts.length > 0) {
        log(`  → ${namedContacts.length}/${contacts.length} contacts have names`);
      }

      debugLog(`messaging-history.set[type=${syncType}]`, {
        chats: chats.length,
        messages: messages.length,
        contacts: contacts.length,
        namedContacts: namedContacts.length,
        sampleContacts: contacts.slice(0, 3).map(c => ({
          id: c.id, lid: (c as any).lid, jid: (c as any).jid,
          name: c.name, notify: c.notify, verifiedName: c.verifiedName,
        })),
        sampleChats: chats.slice(0, 3).map(c => ({
          id: c.id, name: c.name,
        })),
      });

      // Contacts first — build name map before processing chats/messages
      for (const contact of contacts) {
        if (!contact.id) continue;
        upsertContact({
          id: contact.id,
          lid: (contact as any).lid ?? null,
          phoneJid: (contact as any).jid ?? null,
          name: contact.name ?? null,
          notify: contact.notify ?? null,
          verifiedName: contact.verifiedName ?? null,
        });
      }

      for (const chat of chats) {
        const name = chat.name ?? null;
        const ts = chat.conversationTimestamp
          ? new Date((chat.conversationTimestamp as number) * 1000).toISOString()
          : new Date().toISOString();
        upsertChat(chat.id, name, ts);
      }

      // Extract pushNames from history messages — Baileys doesn't do this
      // for us (it only processes PUSH_NAME sync type, which arrives later).
      // This is our best chance to get names from the initial sync.
      let pushNamesFound = 0;
      for (const msg of messages) {
        if (msg.pushName && msg.key?.remoteJid) {
          const sender = msg.key.participant ?? msg.key.remoteJid;
          upsertContact({ id: sender, notify: msg.pushName });
          pushNamesFound++;
        }
        this.handleIncomingMessage(msg);
      }
      if (pushNamesFound > 0) {
        log(`  → extracted ${pushNamesFound} push names from history messages`);
      }

      if (isLatest) log("History sync complete");
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

    // Store push name as contact info (works for both LIDs and phone JIDs)
    if (pushName && sender) {
      upsertContact({ id: sender, notify: pushName });
    }

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

  /** Actively query WhatsApp servers for contact push names */
  async resolveContactNames(): Promise<void> {
    if (!this.sock) return;

    const jids = getAllChatJids().filter(j => !j.endsWith("@g.us") && j !== "0@s.whatsapp.net");

    if (jids.length === 0) return;
    log(`Resolving names for ${jids.length} contacts via USyncQuery...`);

    try {
      // Query in batches of 20 to avoid rate limits
      for (let i = 0; i < jids.length; i += 20) {
        const batch = jids.slice(i, i + 20);
        const query = new USyncQuery()
          .withContactProtocol()
          .withStatusProtocol();

        for (const jid of batch) {
          query.withUser(new USyncUser().withId(jid));
        }

        const result = await this.sock.executeUSyncQuery(query);
        debugLog("USyncQuery result", result);

        if (result?.list) {
          for (const entry of result.list) {
            const id = entry.id;
            if (!id) continue;
            // Extract any available name info from the query result
            const status = entry.status as any;
            const contact = entry.contact;
            debugLog("USyncQuery entry", { id, status, contact, allKeys: Object.keys(entry) });

            // Status might contain push name or other info
            if (status?.status) {
              upsertContact({ id, notify: null }); // at least register the contact
            }
          }
        }
      }
      log("USyncQuery complete");
    } catch (err: any) {
      log(`USyncQuery failed: ${err.message}`);
      debugLog("USyncQuery error", err.message);
    }
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
