import { getDb } from "./client.ts";

interface MediaRow {
    message_id: string;
    chat_jid: string;
    media_type: string | null;
    filename: string | null;
    mimetype: string | null;
    file_length: number | null;
    raw: string;
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