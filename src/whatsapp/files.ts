import P from "pino";
import fs from 'node:fs';
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import { execFile } from "node:child_process";
import type { WhatsAppSocket } from "./index.ts"
import { rememberSent } from "../database/sent.ts";
import { getMediaRaw } from "../database/media.ts";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { proto, type WAMessage, jidNormalizedUser, downloadMediaMessage, } from "@whiskeysockets/baileys";

const DOWNLOAD_DIR = path.join(import.meta.dirname, "..", "..", "downloads");
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/3gpp": "3gp",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
    "application/pdf": "pdf",
};

const OUTBOX_DIR = path.join(import.meta.dirname, "..", "..", "outbox");
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
    opus: { kind: "audio", mime: "audio/opus" },
    amr: { kind: "audio", mime: "audio/amr" },
    flac: { kind: "audio", mime: "audio/flac" },
    webm: { kind: "audio", mime: "audio/webm" },
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
    js: { kind: "document", mime: "text/javascript" },
    ts: { kind: "document", mime: "application/typescript" },
    py: { kind: "document", mime: "text/x-python" },
    json: { kind: "document", mime: "application/json" },
    html: { kind: "document", mime: "text/html" },
    css: { kind: "document", mime: "text/css" },
    c: { kind: "document", mime: "text/x-c" },
    cpp: { kind: "document", mime: "text/x-c++src" },
    java: { kind: "document", mime: "text/x-java-source" },
    go: { kind: "document", mime: "text/plain" },
    rs: { kind: "document", mime: "text/plain" },
    sh: { kind: "document", mime: "application/x-sh" },
};

const VOICE_EXTS = new Set(["ogg", "opus", "mp3", "m4a", "aac", "wav", "amr", "flac", "webm"]);
const MAX_TTS_CHARS = 1500;

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

    if (!fileName || fileName !== path.basename(fileName) || /[\\/:]/.test(fileName) || fileName.includes("..")) {
        return { error: "file_name must be just a file name inside the outbox folder, with no folders or path segments." };
    }

    const ext = path.extname(fileName).slice(1).toLowerCase();
    const type = SEND_TYPES[ext];
    if (!type) {
        return { error: `File type ".${ext}" is not allowed. Allowed types: ${Object.keys(SEND_TYPES).join(", ")}.` };
    }

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
        rememberSent(result);
        logger.info({ msgId: result?.key.id }, "File sent");
        return { message_id: result?.key.id, file_name: fileName, sent_as: kind, size_bytes: st.size };
    } catch (error: any) {
        logger.error({ err: error, fileName }, "Failed to send file");
        return { error: `Failed to send file: ${error.message}` };
    }
}

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

function isOggOpus(buf: Buffer): boolean {
    return buf.subarray(0, 4).toString("latin1") === "OggS" && buf.subarray(0, 200).includes("OpusHead");
}

const ffmpegPath = ffmpegStatic as unknown as string | null;
function convertToOggOpus(inputPath: string): Promise<Buffer> {
    const out = path.join(os.tmpdir(), `wa_voice_${randomUUID()}.ogg`);
    return new Promise<void>((resolve, reject) => {
        execFile(
            ffmpegPath ?? "ffmpeg",
            [
                "-y", "-i", inputPath, "-vn", "-map_metadata", "-1",
                "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
                "-application", "voip", out,
            ],
            { timeout: 60_000, encoding: "utf8" },
            (err: Error | null, _stdout: string, stderr: string) => {
                if (!err) return resolve();
                if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("FFMPEG_MISSING"));
                reject(new Error(String(stderr).slice(-300) || err.message));
            },
        );
    }).then(() => {
        try {
            return fs.readFileSync(out);
        } finally {
            fs.rmSync(out, { force: true });
        }
    });
}

async function synthesizeSpeech(text: string, voice: string, outMp3: string): Promise<void> {
    const TIMEOUT_MS = 20000;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa_tts_"));
    const tts = new MsEdgeTTS();
    let timer: NodeJS.Timeout | undefined;
    try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`TTS timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
        });
        const { audioFilePath } = await Promise.race([tts.toFile(workDir, text), timeout]);
        const size = fs.statSync(audioFilePath).size;
        if (!size) throw new Error("TTS returned empty audio");
        fs.copyFileSync(audioFilePath, outMp3);
    } catch (error: any) {
        throw new Error(`Speech generation failed: ${error?.message ?? error}`);
    } finally {
        if (timer) clearTimeout(timer);
        try { (tts as any).close?.(); } catch { }
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

export async function sendWhatsAppVoiceNote(
    logger: P.Logger,
    sock: WhatsAppSocket | null,
    recipientJid: string,
    fileName: string,
): Promise<
    | { message_id: string | null | undefined; file_name: string; converted: boolean; size_bytes: number }
    | { error: string }
> {
    if (!sock || !sock.user) return { error: "WhatsApp connection is not active." };

    if (recipientJid.endsWith("@newsletter") || recipientJid.endsWith("@broadcast")) {
        return { error: "Voice notes cannot be sent to channels or broadcast lists." };
    }

    if (!fileName || fileName !== path.basename(fileName) || /[\\/:]/.test(fileName) || fileName.includes("..")) {
        return { error: "file_name must be just a file name inside the outbox folder, with no folders or path segments." };
    }
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!VOICE_EXTS.has(ext)) {
        return { error: `".${ext}" is not an audio type I can send as a voice note. Allowed: ${[...VOICE_EXTS].join(", ")}.` };
    }

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
        let buffer: Buffer = fs.readFileSync(real);
        let converted = false;
        if (!isOggOpus(buffer)) {
            try {
                buffer = await convertToOggOpus(real);
                converted = true;
            } catch (e: any) {
                if (e.message === "FFMPEG_MISSING") {
                    return { error: "ffmpeg binary was not found. Run: npm install ffmpeg-static" };
                }
                return { error: `ffmpeg conversion failed: ${e.message}` };
            }
        }

        const jid = jidNormalizedUser(recipientJid);
        logger.info({ jid, fileName, converted, bytes: buffer.length }, "Sending voice note");
        const result = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        });
        rememberSent(result);
        logger.info({ msgId: result?.key.id }, "Voice note sent");
        return { message_id: result?.key.id, file_name: fileName, converted, size_bytes: buffer.length };
    } catch (error: any) {
        logger.error({ err: error, fileName }, "Failed to send voice note");
        return { error: `Failed to send voice note: ${error.message}` };
    }
}

export async function sendWhatsAppSpokenMessage(
    logger: P.Logger,
    sock: WhatsAppSocket | null,
    recipientJid: string,
    text: string,
    voice: string = "en-US-AriaNeural",
): Promise<
    | { message_id: string | null | undefined; voice: string; chars: number; size_bytes: number }
    | { error: string }
> {
    if (!sock || !sock.user) return { error: "WhatsApp connection is not active." };
    if (recipientJid.endsWith("@newsletter") || recipientJid.endsWith("@broadcast")) {
        return { error: "Voice notes cannot be sent to channels or broadcast lists." };
    }
    text = text.trim();
    if (!text) return { error: "Text is empty." };
    if (text.length > MAX_TTS_CHARS) {
        return { error: `Text is too long (${text.length} chars; limit ${MAX_TTS_CHARS}).` };
    }
    if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/.test(voice)) {
        return { error: `Invalid voice "${voice}". Example: en-US-AriaNeural or ur-PK-UzmaNeural.` };
    }

    const mp3 = path.join(os.tmpdir(), `wa_tts_${randomUUID()}.mp3`);
    try {
        try {
            await synthesizeSpeech(text, voice, mp3);
        } catch (e: any) {
            return { error: e.message };
        }

        let buffer: Buffer;
        try {
            buffer = await convertToOggOpus(mp3);
        } catch (e: any) {
            if (e.message === "FFMPEG_MISSING") {
                return { error: "ffmpeg binary was not found. Run: npm install ffmpeg-static" };
            }
            return { error: `ffmpeg conversion failed: ${e.message}` };
        }

        const jid = jidNormalizedUser(recipientJid);
        logger.info({ jid, voice, chars: text.length, bytes: buffer.length }, "Sending spoken message");

        const result = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        });
        rememberSent(result);

        logger.info({ msgId: result?.key.id }, "Spoken message sent");
        return { message_id: result?.key.id, voice, chars: text.length, size_bytes: buffer.length };
    } catch (error: any) {
        logger.error({ err: error }, "Failed to send spoken message");
        return { error: `Failed to send spoken message: ${error.message}` };
    } finally {
        fs.rmSync(mp3, { force: true });
    }
}