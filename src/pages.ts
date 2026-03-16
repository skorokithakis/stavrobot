import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { upsertPage, deletePage, readPage, listPageVersions, restorePageVersion } from "./database.js";

const MANAGE_PAGES_HELP_TEXT = `manage_pages: create, update, delete, read, and version web pages.

Versioning: every upsert creates a new version row. Delete inserts a tombstone (empty data) as a new version. Old versions are never removed, so you can always restore them.

Actions:
- upsert: create or update a page. Parameters: path (required), mimetype (required for new pages), content (required for new pages), is_public (optional), queries (optional).
- delete: delete a page by path (inserts a tombstone). Parameters: path (required).
- read: read a page. Parameters: path (required), version (optional integer — omit for latest). Returns the full row including version, mimetype, content, is_public, queries, and created_at. Tombstone versions are returned as-is (empty content).
- list_versions: list all versions of a page. Parameters: path (required). Returns version number, created_at, and whether the version is a tombstone (empty content).
- restore_version: restore an old version by copying it as a new version. Parameters: path (required), version (required integer). Works for un-deleting too — restore a pre-tombstone version.
- help: show this help text.

Pages are served at /pages/<path>.

On an existing page, omit any field to keep its current value. On a new page, content and mimetype are required.

The queries parameter maps query names to SQL strings (SELECT/WITH only). Use $param:name placeholders for parameters the client supplies via query string. Page JS fetches data via GET /api/pages/<path>/queries/<name>?param1=value1. The response is a JSON array of row objects. For private pages the endpoint requires authentication (the browser is already authenticated by the page load); for public pages no authentication is needed.

Security constraint: NEVER set is_public to true unless the user has *explicitly* and *unambiguously* said they want THIS SPECIFIC PAGE publicly accessible. Default to false. Only set true if the user says something clearly intentional such as "make this page public". When in doubt, keep it private.`;

export function createManagePagesTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_pages",
    label: "Manage pages",
    description: "Create, update, delete, read, and version dynamic web pages. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upsert"),
        Type.Literal("delete"),
        Type.Literal("read"),
        Type.Literal("list_versions"),
        Type.Literal("restore_version"),
        Type.Literal("help"),
      ], { description: "Action to perform: upsert, delete, read, list_versions, restore_version, or help." }),
      path: Type.Optional(Type.String({ description: "Page path, no leading or trailing slashes. Required for upsert, delete, read, list_versions, and restore_version." })),
      mimetype: Type.Optional(Type.String({ description: "MIME type, e.g. text/html, text/css. Required when creating a new page." })),
      content: Type.Optional(Type.String({ description: "The page content as a string. Required when creating a new page." })),
      is_public: Type.Optional(Type.Boolean({ description: "Whether the page is publicly accessible without authentication. Defaults to false for new pages." })),
      queries: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Maps query names to SQL strings. Use $param:name placeholders for parameters the client supplies via query string." })),
      version: Type.Optional(Type.Number({ description: "Version number. Used with read and restore_version actions." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        path?: string;
        mimetype?: string;
        content?: string;
        is_public?: boolean;
        queries?: Record<string, string>;
        version?: number;
      };

      const action = raw.action;

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: MANAGE_PAGES_HELP_TEXT }],
          details: { message: MANAGE_PAGES_HELP_TEXT },
        };
      }

      if (action === "upsert") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for upsert.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const message = await upsertPage(pool, raw.path, raw.mimetype, raw.content, raw.is_public, raw.queries);

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "delete") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const deleted = await deletePage(pool, raw.path);
        const message = deleted ? `Page deleted: ${raw.path}` : `Page not found: ${raw.path}`;

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "read") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for read.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const page = await readPage(pool, raw.path, raw.version);
        if (page === null) {
          const message = raw.version !== undefined
            ? `Page not found: ${raw.path} version ${raw.version}`
            : `Page not found: ${raw.path}`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        const message = JSON.stringify({
          path: page.path,
          version: page.version,
          mimetype: page.mimetype,
          data: page.data,
          is_public: page.isPublic,
          queries: page.queries,
          created_at: page.createdAt,
        }, null, 2);

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "list_versions") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for list_versions.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const versions = await listPageVersions(pool, raw.path);
        if (versions.length === 0) {
          const message = `No versions found for page: ${raw.path}`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { message },
          };
        }

        const message = JSON.stringify(
          versions.map((v) => ({
            version: v.version,
            created_at: v.createdAt,
            is_tombstone: v.isEmpty,
          })),
          null,
          2,
        );

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "restore_version") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for restore_version.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }
        if (raw.version === undefined) {
          const errorMessage = "Error: version is required for restore_version.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const message = await restorePageVersion(pool, raw.path, raw.version);

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: upsert, delete, read, list_versions, restore_version, help.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { message: errorMessage },
      };
    },
  };
}
