import { z } from "zod";
import { type P } from "pino";
import { ok, fail } from "./helper.ts";
import { searchDbForContacts } from "../database/contacts.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getChats, getChat, getContactChats, findDirectChats, type Chat as DbChat } from "../database/chats.ts";
import { getMessagesAround, searchMessages, getLastInteraction, listMessagesFiltered, type Message as DbMessage } from "../database/messages.ts";

export function formatDbMessageForJson(msg: DbMessage) {
    return {
        id: msg.id,
        chat_jid: msg.chat_jid,
        chat_name: msg.chat_name ?? "Unknown Chat",
        sender_jid: msg.sender ?? null,
        sender_display: msg.is_from_me
            ? "Me"
            : (msg.sender_name ?? (msg.sender ? msg.sender.split("@")[0] : "Unknown")),
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
        is_from_me: msg.is_from_me,
        media_type: msg.media_type ?? null,
    };
}

export function formatDbChatForJson(chat: DbChat) {
    return {
        jid: chat.jid,
        name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
        is_group: chat.jid.endsWith("@g.us"),
        last_message_time: chat.last_message_time?.toISOString() ?? null,
        last_message_preview: chat.last_message ?? null,
        last_sender_jid: chat.last_sender ?? null,
        last_sender_display: chat.last_sender
            ? chat.last_sender.split("@")[0]
            : chat.last_is_from_me
                ? "Me"
                : null,
        last_is_from_me: chat.last_is_from_me ?? null,
    };
}

export function registerReadTools(server: McpServer, mcpLogger: P.Logger) {
    server.tool(
        "search_contacts",
        {
            query: z
                .string()
                .min(1)
                .describe("Search term for contact name or phone number part of JID"),
        },
        async ({ query }) => {
            mcpLogger.info(
                `[MCP Tool] Executing search_contacts with query: "${query}"`,
            );
            try {
                const contacts = searchDbForContacts(query, 20);
                const formattedContacts = contacts.map((c) => ({
                    jid: c.jid,
                    name: c.name ?? c.jid.split("@")[0],
                }));
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedContacts, null, 2),
                        },
                    ],
                };
            } catch (error: any) {
                mcpLogger.error(
                    `[MCP Tool Error] search_contacts failed: ${error.message}`,
                );
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error searching contacts: ${error.message}`,
                        },
                    ],
                };
            }
        },
    );

    server.tool(
        "list_messages",
        {
            chat_jid: z.string().optional().describe("Limit to one chat (e.g. '123@s.whatsapp.net' or 'group@g.us'). Omit to search all chats."),
            chat_name: z.string().optional().describe("Chat, group or channel name (matches on words). Use this instead of chat_jid when you only know the name."),
            sender: z.string().optional().describe("Only messages from this sender (JID, or phone number with country code)"),
            query: z.string().optional().describe("Only messages whose text contains this"),
            media_type: z.enum(["image", "video", "audio", "document", "sticker"]).optional().describe("Only messages with downloadable media of this type"),
            after: z.string().optional().describe("Only messages after this date/time (ISO, e.g. 2026-10-01)"),
            before: z.string().optional().describe("Only messages before this date/time (ISO)"),
            limit: z.number().int().positive().max(100).optional().default(20).describe("Max messages per page (default 20, max 100)"),
            page: z.number().int().nonnegative().optional().default(0).describe("Page number (0-indexed)"),
            include_context: z.boolean().optional().default(false).describe("Also return surrounding messages for each result"),
            context_before: z.number().int().nonnegative().max(10).optional().default(1),
            context_after: z.number().int().nonnegative().max(10).optional().default(1),
        },
        async ({ chat_jid, chat_name, sender, query, media_type, after, before, limit, page, include_context, context_before, context_after }) => {
            mcpLogger.info(`[MCP Tool] Executing list_messages chat=${chat_jid} sender=${sender} query=${query} media_type=${media_type} limit=${limit} page=${page}`);
            try {
                const toIso = (s?: string) => {
                    if (!s) return undefined;
                    const d = new Date(s);
                    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: "${s}"`);
                    return d.toISOString();
                };
                const messages = listMessagesFiltered({
                    chatJid: chat_jid, chatName: chat_name, senderJid: sender, query, mediaType: media_type,
                    after: toIso(after), before: toIso(before), limit, page,
                });
                if (!messages.length) return ok("No messages found.");
                if (!include_context) return ok(messages.map(formatDbMessageForJson));
                return ok(
                    messages.map((m) => {
                        const ctx = getMessagesAround(m.id, context_before, context_after);
                        return {
                            message: formatDbMessageForJson(m),
                            before: ctx.before.map(formatDbMessageForJson),
                            after: ctx.after.map(formatDbMessageForJson),
                        };
                    }),
                );
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] list_messages failed: ${error.message}`);
                return fail(`Error listing messages: ${error.message}`);
            }
        },
    );

    server.tool(
        "get_direct_chat_by_contact",
        {
            contact: z
                .string()
                .min(1)
                .describe(
                    "Contact name, push name, or phone number with country code. Returns up to 5 ranked candidates. The same person's @lid and @s.whatsapp.net chats are already merged into one result, so only ask the user to choose if the candidates have clearly different names or numbers.",
                ),
        },
        async ({ contact }) => {
            mcpLogger.info(`[MCP Tool] Executing get_direct_chat_by_contact for "${contact}"`);
            try {
                const chats = findDirectChats(contact, 5);
                return chats.length
                    ? ok(chats.map(formatDbChatForJson))
                    : ok(
                        `No direct chat matched "${contact}". The saved contact name may not be stored. Do not keep retrying; ask the user for a phone number or the exact chat name.`,
                    );
            } catch (error: any) {
                return fail(`Error: ${error.message}`);
            }
        },
    );

    server.tool(
        "get_contact_chats",
        {
            contact: z.string().min(1).describe("Contact JID or phone number with country code (use search_contacts first for names)"),
            limit: z.number().int().positive().max(100).optional().default(20),
            page: z.number().int().nonnegative().optional().default(0),
        },
        async ({ contact, limit, page }) => {
            mcpLogger.info(`[MCP Tool] Executing get_contact_chats for "${contact}"`);
            try {
                const chats = getContactChats(contact, limit, page);
                return chats.length ? ok(chats.map(formatDbChatForJson)) : ok(`No chats found involving "${contact}".`);
            } catch (error: any) {
                return fail(`Error: ${error.message}`);
            }
        },
    );

    server.tool(
        "get_last_interaction",
        { contact: z.string().min(1).describe("Contact JID or phone number with country code (use search_contacts first for names)") },
        async ({ contact }) => {
            mcpLogger.info(`[MCP Tool] Executing get_last_interaction for "${contact}"`);
            try {
                const msg = getLastInteraction(contact);
                return msg ? ok(formatDbMessageForJson(msg)) : ok(`No messages found for "${contact}".`);
            } catch (error: any) {
                return fail(`Error: ${error.message}`);
            }
        },
    );

    server.tool(
        "list_chats",
        {
            limit: z
                .number()
                .int()
                .positive()
                .max(100)
                .optional()
                .default(20)
                .describe("Max chats per page (default 20)"),
            page: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .default(0)
                .describe("Page number (0-indexed, default 0)"),
            sort_by: z
                .enum(["last_active", "name"])
                .optional()
                .default("last_active")
                .describe("Sort order: 'last_active' (default) or 'name'"),
            query: z
                .string()
                .optional()
                .describe("Optional filter by chat name or JID"),
            include_last_message: z
                .boolean()
                .optional()
                .default(true)
                .describe("Include last message details (default true)"),
        },
        async ({ limit, page, sort_by, query, include_last_message }) => {
            mcpLogger.info(
                `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
            );
            try {
                const chats = getChats(
                    limit,
                    page,
                    sort_by,
                    query ?? null,
                    include_last_message,
                );
                if (!chats.length && page === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
                            },
                        ],
                    };
                } else if (!chats.length) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No more chats found on page ${page}${query ? ` matching "${query}"` : ""
                                    }.`,
                            },
                        ],
                    };
                }
                const formattedChats = chats.map(formatDbChatForJson);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedChats, null, 2),
                        },
                    ],
                };
            } catch (error: any) {
                mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
                return {
                    isError: true,
                    content: [
                        { type: "text", text: `Error listing chats: ${error.message}` },
                    ],
                };
            }
        },
    );

    server.tool(
        "get_chat",
        {
            chat_jid: z.string().describe("The JID of the chat to retrieve"),
            include_last_message: z
                .boolean()
                .optional()
                .default(true)
                .describe("Include last message details (default true)"),
        },
        async ({ chat_jid, include_last_message }) => {
            mcpLogger.info(
                `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
            );
            try {
                const chat = getChat(chat_jid, include_last_message);
                if (!chat) {
                    return {
                        isError: true,
                        content: [
                            { type: "text", text: `Chat with JID ${chat_jid} not found.` },
                        ],
                    };
                }
                const formattedChat = formatDbChatForJson(chat);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedChat, null, 2),
                        },
                    ],
                };
            } catch (error: any) {
                mcpLogger.error(
                    `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
                );
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error retrieving chat ${chat_jid}: ${error.message}`,
                        },
                    ],
                };
            }
        },
    );

    server.tool(
        "get_message_context",
        {
            message_id: z
                .string()
                .describe("The ID of the target message to get context around"),
            before: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .default(5)
                .describe("Number of messages before (default 5)"),
            after: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .default(5)
                .describe("Number of messages after (default 5)"),
        },
        async ({ message_id, before, after }) => {
            mcpLogger.info(
                `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
            );
            try {
                const context = getMessagesAround(message_id, before, after);
                if (!context.target) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Message with ID ${message_id} not found.`,
                            },
                        ],
                    };
                }
                const formattedContext = {
                    target: formatDbMessageForJson(context.target),
                    before: context.before.map(formatDbMessageForJson),
                    after: context.after.map(formatDbMessageForJson),
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedContext, null, 2),
                        },
                    ],
                };
            } catch (error: any) {
                mcpLogger.error(
                    `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
                );
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error retrieving context for message ${message_id}: ${error.message}`,
                        },
                    ],
                };
            }
        },
    );

    server.tool(
        "search_messages",
        {
            query: z
                .string()
                .min(1)
                .describe("The text content to search for within messages"),
            chat_jid: z
                .string()
                .optional()
                .describe(
                    "Optional: The JID of a specific chat to search within (e.g., '123...net' or 'group@g.us'). If omitted, searches all chats.",
                ),
            limit: z
                .number()
                .int()
                .positive()
                .max(100)
                .optional()
                .default(10)
                .describe("Max messages per page (default 10, max 100)"),
            page: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .default(0)
                .describe("Page number (0-indexed, default 0)"),
        },
        async ({ chat_jid, query, limit, page }) => {
            const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
            mcpLogger.info(
                `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
            );
            try {
                const messages = searchMessages(query, chat_jid, limit, page);

                if (!messages.length && page === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No messages found containing "${query}" ${searchScope}.`,
                            },
                        ],
                    };
                } else if (!messages.length) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No more messages found containing "${query}" on page ${page} ${searchScope}.`,
                            },
                        ],
                    };
                }

                const formattedMessages = messages.map(formatDbMessageForJson);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedMessages, null, 2),
                        },
                    ],
                };
            } catch (error: any) {
                mcpLogger.error(
                    `[MCP Tool Error] search_messages_in_chat failed for ${chat_jid} / "${query}": ${error.message}`,
                );
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error searching messages in chat ${chat_jid}: ${error.message}`,
                        },
                    ],
                };
            }
        },
    );
}