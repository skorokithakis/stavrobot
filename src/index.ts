import http from "http";
import { loadConfig } from "./config.js";
import { connectDatabase, initializeSchema, initializeMemoriesSchema, initializeCompactionsSchema, initializeCronSchema } from "./database.js";
import { createAgent } from "./agent.js";
import { initializeQueue, enqueueMessage } from "./queue.js";
import { initializeScheduler } from "./scheduler.js";
import type { TelegramConfig } from "./config.js";
import { registerTelegramWebhook, handleTelegramWebhook } from "./telegram.js";
import { serveLoginPage, handleLoginPost } from "./login.js";
import {
  serveExplorerPage,
  handleTablesRequest,
  handleTableSchemaRequest,
  handleTableRowsRequest,
} from "./explorer.js";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleChatRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  try {
    const body = await readRequestBody(request);
    let parsedBody: unknown;
    
    try {
      parsedBody = JSON.parse(body);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (typeof parsedBody !== "object" || parsedBody === null) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Request body must be a JSON object" }));
      return;
    }

    const message = "message" in parsedBody && typeof parsedBody.message === "string" ? parsedBody.message : undefined;
    const audio = "audio" in parsedBody && typeof parsedBody.audio === "string" ? parsedBody.audio : undefined;

    if (message === undefined && audio === undefined) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "At least one of 'message' or 'audio' must be present" }));
      return;
    }

    const source = "source" in parsedBody && typeof parsedBody.source === "string" ? parsedBody.source : undefined;
    const sender = "sender" in parsedBody && typeof parsedBody.sender === "string" ? parsedBody.sender : undefined;
    const audioContentType = "audioContentType" in parsedBody && typeof parsedBody.audioContentType === "string" ? parsedBody.audioContentType : undefined;

    console.log("[stavrobot] Incoming request:", { message, source, sender, hasAudio: audio !== undefined, audioContentType });

    const assistantResponse = await enqueueMessage(message, source, sender, audio, audioContentType);

    if (assistantResponse) {
      console.log("[stavrobot] Agent response:", assistantResponse);
    } else {
      console.log("[stavrobot] Agent returned empty response.");
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ response: assistantResponse }));
  } catch (error) {
    console.error("[stavrobot] Error handling request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function handleTelegramWebhookRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  telegramConfig: TelegramConfig | undefined
): Promise<void> {
  if (telegramConfig === undefined) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const body = await readRequestBody(request);
    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(body);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Respond 200 immediately before processing — Telegram requires a fast response.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));

    void handleTelegramWebhook(parsedBody, telegramConfig);
  } catch (error) {
    console.error("[stavrobot] Error handling Telegram webhook request:", error);
    if (!response.headersSent) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: errorMessage }));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = await connectDatabase(config.postgres);
  await initializeSchema(pool);
  await initializeMemoriesSchema(pool);
  await initializeCompactionsSchema(pool);
  await initializeCronSchema(pool);
  const agent = await createAgent(config, pool);
  initializeQueue(agent, pool, config);
  await initializeScheduler(pool);

  if (config.telegram !== undefined) {
    if (config.publicHostname === undefined) {
      throw new Error("Config must specify publicHostname when telegram is configured.");
    }
    await registerTelegramWebhook(config.telegram, config.publicHostname);
  }

  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (request.method === "POST" && pathname === "/chat") {
      handleChatRequest(request, response);
    } else if (request.method === "POST" && pathname === "/telegram/webhook") {
      handleTelegramWebhookRequest(request, response, config.telegram);
    } else if (request.method === "GET" && pathname === "/providers/anthropic/login") {
      serveLoginPage(response);
    } else if (request.method === "POST" && pathname === "/providers/anthropic/login") {
      void handleLoginPost(request, response, config);
    } else if (request.method === "GET" && pathname === "/explorer") {
      serveExplorerPage(response);
    } else if (request.method === "GET" && pathname === "/api/explorer/tables") {
      void handleTablesRequest(response, pool);
    } else if (request.method === "GET" && pathname.startsWith("/api/explorer/tables/")) {
      const parts = pathname.slice("/api/explorer/tables/".length).split("/");
      const tableName = decodeURIComponent(parts[0]);
      if (parts.length === 1) {
        void handleTableSchemaRequest(response, pool, tableName);
      } else if (parts.length === 2 && parts[1] === "rows") {
        void handleTableRowsRequest(response, pool, tableName, url.searchParams);
      } else {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Not found" }));
      }
    } else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    }
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

main();
