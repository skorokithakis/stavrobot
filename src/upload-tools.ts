import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".xml", ".html", ".css", ".js", ".ts", ".py", ".sh", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log", ".sql", ".env"]);

const MANAGE_UPLOADS_HELP_TEXT = `manage_uploads: read or delete uploaded files.

Actions:
- read: read the contents of an uploaded file. Parameters: path (required).
  - Text files (txt, md, csv, json, xml, html, css, js, ts, py, sh, yml, yaml, toml, ini, cfg, log, sql, env) and files with no extension are returned as text.
  - Images (jpg, jpeg, png, gif, webp) are returned as image content for visual inspection.
  - Other binary formats (e.g. pdf, zip) cannot be read directly.
- delete: delete an uploaded file. Parameters: path (required).
- help: show this help text.

Constraints:
- The path must be the full path to the file inside ${TEMP_ATTACHMENTS_DIR}.
- Files must be inside the uploads directory; paths outside it are rejected.`;

function inferMimeType(extension: string): string {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function validatePath(filePath: string): string | null {
  // Normalize to resolve any .. or . segments, then check the prefix.
  const normalized = path.normalize(filePath);
  const uploadsPrefix = TEMP_ATTACHMENTS_DIR.endsWith("/") ? TEMP_ATTACHMENTS_DIR : `${TEMP_ATTACHMENTS_DIR}/`;
  if (!normalized.startsWith(uploadsPrefix)) {
    return `Invalid path: must be inside ${TEMP_ATTACHMENTS_DIR}.`;
  }
  return null;
}

export function createManageUploadsTool(): AgentTool {
  return {
    name: "manage_uploads",
    label: "Manage uploads",
    description: "Read or delete uploaded files. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("read"),
        Type.Literal("delete"),
        Type.Literal("help"),
      ], { description: "Action to perform: read, delete, or help." }),
      path: Type.Optional(Type.String({ description: "The full path to the uploaded file, e.g. /tmp/uploads/upload-abc123.txt. Required for read and delete." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        path?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return toolSuccess(MANAGE_UPLOADS_HELP_TEXT);
      }

      if (action === "read") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for read.");
        }

        const filePath = raw.path;

        const validationError = validatePath(filePath);
        if (validationError !== null) {
          log.warn("[stavrobot] manage_uploads read validation failed:", validationError);
          return toolError(validationError);
        }

        const extension = path.extname(filePath).toLowerCase();

        if (IMAGE_EXTENSIONS.has(extension)) {
          log.debug("[stavrobot] manage_uploads read: classified as image:", extension);
          let buffer: Buffer;
          try {
            buffer = await fs.readFile(filePath);
          } catch (error) {
            const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
            if (!isNotFound) {
              throw error;
            }
            const message = `File not found: ${filePath}`;
            log.warn("[stavrobot] manage_uploads read error:", message);
            return toolError(message);
          }
          const base64Data = buffer.toString("base64");
          const mimeType = inferMimeType(extension);
          const imageContent: ImageContent = { type: "image", data: base64Data, mimeType };
          return {
            content: [imageContent],
            details: { message: `Read image (${mimeType}) of ${buffer.length} bytes from ${filePath}.` },
          };
        }

        if (TEXT_EXTENSIONS.has(extension) || extension === "") {
          log.debug("[stavrobot] manage_uploads read: classified as text:", extension || "(no extension)");
          let contents: string;
          try {
            contents = await fs.readFile(filePath, "utf-8");
          } catch (error) {
            const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
            if (!isNotFound) {
              throw error;
            }
            const message = `File not found: ${filePath}`;
            log.warn("[stavrobot] manage_uploads read error:", message);
            return toolError(message);
          }
          return toolSuccess(contents);
        }

        const message = `Cannot read binary file directly. The file is stored at ${filePath} with type ${extension}.`;
        log.debug("[stavrobot] manage_uploads read: classified as unsupported binary:", extension);
        return toolSuccess(message);
      }

      if (action === "delete") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for delete.");
        }

        const filePath = raw.path;

        const validationError = validatePath(filePath);
        if (validationError !== null) {
          log.warn("[stavrobot] manage_uploads delete validation failed:", validationError);
          return toolError(validationError);
        }

        try {
          await fs.unlink(filePath);
        } catch (error) {
          const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
          if (!isNotFound) {
            throw error;
          }
          const message = `File not found: ${filePath}`;
          log.warn("[stavrobot] manage_uploads delete error:", message);
          return toolError(message);
        }

        return toolSuccess(`File deleted: ${filePath}`);
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: read, delete, help.`);
    },
  };
}
