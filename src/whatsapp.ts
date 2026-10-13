import fs from 'fs';
import P from "pino";
import path from "path";
import open from "open";
import {
  storeChat,
  getMediaRaw,
  storeContact,
  storeMessage,
  storeMediaRaw,
  initializeDatabase,
  type Message as DbMessage
} from "./database.ts";
import {
  proto,
  isJidGroup,
  makeWASocket,
  type WAMessage,
  DisconnectReason,
  jidNormalizedUser,
  downloadMediaMessage,
  useMultiFileAuthState,
  normalizeMessageContent,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }
  if (msg.key.remoteJid === "status@broadcast") return null;

  // Extract normalized message into a local constant
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

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
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
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          { qrCodeData: qr },
          "QR Code Received. Copy the qrCodeData string and use a QR code generator (e.g., online website) to display and scan it with your WhatsApp app."
        );
        // for now we roughly open the QR code in a browser
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
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
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
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}

const DOWNLOAD_DIR = path.join(import.meta.dirname, "..", "downloads");
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "application/pdf": "pdf",
};

export async function downloadWhatsAppMedia(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  messageId: string,
  chatJid?: string | null,
): Promise<
  | { file_path: string; media_type: string | null; mimetype: string | null; size_bytes: number }
  | { error: string }
> {
  if (!sock) return { error: "WhatsApp connection is not active." };

  const row = getMediaRaw(messageId, chatJid);
  if (!row) {
    return {
      error:
        "No stored media data for this message. Only images, videos, audio, documents and stickers received after this feature was added can be downloaded.",
    };
  }
  if (row.file_length && row.file_length > MAX_DOWNLOAD_BYTES) {
    return {
      error: `File is too large (${Math.round(row.file_length / 1048576)} MB; the limit is ${MAX_DOWNLOAD_BYTES / 1048576} MB).`,
    };
  }

  try {
    const msg = proto.WebMessageInfo.decode(Buffer.from(row.raw, "base64")) as WAMessage;
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    )) as Buffer;

    const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, "_");
    let fileName: string;
    if (row.filename) {
      const base = path.basename(row.filename).replace(/[^A-Za-z0-9._ -]/g, "_").slice(-80);
      fileName = `${row.media_type}_${safeId}_${base}`;
    } else {
      const mime = (row.mimetype ?? "").split(";")[0].trim().toLowerCase();
      fileName = `${row.media_type}_${safeId}.${MIME_EXT[mime] ?? "bin"}`;
    }

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const fullPath = path.join(DOWNLOAD_DIR, fileName);
    fs.writeFileSync(fullPath, buffer);
    logger.info({ messageId, fullPath, bytes: buffer.length }, "Media downloaded");

    return { file_path: fullPath, media_type: row.media_type, mimetype: row.mimetype, size_bytes: buffer.length };
  } catch (error: any) {
    logger.error({ err: error, messageId }, "Failed to download media");
    const hint = /media key/i.test(String(error?.message))
      ? "This message has no encryption key, which is typical for channel (newsletter) posts, so it cannot be downloaded this way."
      : "The media may have expired on WhatsApp's servers, or your phone may need to be online to re-upload it.";
    return { error: `Download failed: ${error.message}. ${hint}` };
  }
}

const OUTBOX_DIR = path.join(import.meta.dirname, "..", "outbox");
const MAX_SEND_BYTES = 25 * 1024 * 1024;

const SEND_TYPES: Record<string, { kind: "image" | "video" | "audio" | "document"; mime: string }> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  mp4: { kind: "video", mime: "video/mp4" },
  "3gp": { kind: "video", mime: "video/3gpp" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  wav: { kind: "audio", mime: "audio/wav" },
  pdf: { kind: "document", mime: "application/pdf" },
  txt: { kind: "document", mime: "text/plain" },
  csv: { kind: "document", mime: "text/csv" },
  doc: { kind: "document", mime: "application/msword" },
  docx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { kind: "document", mime: "application/vnd.ms-excel" },
  xlsx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ppt: { kind: "document", mime: "application/vnd.ms-powerpoint" },
  pptx: { kind: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  zip: { kind: "document", mime: "application/zip" },
};

export function listOutbox(): { file_name: string; size_bytes: number; sendable: boolean }[] {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  return fs
    .readdirSync(OUTBOX_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const size = fs.statSync(path.join(OUTBOX_DIR, e.name)).size;
      return { file_name: e.name, size_bytes: size, sendable: !!SEND_TYPES[ext] && size > 0 && size <= MAX_SEND_BYTES };
    });
}

export async function sendWhatsAppFile(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  fileName: string,
  caption?: string | null,
  asDocument: boolean = false,
): Promise<
  | { message_id: string | null | undefined; file_name: string; sent_as: string; size_bytes: number }
  | { error: string }
> {
  if (!sock || !sock.user) return { error: "WhatsApp connection is not active." };

  if (recipientJid.endsWith("@newsletter") || recipientJid.endsWith("@broadcast")) {
    return { error: "Files cannot be sent to channels or broadcast lists." };
  }

  // 1. A bare file name only: no folders, no path tricks
  if (!fileName || fileName !== path.basename(fileName) || /[\\/:]/.test(fileName) || fileName.includes("..")) {
    return { error: "file_name must be just a file name inside the outbox folder, with no folders or path segments." };
  }

  // 2. Allowed types only
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const type = SEND_TYPES[ext];
  if (!type) {
    return { error: `File type ".${ext}" is not allowed. Allowed types: ${Object.keys(SEND_TYPES).join(", ")}.` };
  }

  // 3. The real path (after resolving links) must stay inside the outbox
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const outboxReal = fs.realpathSync(OUTBOX_DIR);
  let real: string;
  try {
    real = fs.realpathSync(path.join(outboxReal, fileName));
  } catch {
    return { error: `File "${fileName}" was not found in the outbox folder.` };
  }
  const rel = path.relative(outboxReal, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: "File is not inside the outbox folder." };
  }

  const st = fs.statSync(real);
  if (!st.isFile()) return { error: "Not a regular file." };
  if (st.size === 0) return { error: "File is empty." };
  if (st.size > MAX_SEND_BYTES) {
    return { error: `File is too large (${Math.round(st.size / 1048576)} MB; the limit is ${MAX_SEND_BYTES / 1048576} MB).` };
  }

  try {
    const buffer = fs.readFileSync(real);
    const jid = jidNormalizedUser(recipientJid);
    const kind = asDocument ? "document" : type.kind;
    const cap = caption ? caption : undefined;

    let content: any;
    if (kind === "image") content = { image: buffer, mimetype: type.mime, caption: cap };
    else if (kind === "video") content = { video: buffer, mimetype: type.mime, caption: cap };
    else if (kind === "audio") content = { audio: buffer, mimetype: type.mime, ptt: false };
    else content = { document: buffer, mimetype: type.mime, fileName, caption: cap };

    logger.info({ jid, fileName, kind, bytes: st.size }, "Sending file");
    const result = await sock.sendMessage(jid, content);
    logger.info({ msgId: result?.key.id }, "File sent");
    return { message_id: result?.key.id, file_name: fileName, sent_as: kind, size_bytes: st.size };
  } catch (error: any) {
    logger.error({ err: error, fileName }, "Failed to send file");
    return { error: `Failed to send file: ${error.message}` };
  }
}