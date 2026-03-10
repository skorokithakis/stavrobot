import http from "http";
import { fileURLToPath } from "url";
import type { Pool } from "pg";
import { loadConfig } from "./config.js";
import { loadAllowlist } from "./allowlist.js";
import { connectDatabase, initializeSchema, initializeMemoriesSchema, initializeCompactionsSchema, initializeCronSchema, seedNightlyReview, initializePagesSchema, initializeScratchpadSchema, initializeAgentsSchema, seedOwner, getPageByPath, getPageQueryByPath } from "./database.js";
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
import { handleUploadRequest, saveAttachment } from "./uploads.js";
import type { FileAttachment } from "./uploads.js";
import {
  servePluginsPage,
  handlePluginsListRequest,
  handlePluginDetailRequest,
  handlePluginConfigRequest,
  handlePluginInstallRequest,
  handlePluginUpdateRequest,
  handlePluginRemoveRequest,
  handlePluginConfigureRequest,
} from "./plugins.js";
import {
  serveSettingsHubPage,
  serveAllowlistPage,
  handleGetAllowlistRequest,
  handlePutAllowlistRequest,
} from "./settings.js";
import { serveSignalCaptchaPage, handleSignalCaptchaSubmit } from "./signal-captcha.js";
import { initializeWhatsApp } from "./whatsapp.js";
import { serveHomePage } from "./home.js";
import { log } from "./log.js";

const CSP_HEADER_VALUE =
  "default-src 'self'; " +
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'";

function isPublicRoute(method: string, pathname: string): boolean {
  if (method === "POST" && pathname === "/telegram/webhook") {
    return true;
  }
  // Pages have per-row auth: the route handler checks is_public and enforces auth itself.
  if (method === "GET" && pathname.startsWith("/pages/")) {
    return true;
  }
  // Page queries have per-page auth: the handler checks is_public and enforces auth itself.
  if (method === "GET" && pathname.startsWith("/api/pages/") && pathname.includes("/queries/")) {
    return true;
  }
  return false;
}

export function checkBasicAuth(request: http.IncomingMessage, password: string): boolean {
  const authHeader = request.headers["authorization"];
  if (authHeader === undefined || !authHeader.startsWith("Basic ")) {
    return false;
  }
  const base64 = authHeader.slice("Basic ".length);
  const decoded = Buffer.from(base64, "base64").toString();
  // The Basic auth format is "username:password". We ignore the username.
  const colonIndex = decoded.indexOf(":");
  const providedPassword = colonIndex === -1 ? decoded : decoded.slice(colonIndex + 1);
  return providedPassword === password;
}

export async function readRequestBody(
  request: http.IncomingMessage,
  maxBytes: number = 1 * 1024 * 1024,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > maxBytes) {
      request.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handleChatRequest(
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

    let attachments: FileAttachment[] | undefined;
    if ("attachments" in parsedBody && Array.isArray(parsedBody.attachments)) {
      attachments = (parsedBody.attachments as unknown[]).filter((item): item is FileAttachment => {
        return (
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).storedPath === "string" &&
          typeof (item as Record<string, unknown>).originalFilename === "string" &&
          typeof (item as Record<string, unknown>).mimeType === "string" &&
          typeof (item as Record<string, unknown>).size === "number"
        );
      });
      if (attachments.length === 0) {
        attachments = undefined;
      }
    }

    const source = "source" in parsedBody && typeof parsedBody.source === "string" ? parsedBody.source : undefined;
    const sender = "sender" in parsedBody && typeof parsedBody.sender === "string" ? parsedBody.sender : undefined;

    // Parse raw file data sent by external callers (e.g. the Signal bridge) that
    // cannot write to the app container's filesystem directly.
    interface RawFileEntry {
      data: string;
      filename: string;
      mimeType: string;
    }
    let savedFromFiles: FileAttachment[] = [];
    if ("files" in parsedBody && Array.isArray(parsedBody.files)) {
      const rawFiles = (parsedBody.files as unknown[]).filter((item): item is RawFileEntry => {
        return (
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).data === "string" &&
          typeof (item as Record<string, unknown>).filename === "string" &&
          typeof (item as Record<string, unknown>).mimeType === "string"
        );
      });
      log.debug("[stavrobot] Received", rawFiles.length, "file(s) via 'files' field");
      for (const rawFile of rawFiles) {
        const buffer = Buffer.from(rawFile.data, "base64");
        if (buffer.length > 10 * 1024 * 1024) {
          log.warn("[stavrobot] Skipping file", rawFile.filename, "— decoded size", buffer.length, "exceeds 10 MB limit");
          continue;
        }
        const { storedPath } = await saveAttachment(buffer, rawFile.filename, rawFile.mimeType);
        savedFromFiles.push({
          storedPath,
          originalFilename: rawFile.filename,
          mimeType: rawFile.mimeType,
          size: buffer.length,
        });
      }
    }

    const combinedAttachments: FileAttachment[] | undefined =
      (attachments !== undefined || savedFromFiles.length > 0)
        ? [...(attachments ?? []), ...savedFromFiles]
        : undefined;

    if (message === undefined && combinedAttachments === undefined) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "At least one of 'message', 'attachments', or 'files' must be present" }));
      return;
    }

    const assistantResponse = await enqueueMessage(message, source, sender, combinedAttachments);

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ response: assistantResponse }));
  } catch (error) {
    if (error instanceof Error && error.message === "Request body too large") {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }
    log.error("[stavrobot] Error handling request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

export async function handleTelegramWebhookRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  telegramConfig: TelegramConfig | undefined,
  webhookSecret: string | undefined
): Promise<void> {
  if (telegramConfig === undefined) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (webhookSecret !== undefined) {
    const providedSecret = request.headers["x-telegram-bot-api-secret-token"];
    if (providedSecret !== webhookSecret) {
      let reason = "unknown";
      if (providedSecret === undefined) {
        reason = "missing_header";
      } else if (Array.isArray(providedSecret)) {
        reason = "multiple_header_values";
      } else if (typeof providedSecret !== "string") {
        reason = "non_string_header";
      } else {
        reason = "wrong_secret";
      }
      log.info(`[stavrobot] Telegram webhook rejected: ${reason}`);
      const providedFingerprint = typeof providedSecret === "string" ? providedSecret.slice(0, 8) : String(providedSecret);
      log.debug(`[stavrobot] [debug] Secret mismatch: reason=${reason}, provided=${providedFingerprint}...`);
      log.debug(`[stavrobot] [debug] Request metadata: remoteAddress=${request.socket?.remoteAddress}, x-forwarded-for=${request.headers["x-forwarded-for"]}, user-agent=${request.headers["user-agent"]}, content-length=${request.headers["content-length"]}`);
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
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
    if (error instanceof Error && error.message === "Request body too large") {
      if (!response.headersSent) {
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Request body too large" }));
      }
      return;
    }
    log.error("[stavrobot] Error handling Telegram webhook request:", error);
    if (!response.headersSent) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: errorMessage }));
    }
  }
}

// Returns an error message string if the SQL is not a valid read-only query, or null if it is valid.
function validateReadOnlySql(sql: string): string | null {
  if (!sql.match(/^(SELECT|WITH)\b/i)) {
    return "Only SELECT queries are allowed";
  }
  // Strip one optional trailing semicolon, then reject if any remain — this
  // blocks multi-statement injection like "SELECT 1; DELETE FROM users".
  if (sql.replace(/;$/, "").includes(";")) {
    return "Multiple SQL statements are not allowed";
  }
  return null;
}

export async function handlePageQueryRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  password: string | undefined,
  pool: Pool,
  url: URL,
): Promise<void> {
  try {
    // The path format is /api/pages/<pagePath>/queries/<queryName>.
    // The query name is always the last segment after the last "/queries/".
    // Everything between "/api/pages/" and the last "/queries/" is the page path.
    const queriesMarker = "/queries/";
    const lastQueriesIndex = pathname.lastIndexOf(queriesMarker);
    const pagePath = pathname.slice("/api/pages/".length, lastQueriesIndex);
    const queryName = pathname.slice(lastQueriesIndex + queriesMarker.length);

    if (pagePath === "" || queryName === "") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const pageQuery = await getPageQueryByPath(pool, pagePath, queryName);
    if (pageQuery === null) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (!pageQuery.isPublic && password !== undefined) {
      if (!checkBasicAuth(request, password)) {
        response.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Basic realm="stavrobot"`,
        });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const sql = pageQuery.query.trim();
    const validationError = validateReadOnlySql(sql);
    if (validationError !== null) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: validationError }));
      return;
    }

    // Parse $param:name placeholders and replace them with positional $1, $2, etc.
    // Parameters are read from query string values.
    const paramRegex = /\$param:(\w+)/g;
    const paramNames: string[] = [];
    const seenParams = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = paramRegex.exec(sql)) !== null) {
      const name = match[1];
      if (!seenParams.has(name)) {
        seenParams.add(name);
        paramNames.push(name);
      }
    }

    const paramValues: string[] = [];
    for (const name of paramNames) {
      const value = url.searchParams.get(name);
      if (value === null) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: `Missing query parameter: ${name}` }));
        return;
      }
      paramValues.push(value);
    }

    // Replace each unique $param:name with its positional placeholder $1, $2, etc.
    let paramIndex = 0;
    const paramMap = new Map<string, string>();
    for (const name of paramNames) {
      paramMap.set(name, `$${++paramIndex}`);
    }
    const parameterizedSql = sql.replace(/\$param:(\w+)/g, (_full, name: string) => paramMap.get(name) ?? "");

    log.info(`[stavrobot] Page query: ${pagePath}/${queryName}`, parameterizedSql);
    const result = await pool.query(parameterizedSql, paramValues);

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.rows));
  } catch (error) {
    log.error("[stavrobot] Error handling page query request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function handlePageRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  password: string | undefined,
  pool: Pool,
): Promise<void> {
  try {
    // Strip the "/pages/" prefix and any trailing slash to get the stored path.
    const pagePath = pathname.slice("/pages/".length).replace(/\/+$/, "");
    if (pagePath === "") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const page = await getPageByPath(pool, pagePath);
    if (page === null) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (!page.isPublic && password !== undefined) {
      if (!checkBasicAuth(request, password)) {
        response.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Basic realm="stavrobot"`,
        });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    log.info(`[stavrobot] Serving page: ${pagePath} (public: ${page.isPublic})`);
    response.writeHead(200, { "Content-Type": page.mimetype });
    response.end(page.data);
  } catch (error) {
    log.error("[stavrobot] Error handling page request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.password === undefined) {
    throw new Error("Config must specify a password.");
  }
  loadAllowlist(config);
  const pool = await connectDatabase();
  await initializeSchema(pool);
  await initializeMemoriesSchema(pool);
  await initializeCompactionsSchema(pool);
  await initializeCronSchema(pool);
  await seedNightlyReview(pool);
  await initializePagesSchema(pool);
  await initializeScratchpadSchema(pool);
  await initializeAgentsSchema(pool);
  await seedOwner(pool, config.owner);
  const agent = await createAgent(config, pool);
  initializeQueue(agent, pool, config);
  await initializeScheduler(pool);

  let telegramWebhookSecret: string | undefined;
  if (config.telegram !== undefined) {
    if (config.publicHostname === undefined) {
      throw new Error("Config must specify publicHostname when telegram is configured.");
    }
    telegramWebhookSecret = await registerTelegramWebhook(config.telegram, config.publicHostname);
    log.debug(`[stavrobot] [debug] Telegram webhook secret loaded: fingerprint=${telegramWebhookSecret.slice(0, 8)}..., bootTime=${new Date().toISOString()}`);
  }

  if (config.whatsapp !== undefined) {
    await initializeWhatsApp(config.whatsapp);
  }

  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const pathname = url.pathname;

    response.setHeader("Content-Security-Policy", CSP_HEADER_VALUE);

    if (config.password !== undefined && !isPublicRoute(request.method ?? "", pathname)) {
      if (!checkBasicAuth(request, config.password)) {
        log.info("[stavrobot] Unauthorized request:", request.method, pathname);
        response.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Basic realm="stavrobot"`,
        });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (request.method === "GET" && pathname === "/") {
      void serveHomePage(response, config, pool);
    } else if (request.method === "POST" && pathname === "/api/upload") {
      void handleUploadRequest(request, response);
    } else if (request.method === "POST" && pathname === "/chat") {
      handleChatRequest(request, response);
    } else if (request.method === "POST" && pathname === "/telegram/webhook") {
      handleTelegramWebhookRequest(request, response, config.telegram, telegramWebhookSecret);
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
    } else if (request.method === "GET" && pathname === "/plugins") {
      response.writeHead(302, { "Location": "/settings/plugins" });
      response.end();
    } else if (request.method === "GET" && pathname === "/settings/plugins") {
      servePluginsPage(response);
    } else if (request.method === "GET" && pathname === "/api/settings/plugins/list") {
      void handlePluginsListRequest(response);
    } else if (request.method === "GET" && pathname.startsWith("/api/settings/plugins/") && pathname.endsWith("/detail")) {
      const name = decodeURIComponent(pathname.slice("/api/settings/plugins/".length, -"/detail".length));
      void handlePluginDetailRequest(response, name);
    } else if (request.method === "GET" && pathname.startsWith("/api/settings/plugins/") && pathname.endsWith("/config")) {
      const name = decodeURIComponent(pathname.slice("/api/settings/plugins/".length, -"/config".length));
      void handlePluginConfigRequest(response, name, config.password);
    } else if (request.method === "POST" && pathname === "/api/settings/plugins/install") {
      void handlePluginInstallRequest(request, response);
    } else if (request.method === "POST" && pathname === "/api/settings/plugins/update") {
      void handlePluginUpdateRequest(request, response);
    } else if (request.method === "POST" && pathname === "/api/settings/plugins/remove") {
      void handlePluginRemoveRequest(request, response);
    } else if (request.method === "POST" && pathname === "/api/settings/plugins/configure") {
      void handlePluginConfigureRequest(request, response);
    } else if (request.method === "GET" && pathname === "/settings/allowlist") {
      serveAllowlistPage(response);
    } else if (request.method === "GET" && pathname === "/settings") {
      serveSettingsHubPage(response);
    } else if (request.method === "GET" && pathname === "/api/settings/allowlist") {
      handleGetAllowlistRequest(response, config);
    } else if (request.method === "PUT" && pathname === "/api/settings/allowlist") {
      void handlePutAllowlistRequest(request, response, config);
    } else if (request.method === "GET" && pathname === "/signal/captcha") {
      serveSignalCaptchaPage(response);
    } else if (request.method === "POST" && pathname === "/signal/captcha") {
      void handleSignalCaptchaSubmit(request, response);
    } else if (request.method === "GET" && pathname.startsWith("/api/pages/") && pathname.includes("/queries/")) {
      void handlePageQueryRequest(request, response, pathname, config.password, pool, url);
    } else if (request.method === "GET" && pathname.startsWith("/pages/")) {
      void handlePageRequest(request, response, pathname, config.password, pool);
    } else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    }
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  server.listen(port, () => {
    log.info(`Server listening on port ${port}`);
  });

  const internalServer = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    if (request.method === "POST" && new URL(request.url || "/", "http://localhost").pathname === "/chat") {
      void handleChatRequest(request, response);
    } else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    }
  });

  internalServer.listen(3001, () => {
    log.info("[stavrobot] Internal server listening on port 3001");
  });
}

// Only run main() when this file is the entry point, not when imported by tests.
// In ESM, import.meta.url is the file URL of this module; process.argv[1] is the
// path of the entry-point script. We compare them to detect the direct-run case.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
