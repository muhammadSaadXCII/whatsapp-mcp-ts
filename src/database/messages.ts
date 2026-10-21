import { storeChat } from "./chats.ts";
import { contactPattern } from "./contacts.ts";
import { getDb, parseDateSafe } from "./client.ts";

export interface Message {
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

interface MessageFilters {
    chatJid?: string | null;
    chatName?: string | null;
    senderJid?: string | null;
    query?: string | null;
    after?: string | null;
    before?: string | null;
    limit?: number;
    page?: number;
    mediaType?: string | null;
};

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