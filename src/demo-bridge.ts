// Hermeneia — demo/mock bridge
//
// Drop-in replacement for WhatsAppBridge (same public surface, same
// EventEmitter events) that replays bundled fixture data instead of
// spawning the Go/whatsmeow subprocess. Selected in bridge-manager.ts when
// HERMENEIA_DEMO=1. Never touches the network and never spawns a process —
// there is no `child_process` import anywhere in this file.

import { EventEmitter } from "events";
import { upsertChat, storeMessage, upsertContact, incrementUnread } from "./store.js";
import { mirrorMessage, mirrorChat, mirrorContact } from "./mirror.js";
import type { BridgeStatus } from "./types.js";
import {
  CONTACTS,
  CHATS,
  MESSAGES,
  DEMO_PHOTO_PATH,
  DEMO_PHOTO_MESSAGE_ID,
  CANNED_REPLY,
} from "./demo-fixtures.js";

const log = (msg: string) => console.error(`[hermeneia:demo] ${msg}`);

// Keep the fixture load ordered and slightly staggered so log output reads
// like a real bridge connecting, not an instant dump.
const STEP_DELAY_MS = 60;
const REPLY_DELAY_MS = 2500;

function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** Best-effort: map whatever `recipient` a tool call passes (phone number,
 *  bare digits, or a full jid) to a chat jid. Falls back to synthesizing one
 *  so sends to numbers outside the fixture set still succeed believably. */
function resolveRecipientJid(recipient: string): string {
  if (recipient.includes("@")) return recipient;
  const digits = recipient.replace(/[^0-9]/g, "");
  const match = CONTACTS.find((c) => c.id.startsWith(digits) || digits.endsWith(c.id.split("@")[0].slice(-6)));
  return match?.id ?? `${digits || "0000000000"}@s.whatsapp.net`;
}

export class DemoBridge extends EventEmitter {
  private dataDir: string;
  private _accountId: string;
  private _connected = false;
  private _authenticated = false;
  private _displayName: string | null = "Demo (not a real account)";
  private _phone: string | null = "demo";
  private _lastEventTime = Date.now();
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

  constructor(dataDir: string, accountId = "default", _logDir: string | null = null) {
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
    // Demo mode owns its own display name — ignore attempts to overwrite it
    // (bridge-manager sets this from saved accounts.json on construction).
    if (name) this._displayName = this._displayName ?? name;
  }

  get phone(): string | null {
    return this._phone;
  }
  set phone(phone: string | null) {
    if (phone) this._phone = this._phone;
  }

  get status(): BridgeStatus {
    return { connected: this._connected, authenticated: this._authenticated, qr_url: null };
  }

  get isConnected(): boolean {
    return this._connected && this._authenticated;
  }

  get lastEventTime(): number {
    return this._lastEventTime;
  }

  get pid(): number | null {
    return null;
  }

  get socket(): null {
    return null;
  }

  setQrPort(_port: number): void {
    // No QR server ever runs in demo mode.
  }

  forceKill(_signal?: NodeJS.Signals): void {
    // Nothing to kill — demo mode has no subprocess. Mirrors the real
    // bridge's API so the watchdog can call it unconditionally.
    this._connected = false;
  }

  private touch(): void {
    this._lastEventTime = Date.now();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    log(`DEMO MODE — loading fixture data for account "${this._accountId}" (nothing is real)`);

    // Self-heartbeat so bridge-manager's idle watchdog never sees this
    // bridge as stale and force-kills it after HERMENEIA_WATCHDOG_TIMEOUT_MS.
    this.heartbeat = setInterval(() => this.touch(), 60_000);
    this.heartbeat.unref?.();

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    this._connected = true;
    this._authenticated = true;
    this.touch();
    this.emit("connected");
    log(`Connected (fixture data) — account "${this._accountId}"`);
    await wait(STEP_DELAY_MS);

    this.emit("account_info", { phone: this._phone, name: this._displayName });
    await wait(STEP_DELAY_MS);

    for (const c of CONTACTS) {
      upsertContact(this._accountId, {
        id: c.id,
        lid: c.lid,
        phoneJid: c.phoneJid,
        name: c.name,
        notify: c.notify,
        verifiedName: c.verifiedName,
      });
      try {
        mirrorContact(this._accountId, {
          id: c.id,
          lid: c.lid,
          phone_jid: c.phoneJid,
          name: c.name,
          notify: c.notify,
          verified_name: c.verifiedName,
        });
      } catch {}
    }
    log(`Contacts ready: ${CONTACTS.length} contacts loaded`);
    await wait(STEP_DELAY_MS);

    for (const c of CHATS) {
      upsertChat(this._accountId, c.jid, c.name, c.lastMessageTime, {
        unreadCount: c.unreadCount,
        archived: c.archived,
        parentGroupJid: c.parentGroupJid,
        isParentGroup: c.isParentGroup,
      });
      try {
        mirrorChat(this._accountId, {
          jid: c.jid,
          name: c.name,
          last_message_time: c.lastMessageTime,
          unread_count: c.unreadCount,
          archived: c.archived,
          parent_group_jid: c.parentGroupJid ?? null,
          is_parent_group: c.isParentGroup,
        });
      } catch {}
    }
    await wait(STEP_DELAY_MS);

    for (const m of MESSAGES) {
      const mediaInfo = m.mediaInfo ? JSON.stringify(m.mediaInfo) : null;
      storeMessage(
        this._accountId,
        m.id,
        m.chatJid,
        m.sender,
        m.content,
        m.timestamp,
        m.isFromMe,
        m.mediaType ?? null,
        null,
        mediaInfo
      );
      try {
        mirrorMessage(this._accountId, {
          id: m.id,
          chat_jid: m.chatJid,
          sender: m.sender,
          content: m.content,
          timestamp: m.timestamp,
          is_from_me: m.isFromMe,
          media_type: m.mediaType ?? null,
          media_info: m.mediaInfo ?? null,
          filename: (m.mediaInfo as any)?.filename ?? null,
        });
      } catch {}
    }
    this.touch();
    log(`Loaded ${MESSAGES.length} fixture messages across ${CHATS.length} chats`);
  }

  // ── Public actions (called by MCP tools) ───────────────────────

  async sendMessage(recipient: string, text: string): Promise<{ success: boolean; message: string }> {
    const chatJid = resolveRecipientJid(recipient);
    const id = `demo-sent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    upsertChat(this._accountId, chatJid, null, timestamp, { unreadCount: 0 });
    storeMessage(this._accountId, id, chatJid, "me", text, timestamp, true, null, null, null);
    this.touch();
    this.emit("message", {
      id,
      chatJid,
      sender: "me",
      content: text,
      isFromMe: true,
      timestamp,
      mediaType: null,
      pushName: null,
    });

    if (!isGroupJid(chatJid)) {
      setTimeout(() => this.sendCannedReply(chatJid), REPLY_DELAY_MS).unref?.();
    }

    return { success: true, message: "Sent (demo mode — not a real WhatsApp message)" };
  }

  private sendCannedReply(chatJid: string): void {
    const id = `demo-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();
    upsertChat(this._accountId, chatJid, null, timestamp);
    storeMessage(this._accountId, id, chatJid, chatJid, CANNED_REPLY, timestamp, false, null, null, null);
    this.touch();
    this.emit("message", {
      id,
      chatJid,
      sender: chatJid,
      content: CANNED_REPLY,
      isFromMe: false,
      timestamp,
      mediaType: null,
      pushName: "Demo",
    });
  }

  async sendFile(
    recipient: string,
    _filePath: string,
    _caption?: string
  ): Promise<{ success: boolean; message: string }> {
    // Reuse sendMessage's plumbing — demo mode doesn't inspect real file
    // bytes, it just needs the send→store→read loop to be demonstrable.
    return this.sendMessage(recipient, "[demo file attachment]");
  }

  async downloadMedia(
    messageId: string,
    _chatJid: string,
    _mediaInfo?: any,
    _saveDir?: string
  ): Promise<{ success: boolean; message: string }> {
    if (messageId === DEMO_PHOTO_MESSAGE_ID) {
      return { success: true, message: DEMO_PHOTO_PATH };
    }
    return {
      success: false,
      message:
        "Demo mode only bundles real media bytes for one sample photo. " +
        "This message's media isn't backed by an actual file.",
    };
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this._connected = false;
  }
}
