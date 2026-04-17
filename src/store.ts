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
      jid TEXT,
      account_id TEXT NOT NULL DEFAULT 'default',
      name TEXT,
      last_message_time TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      parent_group_jid TEXT,
      is_parent_group INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (jid, account_id)
    )
  `);

  // Contacts table — maps LIDs to phone JIDs and stores all name variants
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT,
      account_id TEXT NOT NULL DEFAULT 'default',
      lid TEXT,
      phone_jid TEXT,
      name TEXT,
      notify TEXT,
      verified_name TEXT,
      PRIMARY KEY (id, account_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)");
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_jid)");
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      account_id TEXT NOT NULL DEFAULT 'default',
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      media_type TEXT,
      media_info TEXT,
      filename TEXT,
      PRIMARY KEY (id, chat_jid, account_id)
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
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)"
  );

  // Migrate old schema: add account_id column if missing
  migrateAddAccountId();
  // Migrate: add media_info column if missing
  migrateAddMediaInfo();
  // Migrate: add unread_count, archived, parent_group columns if missing
  migrateAddChatColumns();

  // Flush on exit
  process.on("exit", flush);
  process.on("SIGINT", () => {
    flush();
    process.exit(0);
  });
}

function migrateAddAccountId(): void {
  // Check if old schema (no account_id) exists by inspecting table info
  try {
    const cols = queryAll("PRAGMA table_info(chats)");
    const hasAccountId = cols.some((c: any) => c.name === "account_id");
    if (hasAccountId) return; // Already migrated

    // Old schema detected — rebuild tables with account_id
    db.run("BEGIN TRANSACTION");

    // Chats: add column and update primary key
    db.run("ALTER TABLE chats RENAME TO chats_old");
    db.run(`CREATE TABLE chats (
      jid TEXT, account_id TEXT NOT NULL DEFAULT 'default',
      name TEXT, last_message_time TEXT,
      PRIMARY KEY (jid, account_id)
    )`);
    db.run("INSERT INTO chats (jid, account_id, name, last_message_time) SELECT jid, 'default', name, last_message_time FROM chats_old");
    db.run("DROP TABLE chats_old");

    // Contacts: add column and update primary key
    db.run("ALTER TABLE contacts RENAME TO contacts_old");
    db.run(`CREATE TABLE contacts (
      id TEXT, account_id TEXT NOT NULL DEFAULT 'default',
      lid TEXT, phone_jid TEXT, name TEXT, notify TEXT, verified_name TEXT,
      PRIMARY KEY (id, account_id)
    )`);
    db.run("INSERT INTO contacts (id, account_id, lid, phone_jid, name, notify, verified_name) SELECT id, 'default', lid, phone_jid, name, notify, verified_name FROM contacts_old");
    db.run("DROP TABLE contacts_old");

    // Messages: add column and update primary key
    db.run("ALTER TABLE messages RENAME TO messages_old");
    db.run(`CREATE TABLE messages (
      id TEXT, chat_jid TEXT, account_id TEXT NOT NULL DEFAULT 'default',
      sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER,
      media_type TEXT, media_info TEXT, filename TEXT,
      PRIMARY KEY (id, chat_jid, account_id)
    )`);
    db.run("INSERT INTO messages (id, chat_jid, account_id, sender, content, timestamp, is_from_me, media_type, filename) SELECT id, chat_jid, 'default', sender, content, timestamp, is_from_me, media_type, filename FROM messages_old");
    db.run("DROP TABLE messages_old");

    // Recreate indices
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_jid)");
    db.run("CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)");

    db.run("COMMIT");
    console.error("[hermeneia] Migrated database schema to multi-account format");
    flush();
  } catch (err) {
    try { db.run("ROLLBACK"); } catch {}
    console.error("[hermeneia] Migration error:", err);
  }
}

function migrateAddMediaInfo(): void {
  // Check if media_info column already exists
  const cols = db.exec("PRAGMA table_info(messages)");
  if (!cols.length) return;
  const hasMediaInfo = cols[0].values.some((row: any[]) => row[1] === "media_info");
  if (hasMediaInfo) return;

  try {
    db.run("ALTER TABLE messages ADD COLUMN media_info TEXT");
    console.error("[hermeneia] Added media_info column to messages table");
    flush();
  } catch (err) {
    console.error("[hermeneia] media_info migration error:", err);
  }
}

function migrateAddChatColumns(): void {
  const cols = db.exec("PRAGMA table_info(chats)");
  if (!cols.length) return;
  const colNames = new Set(cols[0].values.map((row: any[]) => row[1]));

  try {
    if (!colNames.has("unread_count")) {
      db.run("ALTER TABLE chats ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0");
      console.error("[hermeneia] Added unread_count column to chats table");
    }
    if (!colNames.has("archived")) {
      db.run("ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
      console.error("[hermeneia] Added archived column to chats table");
    }
    if (!colNames.has("parent_group_jid")) {
      db.run("ALTER TABLE chats ADD COLUMN parent_group_jid TEXT");
      console.error("[hermeneia] Added parent_group_jid column to chats table");
    }
    if (!colNames.has("is_parent_group")) {
      db.run("ALTER TABLE chats ADD COLUMN is_parent_group INTEGER NOT NULL DEFAULT 0");
      console.error("[hermeneia] Added is_parent_group column to chats table");
    }
    flush();
  } catch (err) {
    console.error("[hermeneia] chat columns migration error:", err);
  }
}

export function incrementUnread(accountId: string, chatJid: string): void {
  db.run(
    "UPDATE chats SET unread_count = unread_count + 1 WHERE jid = ? AND account_id = ?",
    [chatJid, accountId]
  );
}

// ── Contact operations ─────────────────────────────────────────────

export function upsertContact(accountId: string, opts: {
  id: string;
  lid?: string | null;
  phoneJid?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}): void {
  db.run(
    `INSERT INTO contacts (id, account_id, lid, phone_jid, name, notify, verified_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, account_id) DO UPDATE SET
       lid = COALESCE(excluded.lid, contacts.lid),
       phone_jid = COALESCE(excluded.phone_jid, contacts.phone_jid),
       name = COALESCE(excluded.name, contacts.name),
       notify = COALESCE(excluded.notify, contacts.notify),
       verified_name = COALESCE(excluded.verified_name, contacts.verified_name)`,
    [opts.id, accountId, opts.lid ?? null, opts.phoneJid ?? null, opts.name ?? null, opts.notify ?? null, opts.verifiedName ?? null]
  );
  maybeFlush();

  // Also update the chats table name if we have one
  const displayName = opts.name ?? opts.notify ?? opts.verifiedName ?? null;
  if (displayName) {
    upsertChat(accountId, opts.id, displayName, new Date(0).toISOString());
    if (opts.lid) upsertChat(accountId, opts.lid, displayName, new Date(0).toISOString());
    if (opts.phoneJid) upsertChat(accountId, opts.phoneJid, displayName, new Date(0).toISOString());
  }
}

/** Get all chat JIDs for batch contact resolution */
export function getAllChatJids(accountId?: string): string[] {
  if (accountId) {
    return queryAll("SELECT jid FROM chats WHERE account_id = ?", [accountId]).map((r) => r.jid as string);
  }
  return queryAll("SELECT jid FROM chats").map((r) => r.jid as string);
}

/** Diagnostic: return DB stats for debugging contact resolution */
export function getStoreDiagnostics(accountId?: string): any {
  const acFilter = accountId ? " WHERE account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  const chatCount = queryOne(`SELECT COUNT(*) as n FROM chats${acFilter}`, acParams);
  const chatWithName = queryOne(`SELECT COUNT(*) as n FROM chats WHERE name IS NOT NULL AND name != ''${accountId ? " AND account_id = ?" : ""}`, acParams);
  const contactCount = queryOne(`SELECT COUNT(*) as n FROM contacts${acFilter}`, acParams);
  const contactWithName = queryOne(`SELECT COUNT(*) as n FROM contacts WHERE (name IS NOT NULL OR notify IS NOT NULL OR verified_name IS NOT NULL)${accountId ? " AND account_id = ?" : ""}`, acParams);
  const msgCount = queryOne(`SELECT COUNT(*) as n FROM messages${acFilter}`, acParams);

  return {
    account_id: accountId ?? "all",
    chats: { total: chatCount?.n, withName: chatWithName?.n },
    contacts: { total: contactCount?.n, withName: contactWithName?.n },
    messages: { total: msgCount?.n },
  };
}

/** Resolve display name for any JID (LID, phone, or group) */
export function resolveContactName(jid: string, accountId?: string): string | null {
  const acFilter = accountId ? " AND account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  // 1. Direct contact lookup by id
  const direct = queryOne(
    `SELECT name, notify, verified_name FROM contacts WHERE id = ?${acFilter}`,
    [jid, ...acParams]
  );
  if (direct) {
    const n = direct.name ?? direct.notify ?? direct.verified_name;
    if (n) return n;
  }

  // 2. Cross-reference: if this is a LID, find via lid column; if phone, via phone_jid
  const crossRef = queryOne(
    `SELECT name, notify, verified_name FROM contacts WHERE (lid = ? OR phone_jid = ?)${acFilter}`,
    [jid, jid, ...acParams]
  );
  if (crossRef) {
    const n = crossRef.name ?? crossRef.notify ?? crossRef.verified_name;
    if (n) return n;
  }

  // 3. Fall back to chats table
  const chat = queryOne(`SELECT name FROM chats WHERE jid = ?${acFilter}`, [jid, ...acParams]);
  if (chat?.name) return chat.name;

  return null;
}

// ── Chat operations ────────────────────────────────────────────────

export function upsertChat(
  accountId: string,
  jid: string,
  name: string | null,
  lastMessageTime: string,
  opts?: { unreadCount?: number; archived?: boolean; parentGroupJid?: string; isParentGroup?: boolean }
): void {
  db.run(
    `INSERT INTO chats (jid, account_id, name, last_message_time, unread_count, archived, parent_group_jid, is_parent_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid, account_id) DO UPDATE SET
       name = COALESCE(excluded.name, chats.name),
       last_message_time = MAX(excluded.last_message_time, chats.last_message_time),
       unread_count = CASE WHEN excluded.unread_count >= 0 THEN excluded.unread_count ELSE chats.unread_count END,
       archived = CASE WHEN excluded.archived >= 0 THEN excluded.archived ELSE chats.archived END,
       parent_group_jid = COALESCE(excluded.parent_group_jid, chats.parent_group_jid),
       is_parent_group = CASE WHEN excluded.is_parent_group >= 0 THEN excluded.is_parent_group ELSE chats.is_parent_group END`,
    [
      jid, accountId, name, lastMessageTime,
      opts?.unreadCount ?? -1,
      opts?.archived !== undefined ? (opts.archived ? 1 : 0) : -1,
      opts?.parentGroupJid ?? null,
      opts?.isParentGroup !== undefined ? (opts.isParentGroup ? 1 : 0) : -1,
    ]
  );
  maybeFlush();
}

// ── Message operations ─────────────────────────────────────────────

export function storeMessage(
  accountId: string,
  id: string,
  chatJid: string,
  sender: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  mediaType: string | null,
  filename: string | null,
  mediaInfo: string | null = null
): void {
  db.run(
    `INSERT OR IGNORE INTO messages
       (id, chat_jid, account_id, sender, content, timestamp, is_from_me, media_type, media_info, filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, chatJid, accountId, sender, content, timestamp, isFromMe ? 1 : 0, mediaType, mediaInfo, filename]
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

export function getSenderName(senderJid: string, accountId?: string): string {
  return resolveContactName(senderJid, accountId) ?? senderJid;
}

function toMessageDict(row: any, includeSenderName = true, accountId?: string): MessageDict {
  const senderPhone = row.sender?.split("@")[0] ?? row.sender;
  let senderName: string | null = null;
  let senderDisplay: string | null = null;

  if (includeSenderName) {
    if (row.is_from_me) {
      senderName = "Me";
      senderDisplay = "Me";
    } else {
      const resolved = getSenderName(row.sender, accountId ?? row.account_id);
      if (resolved && resolved !== row.sender && resolved !== senderPhone) {
        senderName = resolved;
        senderDisplay = `${resolved} (${senderPhone})`;
      } else {
        senderName = senderPhone;
        senderDisplay = senderPhone;
      }
    }
  }

  const dict: MessageDict = {
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
  if (row.account_id) dict.account_id = row.account_id;
  return dict;
}

export function getMessageMediaInfo(messageId: string, accountId?: string): string | null {
  const sql = accountId
    ? "SELECT media_info FROM messages WHERE id = ? AND account_id = ? AND media_info IS NOT NULL LIMIT 1"
    : "SELECT media_info FROM messages WHERE id = ? AND media_info IS NOT NULL LIMIT 1";
  const params = accountId ? [messageId, accountId] : [messageId];
  const row = queryOne(sql, params);
  return row?.media_info ?? null;
}

// ── Public query functions ─────────────────────────────────────────

export function listMessages(opts: {
  accountId?: string;
  after?: string;
  before?: string;
  senderPhoneNumber?: string;
  chatJid?: string;
  query?: string;
  isFromMe?: boolean;
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

  if (opts.accountId) {
    where.push("m.account_id = ?");
    params.push(opts.accountId);
  }
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
  if (opts.isFromMe !== undefined) {
    where.push("m.is_from_me = ?");
    params.push(opts.isFromMe ? 1 : 0);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
           m.is_from_me, m.media_type, m.filename, c.name AS chat_name
    FROM messages m
    JOIN chats c ON m.chat_jid = c.jid AND m.account_id = c.account_id
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
  after = 5,
  accountId?: string
): { message: MessageDict; before: MessageDict[]; after: MessageDict[] } | null {
  const acFilter = accountId ? " AND m.account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  const msg = queryOne(
    `SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid AND m.account_id = c.account_id
     WHERE m.id = ?${acFilter}`,
    [messageId, ...acParams]
  );
  if (!msg) return null;

  const beforeRows = queryAll(
    `SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid AND m.account_id = c.account_id
     WHERE m.chat_jid = ? AND m.account_id = ? AND m.timestamp < ?
     ORDER BY m.timestamp DESC LIMIT ?`,
    [msg.chat_jid, msg.account_id, msg.timestamp, before]
  );

  const afterRows = queryAll(
    `SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid AND m.account_id = c.account_id
     WHERE m.chat_jid = ? AND m.account_id = ? AND m.timestamp > ?
     ORDER BY m.timestamp ASC LIMIT ?`,
    [msg.chat_jid, msg.account_id, msg.timestamp, after]
  );

  return {
    message: toMessageDict(msg),
    before: beforeRows.reverse().map((r) => toMessageDict(r)),
    after: afterRows.map((r) => toMessageDict(r)),
  };
}

export function listChats(opts: {
  accountId?: string;
  query?: string;
  limit?: number;
  page?: number;
  includeLastMessage?: boolean;
  sortBy?: "last_active" | "name";
  unreadOnly?: boolean;
  includeArchived?: boolean;
}): ChatDict[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const page = opts.page ?? 0;
  const offset = page * limit;
  // Non-archived chats first, then by chosen sort
  const sortField = opts.sortBy === "name" ? "c.name" : "c.last_message_time DESC";
  const orderBy = opts.includeArchived ? `c.archived ASC, ${sortField}` : sortField;

  const where: string[] = [];
  const params: any[] = [];

  if (opts.accountId) {
    where.push("c.account_id = ?");
    params.push(opts.accountId);
  }
  if (opts.query) {
    where.push("(LOWER(c.name) LIKE LOWER(?) OR c.jid LIKE ?)");
    params.push(`%${opts.query}%`, `%${opts.query}%`);
  }
  if (opts.unreadOnly) {
    where.push("c.unread_count > 0");
  }
  if (!opts.includeArchived) {
    where.push("c.archived = 0");
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const incLast = opts.includeLastMessage !== false;
  const joinClause = incLast
    ? "LEFT JOIN messages m ON c.jid = m.chat_jid AND c.account_id = m.account_id AND c.last_message_time = m.timestamp"
    : "";
  const selectLast = incLast
    ? "m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me"
    : "NULL AS last_message, NULL AS last_sender, NULL AS last_is_from_me";

  const sql = `
    SELECT c.jid, c.account_id, c.name, c.last_message_time, c.unread_count,
           c.archived, c.parent_group_jid, c.is_parent_group, ${selectLast}
    FROM chats c ${joinClause}
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  return queryAll(sql, params).map((r) => {
    const dict: ChatDict = {
      jid: r.jid,
      name: r.name || resolveContactName(r.jid, r.account_id) || r.jid.split("@")[0],
      is_group: (r.jid as string).endsWith("@g.us"),
      last_message_time: r.last_message_time,
      unread_count: r.unread_count ?? 0,
      archived: !!r.archived,
      parent_group_jid: r.parent_group_jid || null,
      is_parent_group: !!r.is_parent_group,
      last_message: r.last_message,
      last_sender: r.last_sender,
      last_is_from_me: r.last_is_from_me != null ? !!r.last_is_from_me : null,
    };
    if (r.account_id) dict.account_id = r.account_id;
    return dict;
  });
}

export function getChat(chatJid: string, includeLastMessage = true, accountId?: string): ChatDict | null {
  const acFilter = accountId ? " AND c.account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  const joinClause = includeLastMessage
    ? "LEFT JOIN messages m ON c.jid = m.chat_jid AND c.account_id = m.account_id AND c.last_message_time = m.timestamp"
    : "";
  const selectLast = includeLastMessage
    ? "m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me"
    : "NULL AS last_message, NULL AS last_sender, NULL AS last_is_from_me";

  const row = queryOne(
    `SELECT c.jid, c.account_id, c.name, c.last_message_time, ${selectLast}
     FROM chats c ${joinClause} WHERE c.jid = ?${acFilter}`,
    [chatJid, ...acParams]
  );
  if (!row) return null;

  const dict: ChatDict = {
    jid: row.jid,
    name: row.name || resolveContactName(row.jid, row.account_id) || row.jid.split("@")[0],
    is_group: (row.jid as string).endsWith("@g.us"),
    last_message_time: row.last_message_time,
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me: row.last_is_from_me != null ? !!row.last_is_from_me : null,
  };
  if (row.account_id) dict.account_id = row.account_id;
  return dict;
}

export function getDirectChatByContact(phone: string, accountId?: string): ChatDict | null {
  const acFilter = accountId ? " AND c.account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  const row = queryOne(
    `SELECT c.jid, c.account_id, c.name, c.last_message_time,
            m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me
     FROM chats c
     LEFT JOIN messages m ON c.jid = m.chat_jid AND c.account_id = m.account_id AND c.last_message_time = m.timestamp
     WHERE c.jid LIKE ? AND c.jid NOT LIKE '%@g.us'${acFilter}
     LIMIT 1`,
    [`%${phone}%`, ...acParams]
  );
  if (!row) return null;

  const dict: ChatDict = {
    jid: row.jid,
    name: row.name,
    is_group: false,
    last_message_time: row.last_message_time,
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me: row.last_is_from_me != null ? !!row.last_is_from_me : null,
  };
  if (row.account_id) dict.account_id = row.account_id;
  return dict;
}

export function getContactChats(jid: string, limit = 20, page = 0, accountId?: string): ChatDict[] {
  const acFilter = accountId ? " AND c.account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  return queryAll(
    `SELECT DISTINCT c.jid, c.account_id, c.name, c.last_message_time,
            m.content AS last_message, m.sender AS last_sender, m.is_from_me AS last_is_from_me
     FROM chats c
     JOIN messages m ON c.jid = m.chat_jid AND c.account_id = m.account_id
     WHERE (m.sender = ? OR c.jid = ?)${acFilter}
     ORDER BY c.last_message_time DESC
     LIMIT ? OFFSET ?`,
    [jid, jid, ...acParams, limit, page * limit]
  ).map((r) => {
    const dict: ChatDict = {
      jid: r.jid,
      name: r.name,
      is_group: (r.jid as string).endsWith("@g.us"),
      last_message_time: r.last_message_time,
      last_message: r.last_message,
      last_sender: r.last_sender,
      last_is_from_me: r.last_is_from_me != null ? !!r.last_is_from_me : null,
    };
    if (r.account_id) dict.account_id = r.account_id;
    return dict;
  });
}

export function getLastInteraction(jid: string, accountId?: string): MessageDict | null {
  const acFilter = accountId ? " AND m.account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  const row = queryOne(
    `SELECT m.id, m.chat_jid, m.account_id, m.sender, m.content, m.timestamp,
            m.is_from_me, m.media_type, m.filename, c.name AS chat_name
     FROM messages m JOIN chats c ON m.chat_jid = c.jid AND m.account_id = c.account_id
     WHERE (m.sender = ? OR c.jid = ?)${acFilter}
     ORDER BY m.timestamp DESC LIMIT 1`,
    [jid, jid, ...acParams]
  );
  return row ? toMessageDict(row) : null;
}

export function searchContacts(query: string, accountId?: string): ContactDict[] {
  const pattern = `%${query}%`;
  const acFilter = accountId ? " AND account_id = ?" : "";
  const acParams = accountId ? [accountId] : [];

  // Search both the contacts table and chats table, merge results
  const fromContacts = queryAll(
    `SELECT id, account_id, lid, phone_jid, name, notify, verified_name FROM contacts
     WHERE (LOWER(COALESCE(name, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(notify, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(verified_name, '')) LIKE LOWER(?)
        OR LOWER(id) LIKE LOWER(?)
        OR LOWER(COALESCE(phone_jid, '')) LIKE LOWER(?))${acFilter}
     LIMIT 50`,
    [pattern, pattern, pattern, pattern, pattern, ...acParams]
  );

  const fromChats = queryAll(
    `SELECT DISTINCT jid, account_id, name FROM chats
     WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(jid) LIKE LOWER(?))
       AND jid NOT LIKE '%@g.us'${acFilter}
     ORDER BY name, jid
     LIMIT 50`,
    [pattern, pattern, ...acParams]
  );

  // Deduplicate by JID+account
  const seen = new Set<string>();
  const results: ContactDict[] = [];

  for (const r of fromContacts) {
    const jid = r.phone_jid ?? r.id;
    const key = `${jid}:${r.account_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dict: ContactDict = {
      phone_number: (r.phone_jid ?? r.id).split("@")[0],
      name: r.name ?? r.notify ?? r.verified_name ?? null,
      jid: r.phone_jid ?? r.id,
    };
    if (r.account_id) dict.account_id = r.account_id;
    results.push(dict);
  }

  for (const r of fromChats) {
    const key = `${r.jid}:${r.account_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dict: ContactDict = {
      phone_number: (r.jid as string).split("@")[0],
      name: r.name ?? resolveContactName(r.jid, r.account_id) ?? null,
      jid: r.jid,
    };
    if (r.account_id) dict.account_id = r.account_id;
    results.push(dict);
  }

  return results;
}
