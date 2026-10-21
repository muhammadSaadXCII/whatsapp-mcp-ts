import { getDb } from "./client.ts";
import { proto, type WAMessage } from "@whiskeysockets/baileys";

export function rememberSent(msg: WAMessage | void | undefined): void {
    if (!msg || !msg.key?.id || !msg.key.remoteJid || !msg.message) return;
    try {
        const db = getDb();
        const raw = Buffer.from(proto.Message.encode(msg.message).finish()).toString("base64");
        db.prepare(
            `INSERT OR REPLACE INTO sent_raw (message_id, chat_jid, raw, created_at) VALUES (?, ?, ?, ?)`,
        ).run(msg.key.id, msg.key.remoteJid, raw, new Date().toISOString());
        db.prepare(`DELETE FROM sent_raw WHERE created_at < ?`).run(
            new Date(Date.now() - 7 * 86400_000).toISOString(),
        );
    } catch (error) {
        console.error("Error remembering sent message:", error);
    }
}