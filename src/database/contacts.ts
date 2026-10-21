import { getDb } from "./client.ts";

export function contactPattern(input: string): string {
    if (input.includes("@")) return input;
    const digits = input.replace(/\D/g, "");
    return digits.length >= 6 ? `%${digits}%` : `%${input}%`;
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
                `SELECT jid, phone_number,
                COALESCE(name, notify, phone_number, jid) AS display_name,
                LOWER(COALESCE(name, '') || ' ' || COALESCE(notify, '') || ' ' || COALESCE(phone_number, '') || ' ' || jid) AS haystack
         FROM contacts`,
            )
            .all() as { jid: string; phone_number: string | null; display_name: string | null; haystack: string }[];

        const merged = new Map<string, { jid: string; name: string | null; score: number }>();
        for (const r of rows) {
            const score = tokens.filter((t) => r.haystack.includes(t)).length;
            if (!score) continue;
            const jid = r.jid.endsWith("@lid") && r.phone_number ? `${r.phone_number}@s.whatsapp.net` : r.jid;
            const cur = merged.get(jid);
            if (!cur || score > cur.score) merged.set(jid, { jid, name: r.display_name, score });
        }

        return [...merged.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ jid, name }) => ({ jid, name }));
    } catch (error) {
        console.error("Error searching contacts:", error);
        return [];
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