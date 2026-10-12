import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_is_from_me?: boolean | null;
}

export interface MediaRow {
  message_id: string;
  chat_jid: string;
  media_type: string | null;
  filename: string | null;
  mimetype: string | null;
  file_length: number | null;
  raw: string;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  sender_name?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
  media_type?: string | null;
};

export interface MessageFilters {
  chatJid?: string | null;
  chatName?: string | null;
  senderJid?: string | null;
  query?: string | null;
  after?: string | null; // ISO string
  before?: string | null; // ISO string
  limit?: number;
  page?: number;
  mediaType?: string | null;
};

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    dbInstance = new DatabaseSync(DB_PATH);
  }
  return dbInstance;
}

export function initializeDatabase(): DatabaseSync {
  const db = getDb();

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT -- Store dates as ISO strings
        );
    `);

  db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,      -- JID of the sender (can be group participant or contact)
            content TEXT,
            timestamp TEXT, -- Store dates as ISO strings
            is_from_me INTEGER, -- Store booleans as 0 or 1
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
        );
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS media_raw (
        message_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        media_type TEXT,
        filename TEXT,
        mimetype TEXT,
        file_length INTEGER,
        raw TEXT NOT NULL,
        PRIMARY KEY (message_id, chat_jid)
      );
    `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  return db;
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v);
  return s === "" || s === "undefined" || s === "null" ? null : s;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO chats (jid, name, last_message_time)
      VALUES (@jid, @name, @last_message_time)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        last_message_time = CASE
          WHEN excluded.last_message_time IS NULL THEN last_message_time
          WHEN last_message_time IS NULL OR last_message_time = 'undefined'
               OR excluded.last_message_time > last_message_time
            THEN excluded.last_message_time
          ELSE last_message_time
        END
    `);
    stmt.run({
      jid: chat.jid,
      name: chat.name ?? null,
      last_message_time: toIsoOrNull(chat.last_message_time),
    });
  } catch (error) {
    console.error("Error storing chat:", error);
  }
}

export function storeMessage(message: Message): void {
  const db = getDb();
  try {
    storeChat({ jid: message.chat_jid, last_message_time: message.timestamp });

    const stmt = db.prepare(`
            INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me)
        `);

    stmt.run({
      id: message.id,
      chat_jid: message.chat_jid,
      sender: message.sender ?? null,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      is_from_me: message.is_from_me ? 1 : 0,
    });

    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);
    updateChatTimeStmt.run({
      timestamp: message.timestamp.toISOString(),
      jid: message.chat_jid,
    });
  } catch (error) {
    console.error("Error storing message:", error);
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: Boolean(row.is_from_me),
    chat_name: row.chat_name,
    media_type: row.media_type ?? null,
  };
}

function rowToChat(row: any): Chat {
  return {
    jid: row.jid,
    name: row.name,
    last_message_time: parseDateSafe(row.last_message_time),
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me:
      row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null,
  };
}

const MSG_SELECT = `
  SELECT m.*,
         COALESCE(c.name, cc.name, cc.notify, cc.phone_number) AS chat_name,
         COALESCE(cs.name, cs.notify, cs.phone_number) AS sender_name,
         mr.media_type AS media_type
  FROM messages m
  JOIN chats c ON m.chat_jid = c.jid
  LEFT JOIN contacts cc ON cc.jid = c.jid
  LEFT JOIN contacts cs ON cs.jid = m.sender
  LEFT JOIN media_raw mr ON mr.message_id = m.id AND mr.chat_jid = m.chat_jid
`;

// export function getMessages(
//   chatJid: string,
//   limit: number = 20,
//   page: number = 0,
// ): Message[] {
//   const db = getDb();
//   try {
//     const offset = page * limit;
//     const stmt = db.prepare(`${MSG_SELECT} WHERE m.chat_jid = ? ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`);
//     const rows = stmt.all(chatJid, limit, offset) as any[];
//     return rows.map(rowToMessage);
//   } catch (error) {
//     console.error("Error getting messages:", error);
//     return [];
//   }
// }

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${includeLastMessage
        ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
        : ""
      }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
        `;

    const params: (string | number)[] = [];

    if (query) {
      sql += ` WHERE (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, ct.name, ct.notify, ct.phone_number) ASC";
    sql += ` ORDER BY ${orderByClause}, c.jid ASC`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error getting chats:", error);
    return [];
  }
}

export function getChat(
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const db = getDb();
  try {
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${includeLastMessage
        ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
        : ""
      }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
            WHERE c.jid = ? -- Positional parameter 1
        `;

    const stmt = db.prepare(sql);
    const row = stmt.get(jid) as any | undefined;
    return row ? rowToChat(row) : null;
  } catch (error) {
    console.error("Error getting chat:", error);
    return null;
  }
}

export function getMessagesAround(
  messageId: string,
  before: number = 5,
  after: number = 5,
): { before: Message[]; target: Message | null; after: Message[] } {
  const db = getDb();
  const result: {
    before: Message[];
    target: Message | null;
    after: Message[];
  } = { before: [], target: null, after: [] };

  try {
    const targetStmt = db.prepare(`${MSG_SELECT} WHERE m.id = ?`);
    const targetRow = targetStmt.get(messageId) as any | undefined;

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeStmt = db.prepare(`${MSG_SELECT} WHERE m.chat_jid = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`);
    const beforeRows = beforeStmt.all(
      chatJid,
      targetTimestamp,
      before,
    ) as any[];
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterStmt = db.prepare(`${MSG_SELECT} WHERE m.chat_jid = ? AND m.timestamp > ? ORDER BY m.timestamp ASC LIMIT ?`);
    const afterRows = afterStmt.all(chatJid, targetTimestamp, after) as any[];
    result.after = afterRows.map(rowToMessage);

    return result;
  } catch (error) {
    console.error("Error getting messages around:", error);
    return result;
  }
}

export function searchDbForContacts(
  query: string,
  limit: number = 20
): { jid: string; name: string | null }[] {
  const db = getDb();
  try {
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
    if (!tokens.length) tokens.push(query.toLowerCase());

    const rows = db
      .prepare(
        `SELECT jid,
                COALESCE(name, notify, phone_number, jid) AS display_name,
                LOWER(COALESCE(name, '') || ' ' || COALESCE(notify, '') || ' ' || COALESCE(phone_number, '') || ' ' || jid) AS haystack
         FROM contacts`,
      )
      .all() as { jid: string; display_name: string | null; haystack: string }[];

    return rows
      .map((r) => ({ r, score: tokens.filter((t) => r.haystack.includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ jid: x.r.jid, name: x.r.display_name }));
  } catch (error) {
    console.error("Error searching contacts:", error);
    return [];
  }
}

export function searchMessages(
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    let sql = `${MSG_SELECT} WHERE LOWER(m.content) LIKE LOWER(?)`;
    const params: (string | number | null)[] = [searchPattern];

    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(chatJid);
    }

    sql += ` ORDER BY m.timestamp DESC`;
    sql += ` LIMIT ?`;
    params.push(limit);
    sql += ` OFFSET ?`;
    params.push(offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
  }
}

const CHAT_SELECT = `
  SELECT c.jid,
         COALESCE(c.name, ct.name, ct.notify, ct.phone_number) AS name,
         c.last_message_time,
         (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_message,
         (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_sender,
         (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_is_from_me,
         COALESCE(c.name, '') || ' ' || COALESCE(ct.name, '') || ' ' || COALESCE(ct.notify, '') || ' ' || COALESCE(ct.phone_number, '') AS haystack
  FROM chats c
  LEFT JOIN contacts ct ON ct.jid = c.jid
`;

// Accepts a full JID, or a phone number (digits, with country code)
function contactPattern(input: string): string {
  if (input.includes("@")) return input;
  const digits = input.replace(/\D/g, "");
  return digits.length >= 6 ? `%${digits}%` : `%${input}%`;
}

// export function getDirectChatByContact(query: string): Chat | null {
//   const db = getDb();
//   try {
//     const byNumber = contactPattern(query);
//     const byName = `%${query}%`;
//     const row = db
//       .prepare(
//         `${CHAT_SELECT}
//          WHERE c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE '%@newsletter' AND c.jid != 'status@broadcast'
//            AND (c.jid LIKE ?
//                 OR LOWER(COALESCE(c.name, '')) LIKE LOWER(?)
//                 OR LOWER(COALESCE(ct.name, '')) LIKE LOWER(?)
//                 OR LOWER(COALESCE(ct.notify, '')) LIKE LOWER(?)
//                 OR COALESCE(ct.phone_number, '') LIKE ?)
//          ORDER BY c.last_message_time DESC NULLS LAST
//          LIMIT 1`,
//       )
//       .get(byNumber, byName, byName, byName, byNumber) as any | undefined;
//     return row ? rowToChat(row) : null;
//   } catch (error) {
//     console.error("Error in getDirectChatByContact:", error);
//     return null;
//   }
// }

export function findDirectChats(query: string, limit: number = 5): Chat[] {
  const db = getDb();
  try {
    const digits = query.replace(/\D/g, "");
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
    const rows = db
      .prepare(
        `${CHAT_SELECT}
         WHERE c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE '%@newsletter' AND c.jid != 'status@broadcast'`,
      )
      .all() as any[];

    return rows
      .map((r) => {
        const hay = String(r.haystack ?? "").toLowerCase();
        let score = digits.length >= 6 && String(r.jid).includes(digits) ? 10 : 0;
        for (const t of tokens) if (hay.includes(t)) score += 1;
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(b.r.last_message_time ?? "").localeCompare(String(a.r.last_message_time ?? "")),
      )
      .slice(0, limit)
      .map((x) => rowToChat(x.r));
  } catch (error) {
    console.error("Error in findDirectChats:", error);
    return [];
  }
}

export function getContactChats(contact: string, limit: number = 20, page: number = 0): Chat[] {
  const db = getDb();
  try {
    const like = contactPattern(contact);
    const rows = db
      .prepare(
        `${CHAT_SELECT}
         WHERE c.jid LIKE ?
            OR c.jid IN (SELECT DISTINCT m.chat_jid FROM messages m WHERE m.sender LIKE ?)
         ORDER BY c.last_message_time DESC NULLS LAST
         LIMIT ? OFFSET ?`,
      )
      .all(like, like, limit, page * limit) as any[];
    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error in getContactChats:", error);
    return [];
  }
}

export function getLastInteraction(contact: string): Message | null {
  const db = getDb();
  try {
    const like = contactPattern(contact);
    const row = db
      .prepare(`${MSG_SELECT} WHERE m.chat_jid LIKE ? OR m.sender LIKE ? ORDER BY m.timestamp DESC LIMIT 1`)
      .get(like, like) as any | undefined;
    return row ? rowToMessage(row) : null;
  } catch (error) {
    console.error("Error in getLastInteraction:", error);
    return null;
  }
}

export function listMessagesFiltered(f: MessageFilters): Message[] {
  const db = getDb();
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.chatJid) { where.push("m.chat_jid = ?"); params.push(f.chatJid); }
    if (f.chatName) {
      const tokens = f.chatName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
      if (!tokens.length) tokens.push(f.chatName.toLowerCase());
      for (const t of tokens) {
        where.push(`LOWER(COALESCE(c.name,'') || ' ' || COALESCE(cc.name,'') || ' ' || COALESCE(cc.notify,'')) LIKE ?`);
        params.push(`%${t}%`);
      }
    }
    if (f.senderJid) { where.push("m.sender LIKE ?"); params.push(contactPattern(f.senderJid)); }
    if (f.query) { where.push("LOWER(m.content) LIKE LOWER(?)"); params.push(`%${f.query}%`); }
    if (f.after) { where.push("m.timestamp > ?"); params.push(f.after); }
    if (f.before) { where.push("m.timestamp < ?"); params.push(f.before); }
    if (f.mediaType) { where.push("mr.media_type = ?"); params.push(f.mediaType); }
    const limit = f.limit ?? 20;
    const offset = (f.page ?? 0) * limit;
    const sql = `${MSG_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (db.prepare(sql).all(...params) as any[]).map(rowToMessage);
  } catch (error) {
    console.error("Error in listMessagesFiltered:", error);
    return [];
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      dbInstance = null;
      console.log("Database connection closed.");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone_number)
      VALUES (@jid, @name, @notify, @phone_number)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        notify = COALESCE(excluded.notify, notify),
        phone_number = COALESCE(excluded.phone_number, phone_number)
    `);

    stmt.run({
      jid: contact.jid,
      name: contact.name ?? null,
      notify: contact.notify ?? null,
      phone_number: contact.phoneNumber ?? null,
    });
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}

export function storeMediaRaw(m: MediaRow): void {
  const db = getDb();
  try {
    db.prepare(
      `INSERT OR REPLACE INTO media_raw (message_id, chat_jid, media_type, filename, mimetype, file_length, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.message_id, m.chat_jid, m.media_type, m.filename, m.mimetype, m.file_length, m.raw);
  } catch (error) {
    console.error("Error storing media:", error);
  }
}

export function getMediaRaw(messageId: string, chatJid?: string | null): MediaRow | null {
  const db = getDb();
  try {
    const row = chatJid
      ? db.prepare(`SELECT * FROM media_raw WHERE message_id = ? AND chat_jid = ?`).get(messageId, chatJid)
      : db.prepare(`SELECT * FROM media_raw WHERE message_id = ? LIMIT 1`).get(messageId);
    return (row as MediaRow | undefined) ?? null;
  } catch (error) {
    console.error("Error reading media:", error);
    return null;
  }
}