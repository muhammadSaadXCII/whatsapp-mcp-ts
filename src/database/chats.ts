import { contactPattern } from "./contacts.ts";
import { getDb, parseDateSafe, toIsoOrNull } from "./client.ts";

export interface Chat {
    jid: string;
    name?: string | null;
    last_message_time?: Date | null;
    last_message?: string | null;
    last_sender?: string | null;
    last_is_from_me?: boolean | null;
}

const CHAT_SELECT = `
  SELECT c.jid,
         COALESCE(c.name, ct.name, ct.notify, ct.phone_number) AS name,
         c.last_message_time,
         (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_message,
         (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_sender,
         (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_is_from_me,
         COALESCE(c.name, '') || ' ' || COALESCE(ct.name, '') || ' ' || COALESCE(ct.notify, '') || ' ' || COALESCE(ct.phone_number, '') AS haystack,
         ct.phone_number AS phone_number
  FROM chats c
  LEFT JOIN contacts ct ON ct.jid = c.jid
`;

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

        const where: string[] = [
            "(c.jid LIKE '%@g.us' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.chat_jid = c.jid))",
        ];
        if (query) {
            where.push("(LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)");
            params.push(`%${query}%`, `%${query}%`);
        }
        sql += ` WHERE ${where.join(" AND ")}`;

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

export function findDirectChats(query: string, limit: number = 5): Chat[] {
    const db = getDb();
    try {
        const digits = query.replace(/\D/g, "");
        const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
        const rows = db
            .prepare(
                `${CHAT_SELECT}
 WHERE c.jid NOT LIKE '%@g.us'
   AND c.jid NOT LIKE '%@newsletter'
   AND c.jid != 'status@broadcast'
   AND (c.jid NOT LIKE '%@lid' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.chat_jid = c.jid))`,
            )
            .all() as any[];

        const isLid = (jid: unknown) => String(jid).endsWith("@lid");
        const canonical = (r: any) =>
            isLid(r.jid) && r.phone_number ? `${r.phone_number}@s.whatsapp.net` : String(r.jid);

        const scored = rows
            .map((r) => {
                const hay = String(r.haystack ?? "").toLowerCase();
                const words = new Set(hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
                let score = digits.length >= 6 && String(r.jid).includes(digits) ? 10 : 0;
                for (const t of tokens) {
                    if (hay.includes(t)) score += 1;
                    if (words.has(t)) score += 2;
                }
                return { r, score };
            })
            .filter((x) => x.score > 0);

        const better = (a: { r: any }, b: { r: any }) => {
            const ta = String(a.r.last_message_time ?? "");
            const tb = String(b.r.last_message_time ?? "");
            if (ta !== tb) return ta > tb ? a : b;
            return isLid(a.r.jid) ? b : a;
        };

        const merged = new Map<string, { r: any; score: number }>();
        for (const x of scored) {
            const key = canonical(x.r);
            const cur = merged.get(key);
            if (!cur) {
                merged.set(key, x);
                continue;
            }
            merged.set(key, { r: better(cur, x).r, score: Math.max(cur.score, x.score) });
        }

        return [...merged.values()]
            .sort(
                (a, b) =>
                    b.score - a.score ||
                    Number(!isLid(b.r.jid)) - Number(!isLid(a.r.jid)) ||
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

export function resolveSendJid(jid: string): string {
    if (!jid.endsWith("@lid")) return jid;
    const db = getDb();
    try {
        const row = db.prepare("SELECT phone_number FROM contacts WHERE jid = ?").get(jid) as
            { phone_number?: string | null } | undefined;
        return row?.phone_number ? `${row.phone_number}@s.whatsapp.net` : jid;
    } catch {
        return jid;
    }
}

export function chatExists(jid: string): boolean {
    const db = getDb();
    try {
        const resolved = resolveSendJid(jid);
        if (db.prepare("SELECT 1 FROM chats WHERE jid IN (?, ?)").get(jid, resolved)) return true;

        const phone = resolved.endsWith("@s.whatsapp.net") ? resolved.split("@")[0] : null;
        if (!phone) return false;
        return !!db
            .prepare(
                `SELECT 1 FROM chats c JOIN contacts ct ON ct.jid = c.jid
                 WHERE c.jid LIKE '%@lid' AND ct.phone_number = ?`,
            )
            .get(phone);
    } catch {
        return false;
    }
}