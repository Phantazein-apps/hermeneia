// Hermeneia — SQLite message store (sql.js — pure JavaScript, zero native deps)

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import type { MessageDict, ChatDict, ContactDict } from "./types.js";

let db: SqlJsDatabase;
let dbPath: string;

// Auto-save every N writes
let writesSinceFlush = 0;
const FLUSH_INTERVAL = 10;

function flush(): void {
  if (!db) return;
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
  writesSinceFlush = 0;
}

function maybeFlush(): void {
  writesSinceFlush++;
  if (writesSinceFlush >= FLUSH_INTERVAL) flush();
}

export async function initStore(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, "messages.db");

  const SQL = await initSqlJs({
    // In bundled mode (dist/), WASM is copied alongside index.js.
    // In dev mode (src/), fall back to the sql.js package dist directory.
    locateFile: (file: string) => {
      const local = join(__dirname, file);
      if (existsSync(local)) return local;
      return join(__dirname, "..", "node_modules", "sql.js", "dist", file);
    },
  });

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    )
  `);

  // Contacts table — maps LIDs to phone JIDs and stores all name variants
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      lid TEXT,
      phone_jid TEXT,
      name TEXT,
      notify TEXT,
      verified_name TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)");
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_jid)");

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      media_type TEXT,
      filename TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)"
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid)"
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)"
  );

  // Flush on exit
  process.on("exit", flush);
  process.on("SIGINT", () => {
    flush();
    process.exit(0);
  });
}

// ── Contact operations ─────────────────────────────────────────────

export function upsertContact(opts: {
  id: string;
  lid?: string | null;
  phoneJid?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}): void {
  db.run(
    `INSERT INTO contacts (id, lid, phone_jid, name, notify, verified_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       lid = COALESCE(excluded.lid, contacts.lid),
       phone_jid = COALESCE(excluded.phone_jid, contacts.phone_jid),
       name = COALESCE(excluded.name, contacts.name),
       notify = COALESCE(excluded.notify, contacts.notify),
       verified_name = COALESCE(excluded.verified_name, contacts.verified_name)`,
    [opts.id, opts.lid ?? null, opts.phoneJid ?? null, opts.name ?? null, opts.notify ?? null, opts.verifiedName ?? null]
  );
  maybeFlush();

  // Also update the chats table name if we have one
  const displayName = opts.name ?? opts.notify ?? opts.verifiedName ?? null;
  if (displayName) {
    upsertChat(opts.id, displayName, new Date(0).toISOString());
    // If we know the LID and phone JID, update both chat entries
    if (opts.lid) upsertChat(opts.lid, displayName, new Date(0).toISOString());
    if (opts.phoneJid) upsertChat(opts.phoneJid, displayName, new Date(0).toISOString());
  }
}

/** Diagnostic: return DB stats for debugging contact resolution */
export function getStoreDiagnostics(): any {
  const chatCount = queryOne("SELECT COUNT(*) as n FROM chats");
  const chatWithName = queryOne("SELECT COUNT(*) as n FROM chats WHERE name IS NOT NULL AND name != ''");
  const contactCount = queryOne("SELECT COUNT(*) as n FROM contacts");
  const contactWithName = queryOne("SELECT COUNT(*) as n FROM contacts WHERE name IS NOT NULL OR notify IS NOT NULL OR verified_name IS NOT NULL");
  const msgCount = queryOne("SELECT COUNT(*) as n FROM messages");
  const sampleContacts = queryAll("SELECT * FROM contacts LIMIT 5");
  const sampleChats = queryAll("SELECT jid, name FROM chats LIMIT 5");

  return {
    chats: { total: chatCount?.n, withName: chatWithName?.n },
    contacts: { total: contactCount?.n, withName: contactWithName?.n },
    messages: { total: msgCount?.n },
    sampleContacts,
    sampleChats,
  };
}

/** Resolve display name for any JID (LID, phone, or group) */
export function resolveContactName(jid: string): string | null {
  // 1. Direct contact lookup by id
  const direct = queryOne(
    "SELECT name, notify, verified_name FROM contacts WHERE id = ?",
    [jid]
  );
  if (direct) {
    const n = direct.name ?? direct.notify ?? direct.verified_name;
    if (n) return n;
  }

  // 2. Cross-reference: if this is a LID, find via lid column; if phone, via phone_jid
  const crossRef = queryOne(
    "SELECT name, notify, verified_name FROM contacts WHERE lid = ? OR phone_jid = ?",
    [jid, jid]
  );
  if (crossRef) {
    const n = crossRef.name ?? crossRef.notify ?? crossRef.verified_name;
    if (n) return n;
  }

  // 3. Fall back to chats table
  const chat = queryOne("SELECT name FROM chats WHERE jid = ?", [jid]);
  if (chat?.name) return chat.name;

  return null;
}

// ── Chat operations ────────────────────────────────────────────────

export function upsertChat(
  jid: string,
  name: string | null,
  lastMessageTime: string
): void {
  db.run(
    `INSERT INTO chats (jid, name, last_message_time)
     VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, chats.name),
       last_message_time = MAX(excluded.last_message_time, chats.last_message_time)`,
    [jid, name, lastMessageTime]
  );
  maybeFlush();
}

// ── Message operations ─────────────────────────────────────────────

export function storeMessage(
  id: string,
  chatJid: string,
  sender: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  mediaType: string | null,
  filename: string | null
): void {
  db.run(
    `INSERT OR IGNORE INTO messages
       (id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, chatJid, sender, content, timestamp, isFromMe ? 1 : 0, mediaType, filename]
  );
  maybeFlush();
}

// ── Query helpers ──────────────────────────────────────────────────

function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql: string, params: any[] = []): any | null {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function getSenderName(senderJid: string): string {
  return resolveContactName(senderJid) ?? senderJid;
}

function toMessageDict(row: any, includeSenderName = true): MessageDict {
  const senderPhone = row.sender?.split("@")[0] ?? row.sender;
  let senderName: string | null = null;
  let senderDisplay: string | null = null;

  if (includeSenderName) {
    if (row.is_from_me) {
      senderName = "Me";
      senderDisplay = "Me";
    } else {
      const resolved = getSenderName(row.sender);
      if (resolved && resolved !== row.sender && resolved !== senderPhone) {
        senderName = resolved;
        senderDisplay = `${resolved} (${senderPhone})`;
      } else {
        senderName = senderPhone;
        senderDisplay = senderPhone;
      }
    }
  }

  return {
    id: row.id,
    timestamp: row.timestamp,
    sender_jid: row.sender,
    sender_phone: senderPhone,
    sender_name: senderName,
    sender_display: senderDisplay,
    content: row.content,
    is_from_me: !!row.is_from_me,
    chat_jid: row.chat_jid,
    chat_name: row.chat_name ?? null,
    media_type: row.media_type ?? null,
  };
}

// ── Public query functions ─────────────────────────────────────────

export function listMessages(opts: {
  after?: string;
  before?: string;
  senderPhoneNumber?: string;
  chatJid?: string;
  query?: string;
  limit?: number;
  page?: number;
  sortBy?: "newest" | "oldest";
}): MessageDict[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const page = opts.page ?? 0;
  const offset = page * limit;
  const order = opts.sortBy === "oldest" ? "ASC" : "DESC";

  const where: string[] = [];
  const params: any[] = [];

  if (opts.after) {
    where.push("m.timestamp > ?");
    params.push(opts.after);
  }
  if (opts.before) {
    where.push("m.timestamp < ?");
    params.push(opts.before);
  }
  if (opts.senderPhoneNumber) {
    where.push("m.sender LIKE ?");
    params.push(`%${opts.senderPhoneNumber}%`);
  }
  if (opts.chatJid) {
    where.push("m.chat_jid = ?");
    params.push(opts.chatJid);
  }
  if (opts.query) {
    where.push("LOWER(m.content) LIKE LOWER(?)");
    params.push(`%${opts.query}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp,
           m.is_from_me, m.media_type, m.filename, c.name AS chat_name
    FROM messages m
    JOIN chats c ON m.chat_jid = c.jid
    ${whereClause}
    ORDER BY m.timestamp ${order}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  return queryAll(sql, params).map((r) => toMessageDict(r));
}

export function getMessageContext(
  messageId: string,
  before = 5,
  after = 5
): { message: MessageDict; before: MessageDict[]; after: MessageDict[] } | null {
  const msg = queryOne(
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid
     WHERE m.id = ?`,
    [messageId]
  );
  if (!msg) return null;

  const beforeRows = queryAll(
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid
     WHERE m.chat_jid = ? AND m.timestamp < ?
     ORDER BY m.timestamp DESC LIMIT ?`,
    [msg.chat_jid, msg.timestamp, before]
  );

  const afterRows = queryAll(
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid
     WHERE m.chat_jid = ? AND m.timestamp > ?
     ORDER BY m.timestamp ASC LIMIT ?`,
    [msg.chat_jid, msg.timestamp, after]
  );

  return {
    message: toMessageDict(msg),
    before: beforeRows.reverse().map((r) => toMessageDict(r)),
    after: afterRows.map((r) => toMessageDict(r)),
  };
}

export function listChats(opts: {
  query?: string;
  limit?: number;
  page?: number;
  includeLastMessage?: boolean;
  sortBy?: "last_active" | "name";
}): ChatDict[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const page = opts.page ?? 0;
  const offset = page * limit;
  const orderBy =
    opts.sortBy === "name" ? "c.name" : "c.last_message_time DESC";

  const where: string[] = [];
  const params: any[] = [];

  if (opts.query) {
    where.push("(LOWER(c.name) LIKE LOWER(?) OR c.jid LIKE ?)");
    params.push(`%${opts.query}%`, `%${opts.query}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const incLast = opts.includeLastMessage !== false;
  const joinClause = incLast
    ? "LEFT JOIN messages m ON c.jid = m.chat_jid AND c.last_message_time = m.timestamp"
    : "";
  const selectLast = incLast
    ? "m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me"
    : "NULL AS last_message, NULL AS last_sender, NULL AS last_is_from_me";

  const sql = `
    SELECT c.jid, c.name, c.last_message_time, ${selectLast}
    FROM chats c ${joinClause}
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  return queryAll(sql, params).map((r) => ({
    jid: r.jid,
    name: r.name || resolveContactName(r.jid) || r.jid.split("@")[0],
    is_group: (r.jid as string).endsWith("@g.us"),
    last_message_time: r.last_message_time,
    last_message: r.last_message,
    last_sender: r.last_sender,
    last_is_from_me: r.last_is_from_me != null ? !!r.last_is_from_me : null,
  }));
}

export function getChat(chatJid: string, includeLastMessage = true): ChatDict | null {
  const joinClause = includeLastMessage
    ? "LEFT JOIN messages m ON c.jid = m.chat_jid AND c.last_message_time = m.timestamp"
    : "";
  const selectLast = includeLastMessage
    ? "m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me"
    : "NULL AS last_message, NULL AS last_sender, NULL AS last_is_from_me";

  const row = queryOne(
    `SELECT c.jid, c.name, c.last_message_time, ${selectLast}
     FROM chats c ${joinClause} WHERE c.jid = ?`,
    [chatJid]
  );
  if (!row) return null;

  return {
    jid: row.jid,
    name: row.name || resolveContactName(row.jid) || row.jid.split("@")[0],
    is_group: (row.jid as string).endsWith("@g.us"),
    last_message_time: row.last_message_time,
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me: row.last_is_from_me != null ? !!row.last_is_from_me : null,
  };
}

export function getDirectChatByContact(phone: string): ChatDict | null {
  const row = queryOne(
    `SELECT c.jid, c.name, c.last_message_time,
            m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me
     FROM chats c
     LEFT JOIN messages m ON c.jid = m.chat_jid AND c.last_message_time = m.timestamp
     WHERE c.jid LIKE ? AND c.jid NOT LIKE '%@g.us'
     LIMIT 1`,
    [`%${phone}%`]
  );
  if (!row) return null;

  return {
    jid: row.jid,
    name: row.name,
    is_group: false,
    last_message_time: row.last_message_time,
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me: row.last_is_from_me != null ? !!row.last_is_from_me : null,
  };
}

export function getContactChats(jid: string, limit = 20, page = 0): ChatDict[] {
  return queryAll(
    `SELECT DISTINCT c.jid, c.name, c.last_message_time,
            m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me
     FROM chats c
     JOIN messages m ON c.jid = m.chat_jid
     WHERE m.sender = ? OR c.jid = ?
     ORDER BY c.last_message_time DESC
     LIMIT ? OFFSET ?`,
    [jid, jid, limit, page * limit]
  ).map((r) => ({
    jid: r.jid,
    name: r.name,
    is_group: (r.jid as string).endsWith("@g.us"),
    last_message_time: r.last_message_time,
    last_message: r.last_message,
    last_sender: r.last_sender,
    last_is_from_me: r.last_is_from_me != null ? !!r.last_is_from_me : null,
  }));
}

export function getLastInteraction(jid: string): MessageDict | null {
  const row = queryOne(
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid
     WHERE m.sender = ? OR c.jid = ?
     ORDER BY m.timestamp DESC LIMIT 1`,
    [jid, jid]
  );
  return row ? toMessageDict(row) : null;
}

export function searchContacts(query: string): ContactDict[] {
  const pattern = `%${query}%`;

  // Search both the contacts table and chats table, merge results
  const fromContacts = queryAll(
    `SELECT id, lid, phone_jid, name, notify, verified_name FROM contacts
     WHERE LOWER(COALESCE(name, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(notify, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(verified_name, '')) LIKE LOWER(?)
        OR LOWER(id) LIKE LOWER(?)
        OR LOWER(COALESCE(phone_jid, '')) LIKE LOWER(?)
     LIMIT 50`,
    [pattern, pattern, pattern, pattern, pattern]
  );

  const fromChats = queryAll(
    `SELECT DISTINCT jid, name FROM chats
     WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(jid) LIKE LOWER(?))
       AND jid NOT LIKE '%@g.us'
     ORDER BY name, jid
     LIMIT 50`,
    [pattern, pattern]
  );

  // Deduplicate by JID
  const seen = new Set<string>();
  const results: ContactDict[] = [];

  for (const r of fromContacts) {
    const jid = r.phone_jid ?? r.id;
    if (seen.has(jid)) continue;
    seen.add(jid);
    results.push({
      phone_number: (r.phone_jid ?? r.id).split("@")[0],
      name: r.name ?? r.notify ?? r.verified_name ?? null,
      jid: r.phone_jid ?? r.id,
    });
  }

  for (const r of fromChats) {
    if (seen.has(r.jid)) continue;
    seen.add(r.jid);
    results.push({
      phone_number: (r.jid as string).split("@")[0],
      name: r.name ?? resolveContactName(r.jid) ?? null,
      jid: r.jid,
    });
  }

  return results;
}
