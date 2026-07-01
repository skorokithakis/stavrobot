import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";

export const TOOL_TIMEOUT_MS = 30_000;
export const ASYNC_TIMEOUT_MS = 300_000; // 5 minutes for async scripts.
const APP_INTERNAL_URL = "http://app:3000/chat";
export const MAX_FILE_TRANSPORT_BYTES = 25 * 1024 * 1024; // 25MB

// Delays before each retry of postCallback, in milliseconds. The initial attempt
// is immediate and each entry here is one additional retry, so the whole array
// is consumed. The app may be briefly unreachable during a restart and there is
// no persistent outbox, so without these retries an async plugin tool result
// would be silently lost forever.
const CALLBACK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

// The plugins directory is needed to derive the plugin name from a cwd path.
const PLUGINS_DIR = "/plugins";

// appPassword is set by the main module after loading config. The setter is
// called once at startup before any requests are handled.
let appPassword: string | undefined;

export function setAppPassword(password: string): void {
  appPassword = password;
}

export interface ScriptResult {
  success: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
  spawnFailed?: boolean;
}

export interface TransportedFile {
  filename: string;
  data: string;
}

export function isTransportedFile(value: unknown): value is TransportedFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["filename"] === "string" && typeof record["data"] === "string";
}

// Remove a path if it is currently a symlink, so that subsequent writes
// create a regular file rather than following the link to an attacker-chosen
// target. Uses lstatSync (not statSync) because statSync follows symlinks and
// would defeat the purpose. ENOENT is silently ignored — the file simply
// doesn't exist yet and no guard is needed.
export function removeIfSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function mimeTypeFromFilename(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".m4a": return "audio/mp4";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

export async function postCallback(source: string, message: string, files?: TransportedFile[]): Promise<void> {
  console.log(`[stavrobot-plugin-runner] Posting callback from "${source}" to ${APP_INTERNAL_URL}`);

  const body: Record<string, unknown> = { source, message };
  if (files !== undefined && files.length > 0) {
    body.files = files.map((file) => ({
      data: file.data,
      filename: file.filename,
      mimeType: mimeTypeFromFilename(file.filename),
    }));
  }
  const credentials = Buffer.from(`:${appPassword}`).toString("base64");

  // postCallback is the boundary between the plugin-runner and the app: there is
  // no caller that can recover from a delivery failure, so we retry here on any
  // network error or non-2xx response before logging a final give-up error.
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const response = await fetch(APP_INTERNAL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${credentials}`,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        console.log(`[stavrobot-plugin-runner] Callback posted (attempt ${attempt}), status: ${response.status}`);
        return;
      }
      console.error(
        `[stavrobot-plugin-runner] Callback from "${source}" got non-2xx status ${response.status} on attempt ${attempt}`,
      );
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);
      console.error(`[stavrobot-plugin-runner] Callback from "${source}" failed on attempt ${attempt}: ${message_}`);
    }

    const delayIndex = attempt - 1;
    if (delayIndex >= CALLBACK_RETRY_DELAYS_MS.length) {
      console.error(
        `[stavrobot-plugin-runner] Giving up on callback from "${source}" after ${attempt} attempts`,
      );
      return;
    }
    const delayMs = CALLBACK_RETRY_DELAYS_MS[delayIndex];
    console.log(`[stavrobot-plugin-runner] Retrying callback from "${source}" in ${delayMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function runScript(
  entrypoint: string,
  cwd: string,
  uid: number,
  gid: number,
  stdin: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const pluginName = path.relative(PLUGINS_DIR, cwd).split(path.sep)[0];
  const uvCacheDir = `/cache/${pluginName}/uv`;
  const homeDir = `/cache/${pluginName}/home`;
  removeIfSymlink(uvCacheDir);
  fs.mkdirSync(uvCacheDir, { recursive: true });
  removeIfSymlink(homeDir);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.chmodSync(homeDir, 0o700);
  execFileSync("chown", ["-R", "-h", `${uid}:${gid}`, `/cache/${pluginName}`], { stdio: "pipe" });

  return new Promise<ScriptResult>((resolve) => {
    const child = spawn(entrypoint, [], {
      cwd,
      uid,
      gid,
      env: {
        PATH: process.env.PATH,
        UV_CACHE_DIR: uvCacheDir,
        UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
        REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
        HOME: homeDir,
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

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
        console.error(`[stavrobot-plugin-runner] Stdin error for ${entrypoint}: ${error.message}`);
      }
    });

    child.stdin.write(stdin);
    child.stdin.end();

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ success: false, output: "", error: `Failed to spawn script: ${error.message}`, spawnFailed: true });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          success: false,
          output: "",
          error: `Script timed out after ${timeoutMs / 1000} seconds`,
          timedOut: true,
        });
        return;
      }

      if (code !== 0) {
        const combinedOutput = [stderr, stdout].filter(Boolean).join("\n");
        resolve({ success: false, output: combinedOutput, error: combinedOutput });
        return;
      }

      resolve({ success: true, output: stdout });
    });
  });
}

// Scan pluginTempDir for top-level files, base64-encode them, and return the
// array. Returns an empty array if the directory doesn't exist or is empty.
// If the total size of all files exceeds MAX_FILE_TRANSPORT_BYTES, logs a
// warning and returns an empty array rather than a partial result.
export function scanPluginTempDir(pluginTempDir: string, bundleName: string): TransportedFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginTempDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const fileEntries = entries.filter((entry) => entry.isFile());
  if (fileEntries.length === 0) {
    return [];
  }

  let totalBytes = 0;
  for (const entry of fileEntries) {
    const filePath = path.join(pluginTempDir, entry.name);
    const stat = fs.statSync(filePath);
    totalBytes += stat.size;
  }

  if (totalBytes > MAX_FILE_TRANSPORT_BYTES) {
    console.warn(
      `[stavrobot-plugin-runner] Plugin "${bundleName}" produced ${totalBytes} bytes of files, exceeding the ${MAX_FILE_TRANSPORT_BYTES}-byte limit; skipping file transport`
    );
    return [];
  }

  return fileEntries.map((entry) => {
    const filePath = path.join(pluginTempDir, entry.name);
    const data = fs.readFileSync(filePath).toString("base64");
    return { filename: entry.name, data };
  });
}
