import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { UPLOADS_DIR } from "./uploads.js";

function validatePath(filePath: string): string | null {
  // Normalize to resolve any .. or . segments, then check the prefix.
  const normalized = path.normalize(filePath);
  const uploadsPrefix = UPLOADS_DIR.endsWith("/") ? UPLOADS_DIR : `${UPLOADS_DIR}/`;
  if (!normalized.startsWith(uploadsPrefix)) {
    return `Invalid path: must be inside ${UPLOADS_DIR}.`;
  }
  return null;
}

export function createReadUploadTool(): AgentTool {
  return {
    name: "read_upload",
    label: "Read upload",
    description: "Read the text contents of an uploaded file by its full path.",
    parameters: Type.Object({
      path: Type.String({ description: "The full path to the uploaded file, e.g. /tmp/uploads/upload-abc123.txt." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { path: filePath } = params as { path: string };

      console.log("[stavrobot] read_upload called:", filePath);

      const validationError = validatePath(filePath);
      if (validationError !== null) {
        console.warn("[stavrobot] read_upload validation failed:", validationError);
        return {
          content: [{ type: "text" as const, text: validationError }],
          details: { message: validationError },
        };
      }

      let contents: string;
      try {
        contents = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          throw error;
        }
        const message = `File not found: ${filePath}`;
        console.warn("[stavrobot] read_upload error:", message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      console.log("[stavrobot] read_upload result: read", contents.length, "characters from", filePath);

      return {
        content: [{ type: "text" as const, text: contents }],
        details: { message: `Read ${contents.length} characters from ${filePath}.` },
      };
    },
  };
}

export function createDeleteUploadTool(): AgentTool {
  return {
    name: "delete_upload",
    label: "Delete upload",
    description: "Delete an uploaded file by its full path.",
    parameters: Type.Object({
      path: Type.String({ description: "The full path to the uploaded file, e.g. /tmp/uploads/upload-abc123.txt." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { path: filePath } = params as { path: string };

      console.log("[stavrobot] delete_upload called:", filePath);

      const validationError = validatePath(filePath);
      if (validationError !== null) {
        console.warn("[stavrobot] delete_upload validation failed:", validationError);
        return {
          content: [{ type: "text" as const, text: validationError }],
          details: { message: validationError },
        };
      }

      try {
        await fs.unlink(filePath);
      } catch (error) {
        const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          throw error;
        }
        const message = `File not found: ${filePath}`;
        console.warn("[stavrobot] delete_upload error:", message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const message = `File deleted: ${filePath}`;
      console.log("[stavrobot] delete_upload result:", message);

      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}
