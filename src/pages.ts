import pg from "pg";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { upsertPage, deletePage, readPage, listPageVersions, restorePageVersion } from "./database.js";
import { toolError, toolSuccess } from "./tool-result.js";

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

The queries parameter maps query names to SQL strings (SELECT/WITH only). Use $param:name placeholders for parameters the client supplies via query string. Page JS fetches data via GET /api/pages/<path>/queries/<name>?param1=value1. The response is a JSON array of row objects. Query endpoints inherit the page's visibility: public pages have public query endpoints (no auth needed), private pages have private query endpoints (auth required; the browser is already authenticated by the page load).

Security constraint: NEVER set is_public to true unless the user has *explicitly* and *unambiguously* said they want THIS SPECIFIC PAGE publicly accessible. Default to false. Only set true if the user says something clearly intentional such as "make this page public". When in doubt, keep it private.

Static page model: pages are entirely static. The content string is served byte-for-byte as the HTTP response body. There is no server-side rendering, no templating engine, no data injection. Pages only respond to GET requests — they cannot receive POST requests or act as webhook endpoints. Do not assume any server-provided variables like window.__PAGE_DATA__ or $request exist — they don't. All dynamic data must be loaded client-side via JavaScript fetch calls to the query API.

Data fetching pattern:

  const response = await fetch("/api/pages/my-page/queries/my_query?param1=value1");
  const rows = await response.json(); // Array of row objects

The response is always a JSON array of row objects. For parameterized queries, pass values as URL query string parameters matching the $param:name placeholders defined in the queries map. For private pages, the browser is already authenticated by the page load, so fetches to the query endpoint work without extra auth handling.

Styling and dark mode: pages should match the app's visual identity. There is no external stylesheet — embed all CSS in the page's <style> tag. Follow these conventions:
- Use CSS custom properties on :root for all colors, and override them in a @media (prefers-color-scheme: dark) block for automatic dark mode.
- Light theme: neutral gray background (#f8f9fa), white card surfaces, dark text (#1a1a1a). Dark theme: dark background (#1a1a1a), dark gray surfaces (#2a2a2a), light text (#e8e8e8).
- Accent color: amber (light: #d97706, dark: #f59e0b). Use for links, primary buttons, focus rings, and highlights.
- Font: system font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif).
- Cards: white/dark surface background, subtle box-shadow, 8px border-radius, 16px padding.
- Buttons: 6px border-radius, 8px 16px padding, smooth transitions. Primary buttons use the accent color with white text.
- Input focus: accent-colored border with a subtle accent glow ring.
- Layout: centered single-column for most pages, mobile-responsive (adjust padding at 480px breakpoint).
- Always include a box-sizing: border-box reset.`;

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
        return toolSuccess(MANAGE_PAGES_HELP_TEXT);
      }

      if (action === "upsert") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for upsert.");
        }

        const message = await upsertPage(pool, raw.path, raw.mimetype, raw.content, raw.is_public, raw.queries);
        return toolSuccess(message);
      }

      if (action === "delete") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for delete.");
        }

        const deleted = await deletePage(pool, raw.path);
        return toolSuccess(deleted ? `Page deleted: ${raw.path}` : `Page not found: ${raw.path}`);
      }

      if (action === "read") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for read.");
        }

        const page = await readPage(pool, raw.path, raw.version);
        if (page === null) {
          const message = raw.version !== undefined
            ? `Page not found: ${raw.path} version ${raw.version}`
            : `Page not found: ${raw.path}`;
          return toolSuccess(message);
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

        return toolSuccess(message);
      }

      if (action === "list_versions") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for list_versions.");
        }

        const versions = await listPageVersions(pool, raw.path);
        if (versions.length === 0) {
          return toolSuccess(`No versions found for page: ${raw.path}`);
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

        return toolSuccess(message);
      }

      if (action === "restore_version") {
        if (raw.path === undefined || raw.path.trim() === "") {
          return toolError("Error: path is required for restore_version.");
        }
        if (raw.version === undefined) {
          return toolError("Error: version is required for restore_version.");
        }

        const message = await restorePageVersion(pool, raw.path, raw.version);
        return toolSuccess(message);
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: upsert, delete, read, list_versions, restore_version, help.`);
    },
  };
}
