import fs from "fs";
import path from "path";

import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { getPluginUserIds } from "./plugin-user.js";
import { buildScriptEnv, TOOL_TIMEOUT_MS } from "./script-runner.js";
import type { CallToolResult, Tool, Transport } from "@modelcontextprotocol/client";
import type { ToolManifest, ToolParamSchema } from "./bundle-registry.js";
import type { TransportedFile } from "./script-runner.js";

const PLUGINS_DIR = "/plugins";
const STDIO_SPEC_KEYS = ["command", "args", "env", "type"];
const HTTP_SPEC_KEYS = ["url", "headers", "type"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface McpStdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerSpec {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

export interface McpConnectionInfo {
  tools: ToolManifest[];
  instructions: string | undefined;
}

interface ConnectionEntry {
  client: Client;
  transport: Transport;
  remote: boolean;
  tools: ToolManifest[];
  instructions: string | undefined;
  connected: boolean;
}

const connections = new Map<string, ConnectionEntry>();
const pendingConnections = new Map<string, Promise<McpConnectionInfo>>();
// Attempt ids let a connect attempt notice that disconnect() cancelled it
// before it had a chance to publish its connection.
const connectionAttempts = new Map<string, number>();
let nextConnectionAttempt = 0;

function validateStringArray(value: unknown, fieldName: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return `'${fieldName}' must be an array of strings`;
  }
  return null;
}

// HTTP token characters, per RFC 9110. Names outside this set would be rejected
// by fetch or could smuggle additional header lines.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function validateHeaders(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "'headers' must be an object with string values";
  }

  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      return `header name ${JSON.stringify(name)} is not valid`;
    }
    // Never include the value in the message: headers usually carry secrets.
    if (typeof item !== "string" || /[\r\n\0]/.test(item)) {
      return `header "${name}" has an invalid value`;
    }
  }
  return null;
}

// Env keys become argv entries passed to /usr/bin/env, so they must be plain
// shell-safe variable names, and values must not contain line breaks or NULs.
function validateEnv(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "'env' must be an object with string values";
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return `'env' key ${JSON.stringify(key)} is not a valid environment variable name`;
    }
    // Never include the value in the message: env values usually carry secrets.
    if (typeof item !== "string" || /[\r\n\0]/.test(item)) {
      return `env "${key}" has an invalid value`;
    }
  }
  return null;
}

// Returns an error message for an invalid spec, or null when the spec is valid.
export function validateMcpServerSpec(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Server spec must be a JSON object";
  }

  const record = value as Record<string, unknown>;
  const hasCommand = "command" in record;
  const hasUrl = "url" in record;

  if (hasCommand && hasUrl) {
    return "Server spec must have either 'command' or 'url', not both";
  }
  if (!hasCommand && !hasUrl) {
    return "Server spec must have a 'command' field (stdio) or a 'url' field (streamable HTTP)";
  }

  const allowedKeys = hasCommand ? STDIO_SPEC_KEYS : HTTP_SPEC_KEYS;
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    return `Unknown server spec fields: ${unknownKeys.join(", ")}`;
  }

  // Claude Desktop configs carry a "type" key. It does not affect how the spec
  // is interpreted (command vs url already determines the transport), so it is
  // only checked and then ignored.
  if (record["type"] !== undefined && record["type"] !== "stdio" && record["type"] !== "http") {
    return "'type' must be \"stdio\" or \"http\"";
  }

  if (hasCommand) {
    if (typeof record["command"] !== "string" || record["command"].trim() === "") {
      return "'command' must be a non-empty string";
    }
    return validateStringArray(record["args"], "args") ?? validateEnv(record["env"]);
  }

  if (typeof record["url"] !== "string") {
    return "'url' must be a string";
  }

  let url: URL;
  try {
    url = new URL(record["url"]);
  } catch {
    return "'url' must be a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "'url' must use the http or https scheme";
  }

  return validateHeaders(record["headers"]);
}

// Accepts either the spec object itself or a string containing JSON, because
// the settings page sends config values as strings. Throws on invalid input.
// The JSON.parse error is deliberately replaced: Node's message quotes a slice
// of the input, which may contain secrets.
export function parseMcpServerSpec(value: unknown): McpServerSpec {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("'server' is not valid JSON");
    }
  }

  const error = validateMcpServerSpec(parsed);
  if (error !== null) {
    throw new Error(error);
  }
  return parsed as McpServerSpec;
}

// MCP tools have no entrypoint and are always reported as async so the app
// refuses to batch them; the hybrid 30-second/async behaviour lives in the tool
// run handler.
export function toToolManifest(tool: Tool): ToolManifest {
  const properties = tool.inputSchema.properties ?? {};
  const required = tool.inputSchema.required ?? [];
  const parameters: Record<string, ToolParamSchema> = {};

  for (const [propertyName, rawProperty] of Object.entries(properties)) {
    const property =
      typeof rawProperty === "object" && rawProperty !== null && !Array.isArray(rawProperty)
        ? (rawProperty as Record<string, unknown>)
        : {};
    const description = typeof property["description"] === "string" ? property["description"] : "";
    const requiredSuffix = required.includes(propertyName) ? " (required)" : "";

    parameters[propertyName] = {
      type: typeof property["type"] === "string" ? property["type"] : "object",
      description: `${description}${requiredSuffix}`.trim(),
    };
  }

  return {
    name: tool.name,
    description: tool.description ?? "",
    entrypoint: "",
    async: true,
    parameters,
  };
}

export type TranslatedToolResult =
  | { success: true; output: string; files: TransportedFile[] }
  | { success: false; error: string };

function extensionFromMimeType(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (subtype) {
    case "":
      return "bin";
    case "jpeg":
      return "jpg";
    case "svg+xml":
      return "svg";
    default: {
      const sanitized = subtype.replace(/[^a-z0-9]/g, "");
      return sanitized.length > 0 ? sanitized : "bin";
    }
  }
}

function resourceFilename(uri: string, index: number): string {
  const pathPart = uri.split(/[?#]/)[0];
  const lastSegment = pathPart.slice(pathPart.lastIndexOf("/") + 1);
  // A filename of "." or ".." would point at a directory once the app writes it.
  if (lastSegment.length === 0 || lastSegment === "." || lastSegment === "..") {
    return `resource-${index}`;
  }
  return lastSegment;
}

// Turns an MCP call result into the shape the script path returns. Content
// kinds the app cannot represent (audio, resource links) are ignored.
export function translateCallToolResult(result: CallToolResult): TranslatedToolResult {
  const textParts: string[] = [];
  const files: TransportedFile[] = [];
  let imageCount = 0;
  let resourceCount = 0;

  for (const item of result.content) {
    if (item.type === "text") {
      textParts.push(item.text);
    } else if (item.type === "image") {
      imageCount++;
      files.push({
        filename: `image-${imageCount}.${extensionFromMimeType(item.mimeType)}`,
        data: item.data,
      });
    } else if (item.type === "resource") {
      resourceCount++;
      if ("text" in item.resource) {
        textParts.push(item.resource.text);
      } else if ("blob" in item.resource) {
        files.push({
          filename: resourceFilename(item.resource.uri, resourceCount),
          data: item.resource.blob,
        });
      }
    }
  }

  const output = textParts.join("\n");

  if (result.isError === true) {
    return { success: false, error: output.length > 0 ? output : "(no output)" };
  }

  return {
    success: true,
    output: output.length > 0 || files.length > 0 ? output : "(no output)",
    files,
  };
}

function readServerSpec(pluginName: string): McpServerSpec {
  const configPath = path.join(PLUGINS_DIR, pluginName, "config.json");
  const content = fs.readFileSync(configPath, "utf-8");
  let config: unknown;
  try {
    config = JSON.parse(content) as unknown;
  } catch {
    // The JSON.parse message quotes part of config.json, which can contain secrets.
    throw new Error(`Plugin "${pluginName}" has an invalid config.json`);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Plugin "${pluginName}" has an invalid config.json`);
  }

  const record = config as Record<string, unknown>;
  if (!("server" in record)) {
    throw new Error(`Plugin "${pluginName}" has no 'server' key in config.json`);
  }

  return parseMcpServerSpec(record["server"]);
}

function buildTrustedEnv(pluginName: string, uid: number, gid: number): Record<string, string> {
  const pluginDir = path.join(PLUGINS_DIR, pluginName);
  const uvCacheDir = `/cache/${pluginName}/uv`;
  fs.mkdirSync(uvCacheDir, { recursive: true });
  fs.chownSync(uvCacheDir, uid, gid);

  const baseEnv = buildScriptEnv(uvCacheDir, pluginDir);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["HOME"] = pluginDir;
  return env;
}

export interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Only the trusted environment is visible to the root setpriv process. The
// spec's variables are applied by /usr/bin/env after the privilege drop, so a
// plugin cannot influence the launcher with PATH or LD_PRELOAD.
export function buildStdioLaunch(
  spec: McpStdioServerSpec,
  uid: number,
  gid: number,
  trustedEnv: Record<string, string>,
): StdioLaunch {
  const envArgs = Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`);

  return {
    command: "/usr/bin/setpriv",
    args: [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      "--",
      "/usr/bin/env",
      "--",
      ...envArgs,
      spec.command,
      ...(spec.args ?? []),
    ],
    env: trustedEnv,
  };
}

function createTransport(pluginName: string, spec: McpServerSpec): Transport {
  if ("url" in spec) {
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: spec.headers === undefined ? undefined : { headers: spec.headers },
    });
  }

  const { uid, gid } = getPluginUserIds(pluginName);
  const pluginDir = path.join(PLUGINS_DIR, pluginName);

  // The SDK's stdio transport has no uid/gid option, so the child is started
  // through setpriv to drop root privileges to the plugin's own user.
  const launch = buildStdioLaunch(spec, uid, gid, buildTrustedEnv(pluginName, uid, gid));
  return new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: pluginDir,
    env: launch.env,
  });
}

async function closeClient(pluginName: string, client: Client): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stavrobot-plugin-runner] Error closing MCP client for "${pluginName}": ${message}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function closeTransport(pluginName: string, transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stavrobot-plugin-runner] Error closing MCP transport for "${pluginName}": ${message}`);
  }
}

// Closes a specific connection and removes it only if it is still the current
// one, so an abandoned attempt cannot disturb a newer connection.
async function closeEntry(pluginName: string, entry: ConnectionEntry): Promise<void> {
  if (connections.get(pluginName) === entry) {
    connections.delete(pluginName);
  }
  entry.connected = false;
  await closeClient(pluginName, entry.client);
  await closeTransport(pluginName, entry.transport);
}

async function openConnection(pluginName: string, attemptId: number): Promise<McpConnectionInfo> {
  const existing = connections.get(pluginName);
  if (existing !== undefined) {
    await closeEntry(pluginName, existing);
  }

  if (connectionAttempts.get(pluginName) !== attemptId) {
    throw new Error(`MCP connection attempt for plugin "${pluginName}" was abandoned`);
  }

  const spec = readServerSpec(pluginName);
  const client = new Client({ name: "stavrobot-plugin-runner", version: "1.0.0" });
  const transport = createTransport(pluginName, spec);

  // The entry only becomes connected once listTools has completed, so a
  // concurrent caller waits on the in-flight promise instead of seeing an
  // empty tool list.
  const entry: ConnectionEntry = {
    client,
    transport,
    remote: "url" in spec,
    tools: [],
    instructions: undefined,
    connected: false,
  };
  connections.set(pluginName, entry);

  transport.onclose = (): void => {
    const current = connections.get(pluginName);
    if (current !== undefined && current.client === client) {
      current.connected = false;
      console.log(`[stavrobot-plugin-runner] MCP connection for "${pluginName}" closed`);
    }
  };

  transport.onerror = (error: Error): void => {
    console.error(`[stavrobot-plugin-runner] MCP transport error for "${pluginName}": ${error.message}`);
  };

  try {
    await withTimeout(
      (async (): Promise<void> => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        if (connections.get(pluginName) !== entry) {
          throw new Error(`MCP connection attempt for plugin "${pluginName}" was abandoned`);
        }
        entry.tools = tools.map(toToolManifest);
        entry.instructions = client.getInstructions();
        entry.connected = true;
      })(),
      TOOL_TIMEOUT_MS,
      `Timed out connecting to MCP server for plugin "${pluginName}" after ${TOOL_TIMEOUT_MS / 1000} seconds`
    );
  } catch (error) {
    await closeEntry(pluginName, entry);
    throw error;
  }

  console.log(
    `[stavrobot-plugin-runner] Connected MCP server for "${pluginName}" with ${entry.tools.length} tool(s)`
  );
  return { tools: [...entry.tools], instructions: entry.instructions };
}

export async function connect(pluginName: string): Promise<McpConnectionInfo> {
  const existing = connections.get(pluginName);
  if (existing !== undefined && existing.connected) {
    return { tools: [...existing.tools], instructions: existing.instructions };
  }

  const pending = pendingConnections.get(pluginName);
  if (pending !== undefined) {
    return pending;
  }

  const attemptId = ++nextConnectionAttempt;
  connectionAttempts.set(pluginName, attemptId);

  const connecting = openConnection(pluginName, attemptId);
  pendingConnections.set(pluginName, connecting);

  try {
    return await connecting;
  } finally {
    if (pendingConnections.get(pluginName) === connecting) {
      pendingConnections.delete(pluginName);
    }
    if (connectionAttempts.get(pluginName) === attemptId) {
      connectionAttempts.delete(pluginName);
    }
  }
}

export function getCachedTools(pluginName: string): ToolManifest[] {
  const entry = connections.get(pluginName);
  return entry === undefined ? [] : [...entry.tools];
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// A dropped connection is worth reconnecting on the next use, but a protocol
// error or a cancelled request is not.
function isConnectionError(error: unknown): boolean {
  return (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.NotConnected ||
      error.code === SdkErrorCode.NotInitialized ||
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.SendFailed)
  );
}

// Streamable HTTP reports an expired session as a 404 without closing the
// transport, so the next call must rebuild the session instead of reusing it.
function isExpiredRemoteSession(error: unknown): boolean {
  return error instanceof SdkHttpError && error.status === 404;
}

export async function callTool(
  pluginName: string,
  toolName: string,
  args: Record<string, unknown>,
  options: McpCallOptions = {}
): Promise<CallToolResult> {
  await connect(pluginName);

  const entry = connections.get(pluginName);
  if (entry === undefined) {
    throw new Error(`MCP server for plugin "${pluginName}" is not connected`);
  }

  console.log(`[stavrobot-plugin-runner] Calling MCP tool: ${pluginName}/${toolName}`);
  try {
    return await entry.client.callTool(
      { name: toolName, arguments: args },
      { signal: options.signal, timeout: options.timeoutMs }
    );
  } catch (error) {
    if (isConnectionError(error) || (entry.remote && isExpiredRemoteSession(error))) {
      entry.connected = false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[stavrobot-plugin-runner] MCP connection for "${pluginName}" dropped during tool call: ${message}`
      );
    }
    throw error;
  }
}

export async function disconnect(pluginName: string): Promise<void> {
  // Cancel any in-flight attempt so it cannot publish a connection later.
  connectionAttempts.delete(pluginName);
  pendingConnections.delete(pluginName);

  const entry = connections.get(pluginName);
  if (entry === undefined) {
    return;
  }

  console.log(`[stavrobot-plugin-runner] Disconnecting MCP server for "${pluginName}"`);
  await closeEntry(pluginName, entry);
}
