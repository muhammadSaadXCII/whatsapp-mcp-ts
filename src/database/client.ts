import fs from 'node:fs';
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(import.meta.dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

let dbInstance: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
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
    db.exec("PRAGMA busy_timeout = 20000");
    db.exec("PRAGMA synchronous = NORMAL");

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

    db.exec(`
        CREATE TABLE IF NOT EXISTS sent_raw (
            message_id TEXT NOT NULL,
            chat_jid TEXT NOT NULL,
            raw TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (message_id, chat_jid)
        );
    `);

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS sync_chat_name_on_contact_insert
        AFTER INSERT ON contacts
        BEGIN
            UPDATE chats 
            SET name = NEW.name 
            WHERE chats.jid = NEW.jid AND NEW.name IS NOT NULL;
        END;
    `);

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS sync_chat_name_on_contact_update
        AFTER UPDATE OF name ON contacts
        BEGIN
            UPDATE chats 
            SET name = NEW.name 
            WHERE chats.jid = NEW.jid AND NEW.name IS NOT NULL;
        END;
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

export function parseDateSafe(dateString: string | null | undefined): Date | null {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    } catch (e) {
        return null;
    }
}

export function toIsoOrNull(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    const s = String(v);
    return s === "" || s === "undefined" || s === "null" ? null : s;
}