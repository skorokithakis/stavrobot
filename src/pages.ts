import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { upsertPage, deletePage } from "./database.js";

export function createUpsertPageTool(pool: pg.Pool): AgentTool {
  return {
    name: "upsert_page",
    label: "Upsert page",
    description: `Create or update a web page. Pages are served at /pages/<path>. Only the path is required — on an existing page, omit any field to keep its current value. On a new page, content and mimetype are required.

Pages can fetch data dynamically using named queries in the queries parameter. Each key is a query name mapping to a SQL string (SELECT/WITH only). Use $param:name placeholders for parameters — the client supplies values via query string. Page JS fetches data via GET /api/pages/<path>/queries/<name>?param1=value1. The response is a JSON array of row objects. For private pages the endpoint requires authentication (the browser is already authenticated by the page load); for public pages no authentication is needed.

NEVER set is_public to true unless the user has *explicitly* and *unambiguously* said they want THIS SPECIFIC PAGE publicly accessible. Default to false. Only set true if the user says something clearly intentional such as "make this page public". When in doubt, keep it private.`,
    parameters: Type.Object({
      path: Type.String({ description: "Page path, no leading or trailing slashes." }),
      mimetype: Type.Optional(Type.String({ description: "MIME type, e.g. text/html, text/css. Required when creating a new page." })),
      content: Type.Optional(Type.String({ description: "The page content as a string. Required when creating a new page." })),
      is_public: Type.Optional(Type.Boolean({ description: "Whether the page is publicly accessible without authentication. Defaults to false for new pages." })),
      queries: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Maps query names to SQL strings. Use $param:name placeholders for parameters the client supplies via query string." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        path: string;
        mimetype?: string;
        content?: string;
        is_public?: boolean;
        queries?: Record<string, string>;
      };

      console.log("[stavrobot] upsert_page called:", { path: raw.path, mimetype: raw.mimetype, hasContent: raw.content !== undefined, isPublic: raw.is_public, hasQueries: raw.queries !== undefined });

      const message = await upsertPage(pool, raw.path, raw.mimetype, raw.content, raw.is_public, raw.queries);

      console.log("[stavrobot] upsert_page result:", message);

      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export function createDeletePageTool(pool: pg.Pool): AgentTool {
  return {
    name: "delete_page",
    label: "Delete page",
    description: "Delete a web page by its path.",
    parameters: Type.Object({
      path: Type.String({ description: "The page path to delete." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { path } = params as { path: string };

      console.log("[stavrobot] delete_page called:", path);

      const deleted = await deletePage(pool, path);
      const message = deleted ? `Page deleted: ${path}` : `Page not found: ${path}`;

      console.log("[stavrobot] delete_page result:", message);

      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}
