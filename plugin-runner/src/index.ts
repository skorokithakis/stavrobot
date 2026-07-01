import { createHash, timingSafeEqual } from "crypto";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadBundles, getBundles, findBundle, findTool, readJsonFile } from "./bundle-registry.js";
import { getPluginUserIds } from "./plugin-user.js";
import {
  runScript,
  scanPluginTempDir,
  postCallback,
  setAppPassword,
  isTransportedFile,
  TOOL_TIMEOUT_MS,
  ASYNC_TIMEOUT_MS,
  MAX_FILE_TRANSPORT_BYTES,
} from "./script-runner.js";
import {
  handleInstall,
  handleUpdate,
  handleRemove,
  handleCreate,
  handleConfigure,
  migrateExistingPlugins,
  isEditable,
} from "./plugin-lifecycle.js";
import type { TransportedFile, ScriptResult } from "./script-runner.js";

const CONFIG_TOML_PATH = "/root/config/config.toml";
const INSTRUCTIONS_MAX_LENGTH = 5000;

// Loaded once at startup. The process refuses to start if the password cannot be read.
let appPassword: string | undefined;

async function readRequestBody(
  request: http.IncomingMessage,
  maxBytes: number = 50 * 1024 * 1024,
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

function loadAppPassword(): void {
  const content = fs.readFileSync(CONFIG_TOML_PATH, "utf-8");
  const match = content.match(/^password\s*=\s*"([^"]+)"$/m);
  if (match === null) {
    throw new Error("No password field found in config.toml; refusing to start");
  }
  appPassword = match[1];
  setAppPassword(appPassword);
  console.log("[stavrobot-plugin-runner] App password loaded from config.toml");
}

// This endpoint returns config values that may contain secrets (API keys, tokens).
// It must never be exposed to the LLM agent — only the admin UI may call it.
// Auth is enforced uniformly at the handleRequest level.
function handleGetBundleConfig(bundleName: string, response: http.ServerResponse): void {
  loadBundles();

  const bundle = findBundle(bundleName);
  if (bundle === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Bundle not found" }));
    return;
  }

  const schema = bundle.manifest.config ?? {};
  const configPath = path.join(bundle.bundleDir, "config.json");
  const rawValues = readJsonFile(configPath);
  const values = typeof rawValues === "object" && rawValues !== null ? rawValues : {};

  console.log(`[stavrobot-plugin-runner] Returning config for bundle "${bundleName}"`);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ schema, values }));
}

function handleListBundles(response: http.ServerResponse): void {
  loadBundles();

  const result = getBundles().map((bundle) => ({
    name: bundle.manifest.name,
    description: bundle.manifest.description,
    editable: isEditable(bundle.manifest.name),
    permissions: bundle.permissions,
  }));

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ plugins: result }));
}

function handleGetBundle(bundleName: string, response: http.ServerResponse): void {
  loadBundles();

  const bundle = findBundle(bundleName);
  if (bundle === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Bundle not found" }));
    return;
  }

  const tools = bundle.tools.map((tool) => {
    // Omit the entrypoint from the tool manifest in the response — it's an
    // implementation detail that callers don't need.
    const { entrypoint: _entrypoint, ...rest } = tool.manifest;
    return rest;
  });

  const responseBody: Record<string, unknown> = {
    name: bundle.manifest.name,
    description: bundle.manifest.description,
    editable: isEditable(bundle.manifest.name),
    permissions: bundle.permissions,
    tools,
  };

  if (bundle.manifest.instructions !== undefined) {
    responseBody["instructions"] = bundle.manifest.instructions.slice(0, INSTRUCTIONS_MAX_LENGTH);
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(responseBody));
}

async function handleRunTool(
  bundleName: string,
  toolName: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  loadBundles();

  const bundle = findBundle(bundleName);
  if (bundle === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Bundle not found" }));
    return;
  }

  const tool = findTool(bundle, toolName);
  if (tool === null) {
    const availableTools = bundle.tools
      .map((t) => {
        const params = Object.entries(t.manifest.parameters)
          .map(([name, schema]) => `${name}: ${schema.type}`)
          .join(", ");
        return params.length > 0 ? `${t.manifest.name} (${params})` : t.manifest.name;
      })
      .join(", ");
    const availablePart = availableTools.length > 0 ? ` Available tools: ${availableTools}` : "";
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `Tool not found.${availablePart}` }));
    return;
  }

  // Read permissions fresh from config.json so changes take effect without a
  // restart. Fall back to ["*"] if the value is missing or malformed.
  const configPath = path.join(bundle.bundleDir, "config.json");
  const rawConfig = readJsonFile(configPath);
  const configObject =
    typeof rawConfig === "object" && rawConfig !== null
      ? (rawConfig as Record<string, unknown>)
      : {};
  const rawPermissions = configObject["permissions"];
  const permissions: string[] =
    Array.isArray(rawPermissions) && rawPermissions.every((item) => typeof item === "string")
      ? (rawPermissions as string[])
      : ["*"];

  if (permissions.length === 0) {
    console.log(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} rejected: plugin is disabled`);
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Plugin is disabled" }));
    return;
  }

  if (!permissions.includes("*") && !permissions.includes(toolName)) {
    console.log(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} rejected: not in permissions list`);
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Tool not permitted" }));
    return;
  }

  const body = await readRequestBody(request);
  const { toolDir, manifest } = tool;

  console.log(
    `[stavrobot-plugin-runner] Running tool: ${bundleName}/${toolName}, entrypoint: ${manifest.entrypoint}, async: ${manifest.async === true}`
  );

  const entrypoint = path.join(toolDir, manifest.entrypoint);
  const { uid, gid } = getPluginUserIds(bundleName);

  const pluginTempDir = `/tmp/${bundleName}`;
  // Clear any leftover files from previous runs.
  fs.rmSync(pluginTempDir, { recursive: true, force: true });
  fs.mkdirSync(pluginTempDir, { recursive: true });
  // Make it writable by the plugin user.
  fs.chownSync(pluginTempDir, uid, gid);

  // Attempt to parse the body as JSON and materialize any file parameters into
  // the temp directory. If parsing fails, pass the raw body through unchanged
  // so non-JSON tools continue to work.
  let stdinBody = body;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = null;
  }

  if (typeof parsedBody === "object" && parsedBody !== null) {
    const params = parsedBody as Record<string, unknown>;
    const fileEntries = Object.entries(params).filter(([, value]) => isTransportedFile(value)) as [string, TransportedFile][];

    if (fileEntries.length > 0) {
      // Reject if the total decoded size of all input files exceeds the limit.
      let totalBytes = 0;
      for (const [, file] of fileEntries) {
        totalBytes += Buffer.byteLength(file.data, "base64");
      }

      if (totalBytes > MAX_FILE_TRANSPORT_BYTES) {
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Input files exceed the maximum allowed size" }));
        return;
      }

      for (const [paramName, file] of fileEntries) {
        const filePath = path.join(pluginTempDir, file.filename);
        // Reject filenames that escape the temp directory (e.g. "../../../etc/passwd").
        if (!filePath.startsWith(pluginTempDir + path.sep) && filePath !== pluginTempDir) {
          fs.rmSync(pluginTempDir, { recursive: true, force: true });
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: `Invalid filename in file parameter "${paramName}"` }));
          return;
        }
        const fileData = Buffer.from(file.data, "base64");
        fs.writeFileSync(filePath, fileData);
        fs.chownSync(filePath, uid, gid);
        params[paramName] = filePath;
        console.log(`[stavrobot-plugin-runner] Materialized input file for param "${paramName}": ${filePath} (${fileData.length} bytes)`);
      }

      stdinBody = JSON.stringify(params);
    }

    // Validate parameters: reject unknown keys and wrong types. File params are
    // already materialized to path strings at this point, so skip type-checking
    // them — the file handling code above already validated their structure.
    const schema = manifest.parameters;

    for (const key of Object.keys(params)) {
      if (!(key in schema)) {
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: `Unknown parameter: "${key}"`,
          parameters: schema,
        }));
        return;
      }
    }

    for (const [key, paramSchema] of Object.entries(schema)) {
      if (!(key in params)) {
        continue;
      }
      const value = params[key];
      const expectedType = paramSchema.type;

      if (expectedType === "file") {
        // File params have already been materialized to path strings; skip type check.
        continue;
      }

      let typeOk: boolean;
      if (expectedType === "string") {
        typeOk = typeof value === "string";
      } else if (expectedType === "number") {
        typeOk = typeof value === "number";
      } else if (expectedType === "integer") {
        typeOk = typeof value === "number" && Number.isInteger(value);
      } else if (expectedType === "boolean") {
        typeOk = typeof value === "boolean";
      } else {
        // Unknown type in schema — skip validation for forward compatibility.
        typeOk = true;
      }

      if (!typeOk) {
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: `Parameter "${key}" must be of type "${expectedType}"`,
          parameters: schema,
        }));
        return;
      }
    }
  }

  if (manifest.async === true) {
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "running" }));

    void (async (): Promise<void> => {
      const source = `plugin:${bundleName}/${toolName}`;
      let result: ScriptResult;
      try {
        result = await runScript(entrypoint, toolDir, uid, gid, stdinBody, ASYNC_TIMEOUT_MS);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[stavrobot-plugin-runner] Async tool ${bundleName}/${toolName} threw unexpectedly: ${errorMessage}`);
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        await postCallback(
          source,
          `The run of tool "${toolName}" (plugin "${bundleName}") failed:\n\`\`\`\n${errorMessage}\n\`\`\``
        );
        return;
      }

      if (result.success) {
        const files = scanPluginTempDir(pluginTempDir, bundleName);
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        console.log(`[stavrobot-plugin-runner] Async tool ${bundleName}/${toolName} completed successfully`);
        await postCallback(
          source,
          `The run of tool "${toolName}" (plugin "${bundleName}") returned:\n\`\`\`\n${result.output}\n\`\`\``,
          files,
        );
      } else {
        // Distinguish timeout from other failures for a clearer error message.
        const errorText = result.timedOut === true
          ? `Tool "${toolName}" (plugin "${bundleName}") exceeded the timeout of ${ASYNC_TIMEOUT_MS / 1000} seconds`
          : (result.error ?? result.output);
        console.error(`[stavrobot-plugin-runner] Async tool ${bundleName}/${toolName} failed: ${errorText}`);
        fs.rmSync(pluginTempDir, { recursive: true, force: true });
        await postCallback(
          source,
          `The run of tool "${toolName}" (plugin "${bundleName}") failed:\n\`\`\`\n${errorText}\n\`\`\``
        );
      }
    })();

    return;
  }

  const result = await runScript(entrypoint, toolDir, uid, gid, stdinBody, TOOL_TIMEOUT_MS);

  if (!result.success) {
    fs.rmSync(pluginTempDir, { recursive: true, force: true });

    if (result.spawnFailed === true) {
      console.error(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} failed to spawn: ${result.error}`);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: result.error }));
      return;
    }

    if (result.timedOut === true) {
      console.error(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "Tool execution timed out" }));
      return;
    }

    // Include both streams: the script may write error details to stdout
    // (e.g., JSON error objects) while uv or other tooling writes to stderr.
    console.error(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} failed: ${result.error}`);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, error: result.error }));
    return;
  }

  const files = scanPluginTempDir(pluginTempDir, bundleName);
  fs.rmSync(pluginTempDir, { recursive: true, force: true });

  let output: unknown;
  try {
    output = JSON.parse(result.output);
  } catch {
    output = result.output;
  }

  console.log(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} completed successfully`);
  response.writeHead(200, { "Content-Type": "application/json" });

  const responseBody: Record<string, unknown> = { success: true, output };
  if (files.length > 0) {
    console.log(`[stavrobot-plugin-runner] Tool ${bundleName}/${toolName} produced ${files.length} file(s) for transport`);
    responseBody["files"] = files;
  }

  response.end(JSON.stringify(responseBody));
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = request.url ?? "/";
  const method = request.method ?? "GET";

  console.log(`[stavrobot-plugin-runner] ${method} ${url}`);

  if (appPassword === undefined) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Server misconfigured: no password set" }));
    return;
  }

  const authHeader = request.headers["authorization"];
  const expectedCredentials = Buffer.from(`:${appPassword}`).toString("base64");
  const providedCredentials =
    typeof authHeader === "string" && authHeader.startsWith("Basic ")
      ? authHeader.slice("Basic ".length)
      : "";
  // Compare sha256 digests so the buffers passed to timingSafeEqual are always
  // the same length (it throws on length mismatch) and the comparison runs in
  // constant time to avoid timing-based credential recovery.
  const providedDigest = createHash("sha256").update(providedCredentials).digest();
  const expectedDigest = createHash("sha256").update(expectedCredentials).digest();
  if (!timingSafeEqual(providedDigest, expectedDigest)) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    if (method === "GET" && url === "/bundles") {
      handleListBundles(response);
      return;
    }

    const getBundleMatch = url.match(/^\/bundles\/([^/]+)$/);
    if (method === "GET" && getBundleMatch !== null) {
      handleGetBundle(getBundleMatch[1], response);
      return;
    }

    const getBundleConfigMatch = url.match(/^\/bundles\/([^/]+)\/config$/);
    if (method === "GET" && getBundleConfigMatch !== null) {
      handleGetBundleConfig(getBundleConfigMatch[1], response);
      return;
    }

    const runToolMatch = url.match(/^\/bundles\/([^/]+)\/tools\/([^/]+)\/run$/);
    if (method === "POST" && runToolMatch !== null) {
      await handleRunTool(runToolMatch[1], runToolMatch[2], request, response);
      return;
    }

    if (method === "POST" && url === "/create") {
      await handleCreate(request, response, readRequestBody);
      return;
    }

    if (method === "POST" && url === "/install") {
      await handleInstall(request, response, readRequestBody);
      return;
    }

    if (method === "POST" && url === "/update") {
      await handleUpdate(request, response, readRequestBody);
      return;
    }

    if (method === "POST" && url === "/remove") {
      await handleRemove(request, response, readRequestBody);
      return;
    }

    if (method === "POST" && url === "/configure") {
      await handleConfigure(request, response, readRequestBody);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("[stavrobot-plugin-runner] Error handling request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function main(): Promise<void> {
  loadAppPassword();
  migrateExistingPlugins();
  loadBundles();

  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    handleRequest(request, response);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  server.listen(port, () => {
    console.log(`[stavrobot-plugin-runner] Server listening on port ${port}`);
  });
}

// Only run main() when this file is the entry point, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
