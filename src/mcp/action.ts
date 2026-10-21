import { z } from "zod";
import { type P } from "pino";
import { ok, fail } from "./helper.ts";
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { chatExists, resolveSendJid } from "../database/chats.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendWhatsAppMessage, sendWhatsAppFile, sendWhatsAppVoiceNote, sendWhatsAppSpokenMessage, listOutbox, downloadWhatsAppMedia, type WhatsAppSocket } from "../whatsapp/index.ts";

export function registerActionTools(server: McpServer, getSock: () => WhatsAppSocket | null, mcpLogger: P.Logger, waLogger: P.Logger) {
    server.tool(
        "send_message",
        {
            recipient: z
                .string()
                .describe(
                    "JID of an existing chat, for example '923...@s.whatsapp.net' or 'group@g.us'. If a contact has both an @s.whatsapp.net and an @lid ID, always use the @s.whatsapp.net one.",
                ),
            message: z.string().min(1).describe("The text message to send"),
        },
        async ({ recipient, message }) => {
            const sock = getSock();

            mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
            if (!sock) {
                mcpLogger.error(
                    "[MCP Tool Error] send_message failed: WhatsApp socket is not available.",
                );
                return {
                    isError: true,
                    content: [
                        { type: "text", text: "Error: WhatsApp connection is not active." },
                    ],
                };
            }

            let normalizedRecipient: string;
            try {
                normalizedRecipient = resolveSendJid(jidNormalizedUser(recipient));
                if (!normalizedRecipient.includes("@")) {
                    throw new Error('Bad jid');
                }
            } catch (normError: any) {
                mcpLogger.error(
                    `[MCP Tool Error] Invalid recipient JID format: ${recipient}. Error: ${normError.message}`,
                );
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Invalid recipient format: "${recipient}". Please provide a valid JID (e.g., number@s.whatsapp.net or group@g.us).`,
                        },
                    ],
                };
            }

            if (!chatExists(normalizedRecipient)) {
                return fail("Recipient is not an existing chat. For safety, messages can only be sent to chats that already exist.");
            }

            try {
                const result = await sendWhatsAppMessage(
                    waLogger,
                    sock,
                    normalizedRecipient,
                    message,
                );

                if (result && result.key && result.key.id) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
                            },
                        ],
                    };
                } else {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
                            },
                        ],
                    };
                }
            } catch (error: any) {
                mcpLogger.error(
                    `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
                );
                return {
                    isError: true,
                    content: [
                        { type: "text", text: `Error sending message: ${error.message}` },
                    ],
                };
            }
        },
    );

    server.tool(
        "download_media",
        {
            message_id: z.string().min(1).describe("ID of a message containing an image, video, audio, document or sticker (the 'id' from list_messages or search_messages). Only messages whose media_type is not null can be downloaded."),
            chat_jid: z.string().optional().describe("JID of the chat the message is in (recommended)"),
        },
        async ({ message_id, chat_jid }) => {
            const sock = getSock();

            mcpLogger.info(`[MCP Tool] Executing download_media for message ${message_id}`);
            if (!sock) {
                mcpLogger.error(
                    "[MCP Tool Error] download_media failed: WhatsApp socket is not available.",
                );
                return {
                    isError: true,
                    content: [
                        { type: "text", text: "Error: WhatsApp connection is not active." },
                    ],
                };
            }
            try {
                const result = await downloadWhatsAppMedia(waLogger, sock, message_id, chat_jid);
                return "error" in result ? fail(result.error) : ok({ success: true, ...result });
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] download_media failed: ${error.message}`);
                return fail(`Error downloading media: ${error.message}`);
            }
        },
    );

    server.tool(
        "list_outbox",
        {},
        async () => {
            mcpLogger.info("[MCP Tool] Executing list_outbox");
            try {
                const files = listOutbox();
                return files.length ? ok(files) : ok("The outbox folder is empty. The user must place files there first.");
            } catch (error: any) {
                return fail(`Error: ${error.message}`);
            }
        },
    );

    server.tool(
        "send_file",
        {
            recipient: z.string().min(1).describe("JID of an existing chat, for example '923...@s.whatsapp.net' or 'group@g.us'. If a contact has both an @s.whatsapp.net and an @lid ID, always use the @s.whatsapp.net one."),
            file_name: z.string().min(1).describe("Name of a file in the outbox folder (just the name, no path). Use list_outbox to see available files."),
            caption: z.string().max(1000).optional().describe("Optional caption"),
            as_document: z.boolean().optional().default(false).describe("Send an image or video as an uncompressed document"),
        },
        async ({ recipient, file_name, caption, as_document }) => {
            const sock = getSock();

            mcpLogger.info(`[MCP Tool] Executing send_file to ${recipient}: ${file_name}`);
            if (!sock) {
                mcpLogger.error(
                    "[MCP Tool Error] send_file failed: WhatsApp socket is not available.",
                );
                return {
                    isError: true,
                    content: [
                        { type: "text", text: "Error: WhatsApp connection is not active." },
                    ],
                };
            }
            try {
                let jid: string;
                try {
                    jid = resolveSendJid(jidNormalizedUser(recipient));
                    if (!jid.includes("@")) {
                        throw new Error("Bad jid");
                    }
                } catch {
                    return fail(`Invalid recipient "${recipient}". Use a chat JID.`);
                }
                if (!chatExists(jid)) {
                    return fail("Recipient is not an existing chat. For safety, files can only be sent to chats that already exist.");
                }
                const result = await sendWhatsAppFile(waLogger, sock, jid, file_name, caption, as_document);
                return "error" in result ? fail(result.error) : ok({ success: true, ...result });
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] send_file failed: ${error.message}`);
                return fail(`Error sending file: ${error.message}`);
            }
        },
    );

    server.tool(
        "send_audio_message",
        {
            recipient: z.string().min(1).describe("JID of an existing chat, for example '923...@s.whatsapp.net' or 'group@g.us'. If a contact has both an @s.whatsapp.net and an @lid ID, always use the @s.whatsapp.net one."),
            file_name: z.string().min(1).describe("Name of an audio file in the outbox folder (just the name, no path). Sent as a voice note; non-Ogg/Opus files are converted automatically. Use list_outbox to see files."),
        },
        async ({ recipient, file_name }) => {
            const sock = getSock();

            mcpLogger.info(`[MCP Tool] Executing send_audio_message to ${recipient}: ${file_name}`);
            if (!sock) {
                mcpLogger.error("[MCP Tool Error] send_audio_message failed: WhatsApp socket is not available.");
                return fail("Error: WhatsApp connection is not active.");
            }
            try {
                let jid: string;
                try {
                    jid = resolveSendJid(jidNormalizedUser(recipient));
                    if (!jid.includes("@")) throw new Error("Bad jid");
                } catch {
                    return fail(`Invalid recipient "${recipient}". Use a chat JID.`);
                }
                if (!chatExists(jid)) {
                    return fail("Recipient is not an existing chat. For safety, audio can only be sent to chats that already exist.");
                }
                const result = await sendWhatsAppVoiceNote(waLogger, sock, jid, file_name);
                return "error" in result ? fail(result.error) : ok({ success: true, ...result });
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] send_audio_message failed: ${error.message}`);
                return fail(`Error sending audio message: ${error.message}`);
            }
        },
    );

    server.tool(
        "send_voice_message",
        {
            recipient: z.string().min(1).describe("JID of an existing chat, for example '923...@s.whatsapp.net' or 'group@g.us'. If a contact has both an @s.whatsapp.net and an @lid ID, always use the @s.whatsapp.net one."),
            text: z.string().min(1).max(1500).describe("The exact words to speak. It is converted to speech and sent as a WhatsApp voice note instead of a text message."),
            voice: z.enum(["en-US-AriaNeural", "en-US-GuyNeural", "ur-PK-UzmaNeural", "ur-PK-AsadNeural",]).optional().default("en-US-AriaNeural").describe("Voice name. English: en-US-AriaNeural (female), en-US-GuyNeural (male). Urdu: ur-PK-UzmaNeural (female), ur-PK-AsadNeural (male). The voice must match the language of the text."),
        },
        async ({ recipient, text, voice }) => {
            const sock = getSock();

            mcpLogger.info(`[MCP Tool] Executing send_voice_message to ${recipient} (${text.length} chars, ${voice})`);
            if (!sock) {
                mcpLogger.error("[MCP Tool Error] send_voice_message failed: WhatsApp socket is not available.");
                return fail("Error: WhatsApp connection is not active.");
            }
            try {
                let jid: string;
                try {
                    jid = resolveSendJid(jidNormalizedUser(recipient));
                    if (!jid.includes("@")) throw new Error("Bad jid");
                } catch {
                    return fail(`Invalid recipient "${recipient}". Use a chat JID.`);
                }
                if (!chatExists(jid)) {
                    return fail("Recipient is not an existing chat. For safety, voice messages can only be sent to chats that already exist.");
                }
                const result = await sendWhatsAppSpokenMessage(waLogger, sock, jid, text, voice);
                return "error" in result ? fail(result.error) : ok({ success: true, ...result });
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] send_voice_message failed: ${error.message}`);
                return fail(`Error sending voice message: ${error.message}`);
            }
        },
    );
}