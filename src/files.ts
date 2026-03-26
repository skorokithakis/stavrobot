import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";

const FILES_DIR = path.join(TEMP_ATTACHMENTS_DIR, "files");

const HELP_TEXT = `manage_files: manage files in a temporary directory (${FILES_DIR}).

Actions:
- write: write content to a file. Parameters: filename (required), content (required), encoding ("utf-8" default or "base64"). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- read: read a file's content as utf-8 text. Parameters: filename (required). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- search: search for lines matching a pattern. Parameters: filename (required), pattern (required), regex (optional boolean, default false). Returns matching lines with line numbers. Capped at 100 results.
- read_lines: read a range of lines. Parameters: filename (required), from (required, 1-indexed), to (required, 1-indexed, inclusive). Returns lines with line number prefixes and total line count.
- write_lines: replace a range of lines. Parameters: filename (required), from (required, 1-indexed), to (required, 1-indexed, inclusive), content (required). Splice semantics: from > to inserts before line from without removing; empty content deletes the range. Returns new total line count.
- list: list all files in the directory. Returns absolute paths, one per line.
- delete: delete a file. Parameters: filename (required). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- copy: copy a file. Parameters: source (required), destination (required). Returns the absolute destination path.
- move: move or rename a file. Parameters: source (required), destination (required). Returns the absolute destination path.
- help: show this help text.

Constraints:
- Flat filenames must not contain "/" or "\\" (no subdirectories). Absolute paths must be under ${TEMP_ATTACHMENTS_DIR}.
- Files are ephemeral. They live in ${FILES_DIR} and may be deleted automatically when passed as attachmentPath to send_signal_message or send_telegram_message.
- To send a file as an attachment, pass its absolute path (returned by write or list) as the attachmentPath parameter to send_signal_message or send_telegram_message.
- No size limits are enforced.`;

function validateFilename(filename: string): string | null {
  if (filename.includes("/") || filename.includes("\\")) {
    return "Error: filename must not contain path separators ('/' or '\\\\').";
  }
  return null;
}

// Returns the resolved absolute path, or an error string if the input is invalid.
// Flat filenames resolve to FILES_DIR; absolute paths must be under TEMP_ATTACHMENTS_DIR.
function resolvePath(filename: string): { filePath: string } | { error: string } {
  if (path.isAbsolute(filename)) {
    const resolved = path.resolve(filename);
    if (!resolved.startsWith(TEMP_ATTACHMENTS_DIR + path.sep) && resolved !== TEMP_ATTACHMENTS_DIR) {
      return { error: `Error: path must be under ${TEMP_ATTACHMENTS_DIR}.` };
    }
    return { filePath: resolved };
  }
  const filenameError = validateFilename(filename);
  if (filenameError !== null) {
    return { error: filenameError };
  }
  return { filePath: path.join(FILES_DIR, filename) };
}

const MAX_SEARCH_RESULTS = 100;

export function createManageFilesTool(): AgentTool {
  return {
    name: "manage_files",
    label: "Manage files",
    description: "Create and manage temporary files. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("search"),
        Type.Literal("read_lines"),
        Type.Literal("write_lines"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("copy"),
        Type.Literal("move"),
        Type.Literal("help"),
      ], { description: "Action to perform: write, read, search, read_lines, write_lines, list, delete, copy, move, or help." }),
      filename: Type.Optional(Type.String({ description: "Flat filename (no path separators) resolved to the files directory, or an absolute path under TEMP_ATTACHMENTS_DIR. Required for write, read, search, read_lines, write_lines, and delete." })),
      content: Type.Optional(Type.String({ description: "File content. Required for write. For write_lines, the replacement text (may be empty to delete lines)." })),
      encoding: Type.Optional(Type.String({ description: "Encoding for write: 'utf-8' (default) or 'base64'." })),
      pattern: Type.Optional(Type.String({ description: "Search pattern. Required for search. Treated as a substring by default; set regex to true for a regular expression." })),
      regex: Type.Optional(Type.Boolean({ description: "If true, treat pattern as a regular expression. Default false." })),
      from: Type.Optional(Type.Number({ description: "Starting line number (1-indexed, inclusive). Required for read_lines and write_lines." })),
      to: Type.Optional(Type.Number({ description: "Ending line number (1-indexed, inclusive). Required for read_lines and write_lines." })),
      source: Type.Optional(Type.String({ description: "Source file path. Required for copy and move. Flat filename or absolute path under TEMP_ATTACHMENTS_DIR." })),
      destination: Type.Optional(Type.String({ description: "Destination file path. Required for copy and move. Flat filename or absolute path under TEMP_ATTACHMENTS_DIR." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        filename?: string;
        content?: string;
        encoding?: string;
        pattern?: string;
        regex?: boolean;
        from?: number;
        to?: number;
        source?: string;
        destination?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return toolSuccess(HELP_TEXT);
      }

      if (action === "list") {
        let filenames: string[];
        try {
          filenames = await fs.readdir(FILES_DIR);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            filenames = [];
          } else {
            throw error;
          }
        }
        const absolutePaths = filenames.map((name) => path.join(FILES_DIR, name));
        const result = absolutePaths.join("\n");
        log.debug(`[stavrobot] manage_files list: ${filenames.length} file(s)`);
        return toolSuccess(result);
      }

      if (action === "write") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for write.");
        }
        if (raw.content === undefined) {
          return toolError("Error: content is required for write.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        const encoding = raw.encoding ?? "utf-8";
        if (encoding === "base64") {
          const buffer = Buffer.from(raw.content, "base64");
          await fs.writeFile(filePath, buffer);
        } else {
          await fs.writeFile(filePath, raw.content, "utf-8");
        }

        log.debug(`[stavrobot] manage_files write: ${filePath}`);
        return toolSuccess(filePath);
      }

      if (action === "read") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for read.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;

        const fileContent = await fs.readFile(filePath, "utf-8");
        log.debug(`[stavrobot] manage_files read: ${filePath} (${fileContent.length} chars)`);
        return toolSuccess(fileContent);
      }

      if (action === "search") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for search.");
        }
        if (raw.pattern === undefined || raw.pattern === "") {
          return toolError("Error: pattern is required for search.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;

        let regexp: RegExp | null = null;
        if (raw.regex === true) {
          try {
            regexp = new RegExp(raw.pattern);
          } catch {
            return toolError(`Error: invalid regular expression: ${raw.pattern}`);
          }
        }

        const fileContent = await fs.readFile(filePath, "utf-8");
        const lines = fileContent.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "" && fileContent.endsWith("\n")) {
          lines.pop();
        }
        const matches: string[] = [];
        let totalMatches = 0;

        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const matched = regexp !== null ? regexp.test(line) : line.includes(raw.pattern);
          if (matched) {
            totalMatches++;
            if (matches.length < MAX_SEARCH_RESULTS) {
              matches.push(`${index + 1}: ${line}`);
            }
          }
        }

        if (totalMatches === 0) {
          return toolSuccess("No matches found.");
        }

        let result = matches.join("\n");
        if (totalMatches > MAX_SEARCH_RESULTS) {
          result += `\n... (showing ${MAX_SEARCH_RESULTS} of ${totalMatches} matches)`;
        }

        log.debug(`[stavrobot] manage_files search: ${filePath} pattern="${raw.pattern}" matches=${totalMatches}`);
        return toolSuccess(result);
      }

      if (action === "read_lines") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for read_lines.");
        }
        if (raw.from === undefined) {
          return toolError("Error: from is required for read_lines.");
        }
        if (!Number.isInteger(raw.from) || raw.from < 1) {
          return toolError("Error: from must be an integer >= 1 for read_lines.");
        }
        if (raw.to === undefined) {
          return toolError("Error: to is required for read_lines.");
        }
        if (!Number.isInteger(raw.to)) {
          return toolError("Error: to must be an integer for read_lines.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;

        const fileContent = await fs.readFile(filePath, "utf-8");
        const lines = fileContent.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "" && fileContent.endsWith("\n")) {
          lines.pop();
        }
        const totalLines = lines.length;

        const fromClamped = Math.max(1, raw.from);
        const toClamped = Math.min(totalLines, raw.to);

        if (fromClamped > totalLines) {
          log.debug(`[stavrobot] manage_files read_lines: ${filePath} from=${raw.from} beyond EOF (${totalLines} lines)`);
          return toolSuccess(`(lines ${raw.from}-${raw.to} of ${totalLines} total)`);
        }

        const selectedLines = lines.slice(fromClamped - 1, toClamped);
        const numbered = selectedLines.map((line, index) => `${fromClamped + index}: ${line}`);
        const result = numbered.join("\n") + `\n(lines ${fromClamped}-${toClamped} of ${totalLines} total)`;

        log.debug(`[stavrobot] manage_files read_lines: ${filePath} lines ${fromClamped}-${toClamped} of ${totalLines}`);
        return toolSuccess(result);
      }

      if (action === "write_lines") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for write_lines.");
        }
        if (raw.from === undefined) {
          return toolError("Error: from is required for write_lines.");
        }
        if (!Number.isInteger(raw.from) || raw.from < 1) {
          return toolError("Error: from must be an integer >= 1 for write_lines.");
        }
        if (raw.to === undefined) {
          return toolError("Error: to is required for write_lines.");
        }
        if (!Number.isInteger(raw.to)) {
          return toolError("Error: to must be an integer for write_lines.");
        }
        if (raw.content === undefined) {
          return toolError("Error: content is required for write_lines.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;

        const fileContent = await fs.readFile(filePath, "utf-8");
        const hadTrailingNewline = fileContent.endsWith("\n");
        const lines = fileContent.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "" && hadTrailingNewline) {
          lines.pop();
        }

        const from = Math.max(1, raw.from);
        const newLines = raw.content === "" ? [] : raw.content.split("\n");
        const spliceStart = from - 1;
        // When from > to, this is an insert: deleteCount is 0, nothing is removed.
        const deleteCount = Math.max(0, raw.to - from + 1);
        lines.splice(spliceStart, deleteCount, ...newLines);

        const output = hadTrailingNewline ? lines.join("\n") + "\n" : lines.join("\n");
        await fs.writeFile(filePath, output, "utf-8");

        log.debug(`[stavrobot] manage_files write_lines: ${filePath} replaced lines ${raw.from}-${raw.to}, new total=${lines.length}`);
        return toolSuccess(`Done. New total line count: ${lines.length}.`);
      }

      if (action === "delete") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for delete.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;
        await fs.unlink(filePath);
        const successMessage = `File deleted: ${filePath}`;
        log.debug(`[stavrobot] manage_files delete: ${filePath}`);
        return toolSuccess(successMessage);
      }

      if (action === "copy") {
        if (raw.source === undefined || raw.source.trim() === "") {
          return toolError("Error: source is required for copy.");
        }
        if (raw.destination === undefined || raw.destination.trim() === "") {
          return toolError("Error: destination is required for copy.");
        }

        const resolvedSource = resolvePath(raw.source);
        if ("error" in resolvedSource) {
          return toolError(resolvedSource.error);
        }
        const resolvedDestination = resolvePath(raw.destination);
        if ("error" in resolvedDestination) {
          return toolError(resolvedDestination.error);
        }

        await fs.mkdir(path.dirname(resolvedDestination.filePath), { recursive: true });
        await fs.copyFile(resolvedSource.filePath, resolvedDestination.filePath);

        log.debug(`[stavrobot] manage_files copy: ${resolvedSource.filePath} -> ${resolvedDestination.filePath}`);
        return toolSuccess(resolvedDestination.filePath);
      }

      if (action === "move") {
        if (raw.source === undefined || raw.source.trim() === "") {
          return toolError("Error: source is required for move.");
        }
        if (raw.destination === undefined || raw.destination.trim() === "") {
          return toolError("Error: destination is required for move.");
        }

        const resolvedSource = resolvePath(raw.source);
        if ("error" in resolvedSource) {
          return toolError(resolvedSource.error);
        }
        const resolvedDestination = resolvePath(raw.destination);
        if ("error" in resolvedDestination) {
          return toolError(resolvedDestination.error);
        }

        await fs.mkdir(path.dirname(resolvedDestination.filePath), { recursive: true });
        await fs.rename(resolvedSource.filePath, resolvedDestination.filePath);

        log.debug(`[stavrobot] manage_files move: ${resolvedSource.filePath} -> ${resolvedDestination.filePath}`);
        return toolSuccess(resolvedDestination.filePath);
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: write, read, search, read_lines, write_lines, list, delete, copy, move, help.`);
    },
  };
}
