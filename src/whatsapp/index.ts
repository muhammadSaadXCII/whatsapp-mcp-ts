import P from "pino";
import open from "open";
import path from "node:path";
import { storeChat } from "../database/chats.ts";
import { storeMediaRaw } from "../database/media.ts";
import { storeContact } from "../database/contacts.ts";
import { rememberSent } from "../database/sent.ts";
import { getDb, initializeDatabase } from "../database/client.ts";
import { storeMessage, type Message as DbMessage } from "../database/messages.ts";
import {
    proto,
    Browsers,
    isJidGroup,
    makeWASocket,
    type WAMessage,
    DisconnectReason,
    jidNormalizedUser,
    useMultiFileAuthState,
    normalizeMessageContent,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";

const AUTH_DIR = path.join(import.meta.dirname, "..", "..", "auth_info");
export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

let currentSock: WhatsAppSocket | null = null;
export const getSock = () => currentSock;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
    if (!msg.message || !msg.key || !msg.key.remoteJid) {
        return null;
    }
    if (msg.key.remoteJid === "status@broadcast") return null;

    const messageContent = normalizeMessageContent(msg.message) ?? msg.message;
    if (!messageContent) {
        return null;
    }

    let content: string | null = null;

    if (messageContent.conversation) {
        content = messageContent.conversation;
    } else if (messageContent.extendedTextMessage?.text) {
        content = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
        const cap = messageContent.imageMessage.caption;
        content = cap ? `[Image] ${cap}` : "[Image]";
    } else if (messageContent.videoMessage) {
        const cap = messageContent.videoMessage.caption;
        content = cap ? `[Video] ${cap}` : "[Video]";
    } else if (messageContent.documentMessage) {
        const d = messageContent.documentMessage;
        content = `[Document] ${d.caption || d.fileName || ""}`.trim();
    } else if (messageContent.audioMessage) {
        content = `[Audio]`;
    } else if (messageContent.stickerMessage) {
        content = `[Sticker]`;
    } else if (messageContent.locationMessage?.address) {
        content = `[Location] ${messageContent.locationMessage.address}`;
    } else if (messageContent.contactMessage?.displayName) {
        content = `[Contact] ${messageContent.contactMessage.displayName}`;
    } else if (messageContent.pollCreationMessage?.name) {
        content = `[Poll] ${messageContent.pollCreationMessage.name}`;
    }

    if (!content) {
        return null;
    }

    let timestampSeconds: number;
    if (msg.messageTimestamp != null) {
        timestampSeconds = Number(msg.messageTimestamp);
    } else {
        timestampSeconds = Date.now() / 1000;
    }

    const timestamp = new Date(timestampSeconds * 1000);

    let senderJid: string | null | undefined = msg.key.participant ?? msg.participant;
    if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
        senderJid = msg.key.remoteJid;
    }
    if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
        senderJid = null;
    }

    return {
        id: msg.key.id!,
        chat_jid: msg.key.remoteJid,
        sender: senderJid ? jidNormalizedUser(senderJid) : null,
        content: content,
        timestamp: timestamp,
        is_from_me: msg.key.fromMe ?? false,
    };
}

function rememberPushName(msg: WAMessage, parsed: DbMessage) {
    if (!msg.pushName || parsed.is_from_me) return;
    const who = parsed.sender ?? parsed.chat_jid;
    if (who.endsWith("@g.us") || who.endsWith("@newsletter")) return;
    storeContact({ jid: who, notify: msg.pushName });
}

function getMediaInfo(msg: WAMessage) {
    const m = normalizeMessageContent(msg.message) ?? msg.message;
    if (!m) return null;
    const pick = (type: string, n: any) => ({
        type,
        mimetype: (n.mimetype ?? null) as string | null,
        filename: (n.fileName ?? null) as string | null,
        length: Number(n.fileLength ?? 0),
    });
    if (m.imageMessage) return pick("image", m.imageMessage);
    if (m.videoMessage) return pick("video", m.videoMessage);
    if (m.audioMessage) return pick("audio", m.audioMessage);
    if (m.documentMessage) return pick("document", m.documentMessage);
    if (m.stickerMessage) return pick("sticker", m.stickerMessage);
    return null;
}

function rememberMedia(msg: WAMessage, parsed: DbMessage) {
    const info = getMediaInfo(msg);
    if (!info) return;
    try {
        const bytes = proto.WebMessageInfo.encode(msg).finish();
        storeMediaRaw({
            message_id: parsed.id,
            chat_jid: parsed.chat_jid,
            media_type: info.type,
            filename: info.filename,
            mimetype: info.mimetype,
            file_length: info.length,
            raw: Buffer.from(bytes).toString("base64"),
        });
    } catch (error) {
        console.error("Error remembering media:", error);
    }
}

let reconnectAttempts = 0;
export async function startWhatsAppConnection(
    logger: P.Logger
): Promise<WhatsAppSocket> {
    initializeDatabase();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        browser: Browsers.ubuntu("Desktop"),
        syncFullHistory: true,
    });
    currentSock = sock;

    sock.ev.process(async (events) => {
        if (events["connection.update"]) {
            const update = events["connection.update"];
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info(
                    { qrCodeData: qr },
                    "QR Code Received. Copy the qrCodeData string and use a QR code generator (e.g., online website) to display and scan it with your WhatsApp app."
                );

                await open(`https://quickchart.io/qr?text=${encodeURIComponent(qr)}`);
            }

            if (connection === "close") {
                const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
                logger.warn(
                    `Connection closed. Reason: ${DisconnectReason[statusCode as number] || "Unknown"
                    }`,
                    lastDisconnect?.error
                );
                if (statusCode !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    if (reconnectAttempts > 5) {
                        logger.error("Too many failed reconnects, giving up. Check network/config and restart.");
                        process.exit(1);
                    }
                    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
                    logger.info(`Reconnecting in ${delay} ms (attempt ${reconnectAttempts})...`);
                    setTimeout(() => {
                        startWhatsAppConnection(logger).catch((err) =>
                            logger.error({ err }, "Reconnect failed"));
                    }, delay);
                } else {
                    logger.error(
                        "Connection closed: Logged Out. Please delete auth_info and restart."
                    );
                    process.exit(1);
                }
            } else if (connection === "open") {
                logger.info(`Connection opened. WA user: ${sock.user?.name}`);
                reconnectAttempts = 0;
                storeSelfContact(sock);
            }
        }

        if (events["creds.update"]) {
            await saveCreds();
            logger.info("Credentials saved.");
        }

        if (events["messaging-history.set"]) {
            const { chats, contacts, messages } = events["messaging-history.set"];
            const db = getDb();

            try {
                db.exec("BEGIN");

                if (contacts.length > 0) {
                    logger.info(`Storing ${contacts.length} contacts from history sync.`);
                    contacts.forEach((c) => {
                        const base = { name: c.name ?? null, notify: c.notify ?? null, phoneNumber: (c as any).phoneNumber ?? null };
                        storeContact({ jid: c.id, ...base });
                        const lid = (c as any).lid;
                        if (lid && lid !== c.id) storeContact({ jid: lid, ...base });
                    });
                    logger.info(`Stored ${contacts.length} contacts from history sync.`);
                }

                logger.info(`Storing ${chats.length} chats from history sync.`);
                chats.forEach((chat) =>
                    storeChat({
                        jid: chat.id,
                        name: chat.name,
                        last_message_time: chat.conversationTimestamp
                            ? new Date(Number(chat.conversationTimestamp) * 1000)
                            : undefined,
                    })
                );

                let storedCount = 0;
                messages.forEach((msg) => {
                    const parsed = parseMessageForDb(msg);
                    if (parsed) {
                        storeMessage(parsed);
                        rememberPushName(msg, parsed);
                        rememberMedia(msg, parsed);
                        storedCount++;
                    }
                });
                logger.info(`Stored ${storedCount} messages from history sync.`);

                db.exec("COMMIT");
            } catch (err) {
                db.exec("ROLLBACK");
                logger.error({ err }, "Failed to process history sync transaction");
            }
        }

        if (events["contacts.upsert"]) {
            for (const c of events["contacts.upsert"]) {
                storeContact({
                    jid: c.id,
                    name: c.name ?? null,
                    notify: c.notify ?? null,
                    phoneNumber: (c as any).phoneNumber ?? null,
                });
            }
        }

        if (events["contacts.update"]) {
            for (const c of events["contacts.update"]) {
                storeContact({
                    jid: c.id!,
                    name: c.name ?? null,
                    notify: (c as any).notify ?? null,
                });
            }
        }

        if (events["messages.upsert"]) {
            const { messages, type } = events["messages.upsert"];
            logger.info(
                { type, count: messages.length },
                "Received messages.upsert event"
            );

            if (type === "notify" || type === "append") {
                for (const msg of messages) {
                    const parsed = parseMessageForDb(msg);
                    if (parsed) {
                        logger.info(
                            {
                                msgId: parsed.id,
                                chatId: parsed.chat_jid,
                                fromMe: parsed.is_from_me,
                                sender: parsed.sender,
                            },
                            `Storing message: ${parsed.content.substring(0, 50)}...`
                        );
                        storeMessage(parsed);
                        rememberPushName(msg, parsed);
                        rememberMedia(msg, parsed);
                    } else {
                        logger.warn(
                            { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
                            "Skipped storing message (parsing failed or unsupported type)"
                        );
                    }
                }
            }
        }

        if (events["chats.update"]) {
            logger.info(
                { count: events["chats.update"].length },
                "Received chats.update event"
            );
            for (const chatUpdate of events["chats.update"]) {
                storeChat({
                    jid: chatUpdate.id!,
                    name: chatUpdate.name,
                    last_message_time: chatUpdate.conversationTimestamp
                        ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
                        : undefined,
                });
            }
        }
    });

    return sock;
}

export async function sendWhatsAppMessage(
    logger: P.Logger,
    sock: WhatsAppSocket | null,
    recipientJid: string,
    text: string
): Promise<proto.WebMessageInfo | void> {
    if (!sock || !sock.user) {
        logger.error(
            "Cannot send message: WhatsApp socket not connected or initialized."
        );
        return;
    }
    if (!recipientJid) {
        logger.error("Cannot send message: Recipient JID is missing.");
        return;
    }
    if (!text) {
        logger.error("Cannot send message: Message text is empty.");
        return;
    }

    try {
        logger.info(
            `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
        );
        const normalizedJid = jidNormalizedUser(recipientJid);
        const result = await sock.sendMessage(normalizedJid, { text: text });
        rememberSent(result);
        logger.info({ msgId: result?.key.id }, "Message sent successfully");
        return result;
    } catch (error) {
        logger.error({ err: error, recipientJid }, "Failed to send message");
        return;
    }
}

function storeSelfContact(sock: WhatsAppSocket | null,) {
    if (!sock || !sock.user) return { error: "WhatsApp connection is not active." };

    const me = sock.user;
    if (me?.id) {
        const myJid = jidNormalizedUser(me.id);
        const myNumber = myJid.split("@")[0];
        storeContact({ jid: myJid, name: "Me", phoneNumber: myNumber });

        const myLid = (me as any).lid;
        if (myLid) {
            storeContact({ jid: jidNormalizedUser(myLid), name: "Me", phoneNumber: myNumber });
        }
    }
}

export { sendWhatsAppFile, sendWhatsAppVoiceNote, sendWhatsAppSpokenMessage, listOutbox, downloadWhatsAppMedia } from "./files.ts";