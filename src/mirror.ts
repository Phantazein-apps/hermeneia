// Hermeneia → Epistole mirror (BETA)
//
// Optional one-way push of WhatsApp events to a remote Cloudflare Worker
// that indexes them for semantic_search alongside email. Disabled unless
// EPISTOLE_MIRROR_URL and EPISTOLE_MIRROR_TOKEN are set.
//
// Failure model: lossy. A failed POST is logged (rate-limited) and dropped.
// The mirror never throws into the event pipeline.

import { getChatNamesByJid } from "./store.js";

const log = (msg: string) => console.error(`[hermeneia:mirror] ${msg}`);

interface MirrorMessage {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string | null;
  media_info: any | null;
  filename: string | null;
}

interface MirrorChat {
  jid: string;
  name: string | null;
  last_message_time: string;
  unread_count?: number;
  archived?: boolean;
  parent_group_jid?: string | null;
  is_parent_group?: boolean;
}

interface MirrorContact {
  id: string;
  lid: string | null;
  phone_jid: string | null;
  name: string | null;
  notify: string | null;
  verified_name: string | null;
}

interface AccountQueue {
  messages: MirrorMessage[];
  chats: MirrorChat[];
  contacts: MirrorContact[];
  timer: NodeJS.Timeout | null;
}

const DEBOUNCE_MS = 1500;
const BATCH_THRESHOLD = 50;
const QUEUE_CAP = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const LOG_RATELIMIT_MS = 60_000;

let enabled = false;
let baseUrl = "";
let token = "";
let allowlist: Set<string> | null = null;

const queues = new Map<string, AccountQueue>();
let backoffUntil = 0;
let currentBackoff = BACKOFF_MIN_MS;
let lastErrorLogAt = 0;

export function initMirror(): { enabled: boolean; info: string } {
  const url = process.env.EPISTOLE_MIRROR_URL?.trim();
  const tok = process.env.EPISTOLE_MIRROR_TOKEN?.trim();
  const list = process.env.EPISTOLE_MIRROR_ACCOUNTS?.trim();

  if (!url || !tok) {
    enabled = false;
    return { enabled: false, info: "disabled (EPISTOLE_MIRROR_URL/TOKEN unset)" };
  }

  baseUrl = url.replace(/\/+$/, "");
  token = tok;
  allowlist = list ? new Set(list.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  enabled = true;

  const scope = allowlist ? `accounts: ${[...allowlist].join(",")}` : "all accounts";
  return { enabled: true, info: `${baseUrl} (${scope})` };
}

export function isMirrorEnabled(): boolean {
  return enabled;
}

function accountAllowed(accountId: string): boolean {
  if (!enabled) return false;
  if (!allowlist) return true;
  return allowlist.has(accountId);
}

function getQueue(accountId: string): AccountQueue {
  let q = queues.get(accountId);
  if (!q) {
    q = { messages: [], chats: [], contacts: [], timer: null };
    queues.set(accountId, q);
  }
  return q;
}

function scheduleFlush(accountId: string) {
  const q = getQueue(accountId);
  const size = q.messages.length + q.chats.length + q.contacts.length;
  if (size >= BATCH_THRESHOLD) {
    flushAccount(accountId).catch(() => {});
    return;
  }
  if (q.timer) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    flushAccount(accountId).catch(() => {});
  }, DEBOUNCE_MS);
}

function enqueueCapped<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > QUEUE_CAP) arr.splice(0, arr.length - QUEUE_CAP);
}

export function mirrorMessage(accountId: string, m: MirrorMessage): void {
  if (!accountAllowed(accountId)) return;
  try {
    enqueueCapped(getQueue(accountId).messages, m);
    scheduleFlush(accountId);
  } catch (err: any) {
    rateLimitedLog(`mirrorMessage enqueue failed: ${err?.message ?? err}`);
  }
}

export function mirrorChat(accountId: string, c: MirrorChat): void {
  if (!accountAllowed(accountId)) return;
  try {
    enqueueCapped(getQueue(accountId).chats, c);
    scheduleFlush(accountId);
  } catch (err: any) {
    rateLimitedLog(`mirrorChat enqueue failed: ${err?.message ?? err}`);
  }
}

export function mirrorContact(accountId: string, c: MirrorContact): void {
  if (!accountAllowed(accountId)) return;
  try {
    enqueueCapped(getQueue(accountId).contacts, c);
    scheduleFlush(accountId);
  } catch (err: any) {
    rateLimitedLog(`mirrorContact enqueue failed: ${err?.message ?? err}`);
  }
}

/** Directly push a batch, bypassing debounce. Used by backfill. Returns server result or throws. */
export async function pushBatch(
  accountId: string,
  opts: {
    accountLabel?: string | null;
    phone?: string | null;
    messages?: MirrorMessage[];
    chats?: MirrorChat[];
    contacts?: MirrorContact[];
  }
): Promise<{ messages_written: number; chats_written: number; contacts_written: number; embedded: number }> {
  if (!enabled) throw new Error("Epistole mirror is not configured");
  const body: any = { account_id: accountId };
  if (opts.accountLabel) body.account_label = opts.accountLabel;
  if (opts.phone) body.phone = opts.phone;
  if (opts.messages?.length) body.messages = enrichMessagesWithChatName(accountId, opts.messages);
  if (opts.chats?.length) body.chats = opts.chats;
  if (opts.contacts?.length) body.contacts = opts.contacts;

  const res = await doPost("/api/wa/push", body);
  if (!res.ok) throw new Error(`Epistole push failed: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  return {
    messages_written: json.messages_written ?? 0,
    chats_written: json.chats_written ?? 0,
    contacts_written: json.contacts_written ?? 0,
    embedded: json.embedded ?? 0,
  };
}

async function flushAccount(accountId: string): Promise<void> {
  if (!enabled) return;
  const q = getQueue(accountId);
  if (q.messages.length === 0 && q.chats.length === 0 && q.contacts.length === 0) return;

  if (Date.now() < backoffUntil) {
    // Still backing off — defer. Timer will fire again later when new events arrive.
    return;
  }

  const messages = q.messages.splice(0, q.messages.length);
  const chats = q.chats.splice(0, q.chats.length);
  const contacts = q.contacts.splice(0, q.contacts.length);

  const body: any = { account_id: accountId };
  if (messages.length) body.messages = enrichMessagesWithChatName(accountId, messages);
  if (chats.length) body.chats = chats;
  if (contacts.length) body.contacts = contacts;

  try {
    const res = await doPost("/api/wa/push", body);
    if (!res.ok) {
      triggerBackoff(`/api/wa/push HTTP ${res.status}`);
      return;
    }
    // Success — reset backoff
    currentBackoff = BACKOFF_MIN_MS;
    backoffUntil = 0;
  } catch (err: any) {
    triggerBackoff(`/api/wa/push ${err?.message ?? err}`);
  }
}

export async function mirrorHeartbeat(accountId: string, label: string | null, phone: string | null): Promise<void> {
  if (!accountAllowed(accountId)) return;
  if (Date.now() < backoffUntil) return;
  try {
    const res = await doPost("/api/wa/heartbeat", { account_id: accountId, label, phone });
    if (!res.ok) {
      rateLimitedLog(`heartbeat HTTP ${res.status}`);
    }
  } catch (err: any) {
    rateLimitedLog(`heartbeat ${err?.message ?? err}`);
  }
}

function enrichMessagesWithChatName(accountId: string, msgs: MirrorMessage[]): any[] {
  try {
    const jids = Array.from(new Set(msgs.map((m) => m.chat_jid)));
    const names = getChatNamesByJid(accountId, jids);
    return msgs.map((m) => {
      const name = names.get(m.chat_jid);
      return name ? { ...m, chat_name: name } : m;
    });
  } catch {
    return msgs;
  }
}

async function doPost(path: string, body: any): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(baseUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function triggerBackoff(reason: string) {
  backoffUntil = Date.now() + currentBackoff;
  rateLimitedLog(`${reason} — backing off for ${Math.round(currentBackoff / 1000)}s`);
  currentBackoff = Math.min(currentBackoff * 2, BACKOFF_MAX_MS);
}

function rateLimitedLog(msg: string) {
  const now = Date.now();
  if (now - lastErrorLogAt < LOG_RATELIMIT_MS) return;
  lastErrorLogAt = now;
  log(msg);
}

/** Flush all pending batches (best-effort) — used on shutdown. */
export async function flushAll(): Promise<void> {
  if (!enabled) return;
  await Promise.all(
    Array.from(queues.keys()).map((id) => flushAccount(id).catch(() => {}))
  );
}
