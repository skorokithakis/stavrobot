import http from "http";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";

const TOOLS_DIR = "/tools";
const TOOL_TIMEOUT_MS = 30_000;
const INSTRUCTIONS_MAX_LENGTH = 5000;

let toolRunnerUid: number | undefined;
let toolRunnerGid: number | undefined;

function getToolRunnerIds(): { uid: number; gid: number } {
  if (toolRunnerUid === undefined || toolRunnerGid === undefined) {
    try {
      toolRunnerUid = parseInt(execSync("id -u toolrunner").toString().trim(), 10);
      toolRunnerGid = parseInt(execSync("id -g toolrunner").toString().trim(), 10);
    } catch {
      throw new Error("toolrunner user not found — requires the Docker container environment");
    }
  }
  return { uid: toolRunnerUid, gid: toolRunnerGid };
}

interface BundleManifest {
  name: string;
  description: string;
  instructions?: string;
}

interface ToolManifest {
  name: string;
  description: string;
  entrypoint: string;
  [key: string]: unknown;
}

// A bundle manifest has no entrypoint; a tool manifest does.
function isBundleManifest(manifest: unknown): manifest is BundleManifest {
  const record = manifest as Record<string, unknown>;
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    typeof record["name"] === "string" &&
    typeof record["description"] === "string" &&
    !("entrypoint" in manifest) &&
    (record["instructions"] === undefined || typeof record["instructions"] === "string")
  );
}

function isToolManifest(manifest: unknown): manifest is ToolManifest {
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    typeof (manifest as Record<string, unknown>)["name"] === "string" &&
    typeof (manifest as Record<string, unknown>)["description"] === "string" &&
    typeof (manifest as Record<string, unknown>)["entrypoint"] === "string"
  );
}

interface LoadedBundle {
  bundleDir: string;
  manifest: BundleManifest;
  tools: LoadedTool[];
}

interface LoadedTool {
  toolDir: string;
  manifest: ToolManifest;
}

// In-memory registry, reloaded from disk on each request.
let bundles: LoadedBundle[] = [];

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

// Migrate an old-style tool directory (manifest.json with entrypoint at the top level)
// into the bundle structure. Idempotent: if the tool subdirectory already exists and
// the top-level manifest has no entrypoint, this is a no-op.
function migrateOldStyleTool(bundleDir: string): void {
  const topLevelManifestPath = path.join(bundleDir, "manifest.json");
  const rawManifest = readJsonFile(topLevelManifestPath);

  if (!isToolManifest(rawManifest)) {
    // Already a bundle manifest or unreadable — nothing to migrate.
    return;
  }

  const toolName = rawManifest.name;

  // Reject names that could escape the bundle directory via path traversal. A valid
  // tool name is a single path component with no separators and no dot-dot segment.
  if (toolName === "" || toolName === "." || toolName.includes("..") || toolName.includes("/") || toolName.includes("\\")) {
    console.error(
      `[stavrobot-tool-runner] Skipping migration of "${bundleDir}": tool name "${toolName}" contains path separators or is a reserved name`
    );
    return;
  }

  const toolSubdir = path.join(bundleDir, toolName);

  if (!fs.existsSync(toolSubdir)) {
    fs.mkdirSync(toolSubdir);
  }

  // Move all existing entries except manifest.json into the tool subdirectory. We
  // leave manifest.json in place until after we have copied it into the subdirectory,
  // so that a crash at any point before the final overwrite leaves the top-level
  // manifest.json intact and migration will be retried on the next startup.
  const entries = fs.readdirSync(bundleDir);
  for (const entry of entries) {
    if (entry === toolName || entry === "manifest.json") {
      continue;
    }
    fs.renameSync(path.join(bundleDir, entry), path.join(toolSubdir, entry));
  }

  // Copy manifest.json into the tool subdirectory so the tool has its own manifest.
  // We copy rather than move because we are about to overwrite the source in the next
  // step, and a copy keeps the top-level manifest.json valid until that final write.
  fs.copyFileSync(topLevelManifestPath, path.join(toolSubdir, "manifest.json"));

  // Overwrite the top-level manifest.json with the bundle manifest. This is the last
  // step: once it completes, migration is done. If the process crashes before this
  // write, the top-level manifest.json still has an entrypoint field and migration
  // will be retried on the next startup.
  const bundleManifest: BundleManifest = {
    name: rawManifest.name,
    description: rawManifest.description,
  };
  fs.writeFileSync(topLevelManifestPath, JSON.stringify(bundleManifest, null, 2));

  console.log(`[stavrobot-tool-runner] Migrated old-style tool "${toolName}" to bundle structure`);
}

function migrateAllOldStyleTools(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(TOOLS_DIR);
  } catch {
    // Tools directory doesn't exist yet; nothing to migrate.
    return;
  }

  for (const entry of entries) {
    const bundleDir = path.join(TOOLS_DIR, entry);
    const stat = fs.statSync(bundleDir);
    if (!stat.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(bundleDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      console.warn(`[stavrobot-tool-runner] Skipping ${entry}: no manifest.json found`);
      continue;
    }

    migrateOldStyleTool(bundleDir);
  }
}

function loadBundles(): void {
  let topLevelEntries: string[];
  try {
    topLevelEntries = fs.readdirSync(TOOLS_DIR);
  } catch {
    console.warn("[stavrobot-tool-runner] Tools directory not found; no bundles loaded");
    bundles = [];
    return;
  }

  const loadedBundles: LoadedBundle[] = [];

  for (const bundleDirName of topLevelEntries) {
    const bundleDir = path.join(TOOLS_DIR, bundleDirName);
    const stat = fs.statSync(bundleDir);
    if (!stat.isDirectory()) {
      continue;
    }

    const bundleManifestPath = path.join(bundleDir, "manifest.json");
    const rawBundleManifest = readJsonFile(bundleManifestPath);

    if (!isBundleManifest(rawBundleManifest)) {
      console.warn(`[stavrobot-tool-runner] Skipping ${bundleDirName}: missing or invalid bundle manifest.json`);
      continue;
    }

    const bundleName = rawBundleManifest.name;

    if (bundleName !== bundleDirName) {
      console.warn(
        `[stavrobot-tool-runner] Skipping "${bundleDirName}": manifest name "${bundleName}" does not match directory name`
      );
      continue;
    }

    // Scan tool subdirectories within this bundle.
    let toolDirEntries: string[];
    try {
      toolDirEntries = fs.readdirSync(bundleDir);
    } catch {
      console.warn(`[stavrobot-tool-runner] Cannot read bundle directory ${bundleDirName}`);
      continue;
    }

    const tools: LoadedTool[] = [];
    for (const toolDirName of toolDirEntries) {
      const toolDir = path.join(bundleDir, toolDirName);
      const toolStat = fs.statSync(toolDir);
      if (!toolStat.isDirectory()) {
        continue;
      }

      const toolManifestPath = path.join(toolDir, "manifest.json");
      const rawToolManifest = readJsonFile(toolManifestPath);

      if (!isToolManifest(rawToolManifest)) {
        // Could be a non-tool subdirectory or a mismatched name; skip silently.
        continue;
      }

      if (rawToolManifest.name !== toolDirName) {
        // Skip silently — consistent with skipping non-tool subdirectories.
        continue;
      }

      tools.push({ toolDir, manifest: rawToolManifest });
    }

    loadedBundles.push({ bundleDir, manifest: rawBundleManifest, tools });
    console.log(
      `[stavrobot-tool-runner] Loaded bundle "${bundleName}" with ${tools.length} tool(s)`
    );
  }

  bundles = loadedBundles;
}

function findBundle(bundleName: string): LoadedBundle | null {
  return bundles.find((bundle) => bundle.manifest.name === bundleName) ?? null;
}

function findTool(bundle: LoadedBundle, toolName: string): LoadedTool | null {
  return bundle.tools.find((tool) => tool.manifest.name === toolName) ?? null;
}

function reloadBundles(): void {
  migrateAllOldStyleTools();
  loadBundles();
}

function handleListBundles(response: http.ServerResponse): void {
  reloadBundles();

  const result = bundles.map((bundle) => ({
    name: bundle.manifest.name,
    description: bundle.manifest.description,
  }));

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ bundles: result }));
}

function handleGetBundle(bundleName: string, response: http.ServerResponse): void {
  reloadBundles();

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
  reloadBundles();

  const bundle = findBundle(bundleName);
  if (bundle === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Bundle not found" }));
    return;
  }

  const tool = findTool(bundle, toolName);
  if (tool === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Tool not found" }));
    return;
  }

  const body = await readRequestBody(request);
  const { toolDir, manifest } = tool;

  console.log(
    `[stavrobot-tool-runner] Running tool: ${bundleName}/${toolName}, entrypoint: ${manifest.entrypoint}`
  );

  const entrypoint = path.join(toolDir, manifest.entrypoint);
  const { uid, gid } = getToolRunnerIds();

  await new Promise<void>((resolve) => {
    const child = spawn(entrypoint, [], {
      cwd: toolDir,
      uid,
      gid,
      env: {
        PATH: process.env.PATH,
        UV_CACHE_DIR: "/tmp/uv-cache",
        UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TOOL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.stdin.on("error", (error: Error) => {
      // EPIPE means the child exited before reading stdin. This is not fatal
      // since the child's exit handler will report the actual error.
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error(
          `[stavrobot-tool-runner] Tool ${bundleName}/${toolName} stdin error: ${error.message}`
        );
      }
    });

    child.stdin.write(body);
    child.stdin.end();

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      console.error(
        `[stavrobot-tool-runner] Tool ${bundleName}/${toolName} failed to spawn: ${error.message}`
      );
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ success: false, error: `Failed to spawn tool: ${error.message}` })
      );
      resolve();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        console.error(
          `[stavrobot-tool-runner] Tool ${bundleName}/${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`
        );
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, error: "Tool execution timed out" }));
        resolve();
        return;
      }

      if (code !== 0) {
        // Include both streams: the script may write error details to stdout
        // (e.g., JSON error objects) while uv or other tooling writes to stderr.
        const error = [stderr, stdout].filter(Boolean).join("\n");
        console.error(
          `[stavrobot-tool-runner] Tool ${bundleName}/${toolName} exited with code ${code}: ${error}`
        );
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, error }));
        resolve();
        return;
      }

      let output: unknown;
      try {
        output = JSON.parse(stdout);
      } catch {
        output = stdout;
      }

      console.log(`[stavrobot-tool-runner] Tool ${bundleName}/${toolName} completed successfully`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, output }));
      resolve();
    });
  });
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = request.url ?? "/";
  const method = request.method ?? "GET";

  console.log(`[stavrobot-tool-runner] ${method} ${url}`);

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

    const runToolMatch = url.match(/^\/bundles\/([^/]+)\/tools\/([^/]+)\/run$/);
    if (method === "POST" && runToolMatch !== null) {
      await handleRunTool(runToolMatch[1], runToolMatch[2], request, response);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("[stavrobot-tool-runner] Error handling request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function main(): Promise<void> {
  migrateAllOldStyleTools();
  loadBundles();

  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    handleRequest(request, response);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  server.listen(port, () => {
    console.log(`[stavrobot-tool-runner] Server listening on port ${port}`);
  });
}

main();
