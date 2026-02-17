import http from "http";
import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import { loadConfig, type Config } from "./config.js";
import { connectDatabase, initializeSchema, initializeMemoriesSchema, initializeCompactionsSchema } from "./database.js";
import { createAgent, handlePrompt } from "./agent.js";

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleChatRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  agent: Agent,
  pool: pg.Pool,
  config: Config
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

    if (
      typeof parsedBody !== "object" ||
      parsedBody === null ||
      !("message" in parsedBody) ||
      typeof parsedBody.message !== "string"
    ) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing or invalid 'message' field" }));
      return;
    }

    const source = "source" in parsedBody && typeof parsedBody.source === "string" ? parsedBody.source : undefined;
    const sender = "sender" in parsedBody && typeof parsedBody.sender === "string" ? parsedBody.sender : undefined;

    console.log("[stavrobot] Incoming request:", { message: parsedBody.message, source, sender });

    const assistantResponse = await handlePrompt(agent, pool, parsedBody.message, config, source, sender);

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

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = await connectDatabase(config.postgres);
  await initializeSchema(pool);
  await initializeMemoriesSchema(pool);
  await initializeCompactionsSchema(pool);
  const agent = await createAgent(config, pool);

  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    if (request.method === "POST" && request.url === "/chat") {
      handleChatRequest(request, response, agent, pool, config);
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
