import fs from "fs";
import path from "path";

import { getPluginUserIds } from "./plugin-user.js";
import { removeIfSymlink } from "./script-runner.js";

export const PLUGINS_DIR = "/plugins";

export interface BundleManifest {
  name: string;
  description: string;
  // Consumed by the website build for the public plugin listing; not used by the runner.
  summary?: string;
  config?: Record<string, { description: string; required: boolean; default?: unknown }>;
  instructions?: string;
  init?: { entrypoint: string; async?: boolean };
}

interface ToolParamSchema {
  type: string;
  description: string;
}

export interface ToolManifest {
  name: string;
  description: string;
  entrypoint: string;
  async?: boolean;
  parameters: Record<string, ToolParamSchema>;
}

export interface LoadedBundle {
  bundleDir: string;
  manifest: BundleManifest;
  tools: LoadedTool[];
  permissions: string[];
}

export interface LoadedTool {
  toolDir: string;
  manifest: ToolManifest;
}

// In-memory registry, reloaded from disk on each request.
let bundles: LoadedBundle[] = [];

export function readJsonFile(filePath: string): unknown | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

// A bundle manifest has no entrypoint; a tool manifest does.
export function isBundleManifest(manifest: unknown): manifest is BundleManifest {
  const record = manifest as Record<string, unknown>;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof record["name"] !== "string" ||
    typeof record["description"] !== "string" ||
    "entrypoint" in manifest ||
    (record["instructions"] !== undefined && typeof record["instructions"] !== "string")
  ) {
    return false;
  }

  if (record["init"] !== undefined) {
    const init = record["init"];
    if (
      typeof init !== "object" ||
      init === null ||
      typeof (init as Record<string, unknown>)["entrypoint"] !== "string" ||
      ((init as Record<string, unknown>)["async"] !== undefined &&
        typeof (init as Record<string, unknown>)["async"] !== "boolean")
    ) {
      return false;
    }
  }

  return true;
}

function isToolManifest(manifest: unknown): manifest is ToolManifest {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof (manifest as Record<string, unknown>)["name"] !== "string" ||
    typeof (manifest as Record<string, unknown>)["description"] !== "string" ||
    typeof (manifest as Record<string, unknown>)["entrypoint"] !== "string"
  ) {
    return false;
  }

  const parameters = (manifest as Record<string, unknown>)["parameters"];
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    return false;
  }

  // Each entry must have a string "type" and string "description".
  for (const value of Object.values(parameters as Record<string, unknown>)) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>)["type"] !== "string" ||
      typeof (value as Record<string, unknown>)["description"] !== "string"
    ) {
      return false;
    }
  }

  return true;
}

// Read the permissions array from config.json. If config.json doesn't exist,
// has no permissions key, or the value is malformed (not an array of strings),
// write ["*"] to config.json and return it. This ensures all existing plugins
// get the default and the value is always valid when returned.
export function migratePermissions(bundleDir: string, pluginName: string): string[] {
  const configPath = path.join(bundleDir, "config.json");
  const rawConfig = readJsonFile(configPath);
  const configObject =
    typeof rawConfig === "object" && rawConfig !== null
      ? (rawConfig as Record<string, unknown>)
      : {};

  const rawPermissions = configObject["permissions"];
  const isValidPermissions =
    Array.isArray(rawPermissions) &&
    rawPermissions.every((item) => typeof item === "string");

  if (isValidPermissions) {
    return rawPermissions as string[];
  }

  // Write the default permissions. Existing config keys are preserved.
  const merged = { ...configObject, permissions: ["*"] };
  removeIfSymlink(configPath);
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));

  // Fix ownership so the plugin user can read the file.
  try {
    const { uid, gid } = getPluginUserIds(pluginName);
    fs.chownSync(configPath, uid, gid);
  } catch (error) {
    // The plugin user may not exist yet during early startup; log and continue.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[stavrobot-plugin-runner] Could not chown config.json for "${pluginName}" during permissions migration: ${message}`
    );
  }

  console.log(
    `[stavrobot-plugin-runner] Wrote default permissions ["*"] to config.json for plugin "${pluginName}"`
  );
  return ["*"];
}

export function loadBundles(): void {
  let topLevelEntries: string[];
  try {
    topLevelEntries = fs.readdirSync(PLUGINS_DIR);
  } catch {
    console.warn("[stavrobot-plugin-runner] Plugins directory not found; no bundles loaded");
    bundles = [];
    return;
  }

  const loadedBundles: LoadedBundle[] = [];

  for (const bundleDirName of topLevelEntries) {
    const bundleDir = path.join(PLUGINS_DIR, bundleDirName);
    const stat = fs.statSync(bundleDir);
    if (!stat.isDirectory()) {
      continue;
    }

    const bundleManifestPath = path.join(bundleDir, "manifest.json");
    const rawBundleManifest = readJsonFile(bundleManifestPath);

    if (!isBundleManifest(rawBundleManifest)) {
      console.warn(`[stavrobot-plugin-runner] Skipping ${bundleDirName}: missing or invalid bundle manifest.json`);
      continue;
    }

    const bundleName = rawBundleManifest.name;

    if (bundleName !== bundleDirName) {
      console.warn(
        `[stavrobot-plugin-runner] Skipping "${bundleDirName}": manifest name "${bundleName}" does not match directory name`
      );
      continue;
    }

    // Scan tool subdirectories within this bundle.
    let toolDirEntries: string[];
    try {
      toolDirEntries = fs.readdirSync(bundleDir);
    } catch {
      console.warn(`[stavrobot-plugin-runner] Cannot read bundle directory ${bundleDirName}`);
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
        // Only warn if the manifest looks like a tool (has name and entrypoint),
        // so we don't spam warnings for non-tool subdirectories like node_modules.
        if (
          typeof rawToolManifest === "object" &&
          rawToolManifest !== null &&
          typeof (rawToolManifest as Record<string, unknown>)["name"] === "string" &&
          typeof (rawToolManifest as Record<string, unknown>)["entrypoint"] === "string"
        ) {
          console.warn(
            `[stavrobot-plugin-runner] Skipping tool "${(rawToolManifest as Record<string, unknown>)["name"] as string}" in bundle "${bundleName}": manifest.json failed validation (missing or invalid "parameters")`
          );
        }
        continue;
      }

      if (rawToolManifest.name !== toolDirName) {
        // Skip silently — consistent with skipping non-tool subdirectories.
        continue;
      }

      tools.push({ toolDir, manifest: rawToolManifest });
    }

    // Ensure config.json has a permissions key. If missing, write the default
    // ["*"] so all existing plugins are treated as fully enabled. This runs on
    // every loadBundles() call, which is safe because existing values win.
    const permissions = migratePermissions(bundleDir, bundleName);

    loadedBundles.push({ bundleDir, manifest: rawBundleManifest, tools, permissions });
    console.log(
      `[stavrobot-plugin-runner] Loaded bundle "${bundleName}" with ${tools.length} tool(s)`
    );
  }

  bundles = loadedBundles;
}

export function getBundles(): LoadedBundle[] {
  return bundles;
}

export function findBundle(bundleName: string): LoadedBundle | null {
  return bundles.find((bundle) => bundle.manifest.name === bundleName) ?? null;
}

export function findTool(bundle: LoadedBundle, toolName: string): LoadedTool | null {
  return bundle.tools.find((tool) => tool.manifest.name === toolName) ?? null;
}
