import { type P } from "pino";
import { registerReadTools } from "./read.ts";
import { registerActionTools } from "./action.ts";
import { type WhatsAppSocket } from "../whatsapp/index.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
    name: "whatsapp-baileys-ts",
    version: "0.1.0",
    capabilities: {
        tools: {},
        resources: {},
    },
});
const transport = new StdioServerTransport();

const schemaText = `
TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE)
TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_number TEXT)
TABLE media_raw (message_id TEXT NOT NULL, chat_jid TEXT NOT NULL, media_type TEXT, filename TEXT, mimetype TEXT, file_length INTEGER, raw TEXT NOT NULL, PRIMARY KEY (message_id, chat_jid))
TABLE sent_raw (message_id TEXT NOT NULL, chat_jid TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (message_id, chat_jid))
`.trim();

export async function startMcpServer(
    getSock: () => WhatsAppSocket | null,
    mcpLogger: P.Logger,
    waLogger: P.Logger,
): Promise<void> {
    mcpLogger.info("Initializing MCP server...");

    registerReadTools(server, mcpLogger);

    registerActionTools(server, getSock, mcpLogger, waLogger);

    server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
        mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);

        return {
            contents: [
                {
                    uri: uri.href,
                    text: schemaText,
                },
            ],
        };
    });

    mcpLogger.info("MCP server configured. Connecting stdio transport...");

    try {
        await server.connect(transport);
        mcpLogger.info(
            "MCP transport connected. Server is ready and listening via stdio.",
        );
    } catch (error: any) {
        mcpLogger.error(
            `[FATAL] Failed to connect MCP transport: ${error.message}`,
            error,
        );
        process.exit(1);
    }

    mcpLogger.info(
        "MCP Server setup complete. Waiting for requests from client...",
    );
}