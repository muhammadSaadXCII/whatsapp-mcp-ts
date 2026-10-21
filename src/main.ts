import fs from 'node:fs';
import { pino } from "pino";
import path from 'node:path';
import { format } from "node:util";
import { startMcpServer } from "./mcp/index.ts";
import { initializeDatabase } from "./database/client.ts";
import { getSock, startWhatsAppConnection } from "./whatsapp/index.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || path.join(import.meta.dirname, "..", "info");

fs.mkdirSync(dataDir, { recursive: true });

const waLogPath = path.join(dataDir, "wa_logs.txt");
const mcpLogPath = path.join(dataDir, "mcp_logs.txt");
if (fs.existsSync(waLogPath)) {
  fs.writeFileSync(waLogPath, "");
}
if (fs.existsSync(mcpLogPath)) {
  fs.writeFileSync(mcpLogPath, "");
}

const waLogger = pino(
  {
    level: "info",
    timestamp: () =>
      `,"time":"${new Date().toLocaleString("sv-SE")}"`,
  },
  pino.destination(path.join(dataDir, "wa_logs.txt"))
);

const mcpLogger = pino(
  {
    level: "info",
    timestamp: () =>
      `,"time":"${new Date().toLocaleString("sv-SE")}"`,
  },
  pino.destination(path.join(dataDir, "mcp_logs.txt"))
);

const redirect = (level: "info" | "warn" | "error") => (...args: unknown[]) => {
  const msg = format(...args);
  if (msg.startsWith("Closing session: SessionEntry")) {
    waLogger[level]("libsignal: closing session (details omitted)");
    return;
  }
  waLogger[level](msg);
};
console.log = redirect("info");
console.info = redirect("info");
console.warn = redirect("warn");
console.error = redirect("error");

process.on("unhandledRejection", (e) => mcpLogger.error({ err: e }, "Unhandled rejection"));
process.on("uncaughtException", (e) => mcpLogger.error({ err: e }, "Uncaught exception"));

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

    mcpLogger.info("Attempting to connect to WhatsApp...");
    await startWhatsAppConnection(waLogger);
    mcpLogger.info("WhatsApp connection process initiated.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or WhatsApp connection attempt"
    );

    process.exit(1);
  }

  try {
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(getSock, mcpLogger, waLogger);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed to start MCP server");
    process.exit(1);
  }

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  waLogger.flush();
  mcpLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
