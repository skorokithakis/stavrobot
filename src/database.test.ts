import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Pool, QueryResult } from "pg";

// Mock config and log dependencies so the module loads without real infrastructure.
vi.mock("./config.js", () => ({
  loadPostgresConfig: vi.fn().mockReturnValue({}),
  OWNER_CHANNELS: [],
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./toon.js", () => ({
  encodeToToon: vi.fn(),
}));
vi.mock("fs");

import fs from "fs";
import { resolveInterlocutor, seedOwner, seedCronEntries, upsertPage, deletePage, getPageByPath, getPageQueryByPath, readPage, listPageVersions, restorePageVersion } from "./database.js";
import type { OwnerConfig } from "./config.js";

// Seed the owner so getOwnerInterlocutorId() doesn't throw. The mock pool
// returns a stable owner ID of 42 for all tests in this file.
const OWNER_ID = 42;

beforeAll(async () => {
  const seedPool = {
    query: vi.fn().mockImplementation((text: string) => {
      if (typeof text === "string" && text.includes("INSERT INTO agents")) {
        return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (typeof text === "string" && text.includes("SELECT id FROM interlocutors WHERE owner")) {
        return Promise.resolve({ rows: [{ id: OWNER_ID }], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    }),
  } as unknown as Pool;
  const ownerConfig: OwnerConfig = { name: "Test Owner" };
  await seedOwner(seedPool, ownerConfig);
});

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

describe("resolveInterlocutor — email wildcard matching", () => {
  it("matches a wildcard pattern *@example.com against user@example.com", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 1,
            identity_id: 10,
            agent_id: 5,
            display_name: "Example Corp",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(1);
    expect(result?.identityId).toBe(10);
    expect(result?.agentId).toBe(5);
    expect(result?.displayName).toBe("Example Corp");
  });

  it("does not match *@example.com against user@other.com", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 1,
            identity_id: 10,
            agent_id: 5,
            display_name: "Example Corp",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    // The SQL LIKE filter already excludes this, but we simulate a row being returned
    // to verify the application-level matchesEmailEntry check also rejects it.
    const result = await resolveInterlocutor(pool, "email", "user@other.com");
    expect(result).toBeNull();
  });

  it("matches an exact email address", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 2,
            identity_id: 20,
            agent_id: 7,
            display_name: "Alice",
            identifier: "alice@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "alice@example.com");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(2);
  });

  it("returns null when no rows match the domain filter", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "nobody@nowhere.com");
    expect(result).toBeNull();
  });

  it("returns null when the matched interlocutor has no agent_id", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 3,
            identity_id: 30,
            agent_id: null,
            display_name: "Unassigned",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result).toBeNull();
  });

  it("uses the first matching row when multiple identities match", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 4,
            identity_id: 40,
            agent_id: 8,
            display_name: "First",
            identifier: "*@example.com",
          },
          {
            interlocutor_id: 5,
            identity_id: 50,
            agent_id: 9,
            display_name: "Second",
            identifier: "user@example.com",
          },
        ],
        rowCount: 2,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result?.interlocutorId).toBe(4);
  });

  it("passes the domain as the SQL parameter", async () => {
    let capturedValues: unknown[] | undefined;
    const pool = makeMockPool((_, values) => {
      capturedValues = values;
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    await resolveInterlocutor(pool, "email", "sender@mail.example.com");
    expect(capturedValues).toEqual(["mail.example.com"]);
  });

  it("is case-insensitive when matching email patterns", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 6,
            identity_id: 60,
            agent_id: 11,
            display_name: "Case Test",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "User@EXAMPLE.COM");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(6);
  });
});

describe("resolveInterlocutor — non-email services (exact match)", () => {
  it("returns the interlocutor for an exact signal match", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 7,
            identity_id: 70,
            agent_id: 12,
            display_name: "Signal User",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+1234567890");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(7);
  });

  it("returns null when no signal identity matches", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+9999999999");
    expect(result).toBeNull();
  });

  it("returns null when the signal interlocutor has no agent_id", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 8,
            identity_id: 80,
            agent_id: null,
            display_name: "No Agent",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+1234567890");
    expect(result).toBeNull();
  });
});

describe("seedCronEntries", () => {
  const readFileSyncMock = vi.mocked(fs.readFileSync);

  it("inserts a new cron entry when none exists", async () => {
    readFileSyncMock.mockReturnValue("do the nightly review");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      // SELECT returns no existing rows.
      if (text.includes("SELECT")) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO cron_entries"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery?.values[0]).toBe("0 3 * * *");
    expect(insertQuery?.values[1]).toBe("[nightly-review] do the nightly review");
  });

  it("updates an existing entry when the note has changed", async () => {
    readFileSyncMock.mockReturnValue("updated prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ id: 99, note: "[nightly-review] old prompt text" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.values[0]).toBe("[nightly-review] updated prompt text");
    expect(updateQuery?.values[1]).toBe(99);
  });

  it("does not update when the note is already up to date", async () => {
    readFileSyncMock.mockReturnValue("same prompt");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        // Return a matching up-to-date row for whichever marker is being queried.
        const likeParam = (values ?? [])[0] as string;
        const marker = likeParam.replace(/%$/, "");
        return Promise.resolve({
          rows: [{ id: 5, note: `${marker} same prompt` }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeUndefined();
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO cron_entries"));
    expect(insertQuery).toBeUndefined();
  });

  it("skips update when the existing note starts with the manual freeze prefix", async () => {
    readFileSyncMock.mockReturnValue("new prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        // Return a manually-frozen row for whichever marker is being queried.
        const likeParam = (values ?? [])[0] as string;
        const marker = likeParam.replace(/%$/, "");
        return Promise.resolve({
          rows: [{ id: 7, note: `${marker}[manual] custom frozen note` }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeUndefined();
  });

  it("does not skip when [manual] appears in the note body but not as the freeze prefix", async () => {
    readFileSyncMock.mockReturnValue("new prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ id: 8, note: "[nightly-review] some [manual] note body" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    // The note differs from the built note, so an update should be issued.
    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeDefined();
  });

  it("logs a warning and skips when the prompt file is missing", async () => {
    const enoentError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileSyncMock.mockImplementation(() => { throw enoentError; });
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    // No DB writes should have occurred.
    const writeQuery = queries.find((q) => q.text.includes("INSERT") || q.text.includes("UPDATE"));
    expect(writeQuery).toBeUndefined();
  });

  it("re-throws non-ENOENT errors from readFileSync", async () => {
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });
    readFileSyncMock.mockImplementation(() => { throw permissionError; });
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));

    await expect(seedCronEntries(pool)).rejects.toThrow("EACCES");
  });
});

describe("upsertPage — versioned inserts", () => {
  it("inserts version 1 when no existing rows for the path", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      // SELECT returns no existing rows.
      if (text.includes("SELECT")) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    const result = await upsertPage(pool, "about", "text/html", "<h1>About</h1>", false);

    expect(result).toBe("Page created at /pages/about");
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO pages"));
    expect(insertQuery).toBeDefined();
    // version = 1 is hardcoded in the SQL for new pages.
    expect(insertQuery?.text).toMatch(/version\)\s+VALUES.*,\s*1\)/s);
  });

  it("returns an error when creating a new page without content or mimetype", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const result = await upsertPage(pool, "about");

    expect(result).toMatch(/content and mimetype are required/);
  });

  it("inserts version max+1 when existing rows are present", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ version: 3, mimetype: "text/html", data: Buffer.from("old"), is_public: false, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    const result = await upsertPage(pool, "about", undefined, "<h1>New</h1>");

    expect(result).toBe("Page updated at /pages/about");
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO pages"));
    expect(insertQuery).toBeDefined();
    // version = 4 (max 3 + 1) is the last positional parameter.
    expect(insertQuery?.values[insertQuery.values.length - 1]).toBe(4);
  });

  it("carries forward mimetype, is_public, and queries when not provided on update", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ version: 1, mimetype: "text/css", data: Buffer.from("body{}"), is_public: true, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await upsertPage(pool, "style", undefined, "body { color: red; }");

    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO pages"));
    expect(insertQuery).toBeDefined();
    // mimetype carried forward.
    expect(insertQuery?.values[1]).toBe("text/css");
    // is_public carried forward.
    expect(insertQuery?.values[3]).toBe(true);
  });

  it("returns an error when updating with no fields provided", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{ version: 1, mimetype: "text/html", data: Buffer.from("x"), is_public: false, queries: null }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const result = await upsertPage(pool, "about");

    expect(result).toMatch(/no fields to update/);
  });
});

describe("deletePage — tombstone inserts", () => {
  it("inserts a tombstone with empty data when the page exists", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ version: 2, mimetype: "text/html", data: Buffer.from("content"), is_public: false, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    const deleted = await deletePage(pool, "about");

    expect(deleted).toBe(true);
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO pages"));
    expect(insertQuery).toBeDefined();
    // version = 3 (max 2 + 1).
    expect(insertQuery?.values[insertQuery.values.length - 1]).toBe(3);
  });

  it("returns false when no rows exist for the path", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const deleted = await deletePage(pool, "nonexistent");

    expect(deleted).toBe(false);
  });

  it("returns false when the latest version is already a tombstone", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ version: 3, mimetype: "text/html", data: Buffer.alloc(0), is_public: false, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    const deleted = await deletePage(pool, "about");

    expect(deleted).toBe(false);
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO pages"));
    expect(insertQuery).toBeUndefined();
  });
});

describe("getPageByPath — versioned reads", () => {
  it("returns null when no rows exist", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const page = await getPageByPath(pool, "about");

    expect(page).toBeNull();
  });

  it("returns null when the latest version is a tombstone (empty data)", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{ mimetype: "text/html", data: Buffer.alloc(0), is_public: false, queries: null }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const page = await getPageByPath(pool, "about");

    expect(page).toBeNull();
  });

  it("returns the page when the latest version has non-empty data", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{ mimetype: "text/html", data: Buffer.from("<h1>Hi</h1>"), is_public: true, queries: null }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const page = await getPageByPath(pool, "about");

    expect(page).not.toBeNull();
    expect(page?.mimetype).toBe("text/html");
    expect(page?.isPublic).toBe(true);
  });
});

describe("getPageQueryByPath — versioned reads", () => {
  it("returns null when no rows exist", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const result = await getPageQueryByPath(pool, "about", "myquery");

    expect(result).toBeNull();
  });

  it("returns null when the latest version is a tombstone (empty data)", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{ query: "SELECT 1", is_public: false, data: Buffer.alloc(0) }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const result = await getPageQueryByPath(pool, "about", "myquery");

    expect(result).toBeNull();
  });

  it("returns the query when the latest version has non-empty data", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{ query: "SELECT 1", is_public: true, data: Buffer.from("content") }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const result = await getPageQueryByPath(pool, "about", "myquery");

    expect(result).not.toBeNull();
    expect(result?.query).toBe("SELECT 1");
    expect(result?.isPublic).toBe(true);
  });
});

describe("readPage", () => {
  it("returns null when no rows exist", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const result = await readPage(pool, "about");

    expect(result).toBeNull();
  });

  it("returns the latest version when no version is specified", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      return Promise.resolve({
        rows: [{
          path: "about",
          version: 3,
          mimetype: "text/html",
          data: "<h1>About</h1>",
          is_public: false,
          queries: null,
          created_at: createdAt,
        }],
        rowCount: 1,
      } as unknown as QueryResult);
    });

    const result = await readPage(pool, "about");

    expect(result).not.toBeNull();
    expect(result?.version).toBe(3);
    expect(result?.data).toBe("<h1>About</h1>");
    expect(result?.mimetype).toBe("text/html");
    expect(result?.isPublic).toBe(false);
    expect(result?.createdAt).toBe(createdAt);
    // Should use ORDER BY version DESC LIMIT 1 (no version filter).
    const query = queries[0];
    expect(query.text).toMatch(/ORDER BY version DESC LIMIT 1/);
    expect(query.values).toEqual(["about"]);
  });

  it("fetches a specific version when version is provided", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      return Promise.resolve({
        rows: [{
          path: "about",
          version: 2,
          mimetype: "text/html",
          data: "<h1>Old</h1>",
          is_public: true,
          queries: null,
          created_at: new Date(),
        }],
        rowCount: 1,
      } as unknown as QueryResult);
    });

    const result = await readPage(pool, "about", 2);

    expect(result).not.toBeNull();
    expect(result?.version).toBe(2);
    // Should filter by version, not use ORDER BY.
    const query = queries[0];
    expect(query.text).toMatch(/version = \$2/);
    expect(query.values).toEqual(["about", 2]);
  });

  it("returns tombstone versions (empty data) without filtering them out", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [{
          path: "about",
          version: 4,
          mimetype: "text/html",
          data: "",
          is_public: false,
          queries: null,
          created_at: new Date(),
        }],
        rowCount: 1,
      } as unknown as QueryResult),
    );

    const result = await readPage(pool, "about");

    expect(result).not.toBeNull();
    expect(result?.data).toBe("");
  });
});

describe("listPageVersions", () => {
  it("returns an empty array when no versions exist", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );

    const result = await listPageVersions(pool, "about");

    expect(result).toEqual([]);
  });

  it("returns versions ordered by version descending with isEmpty flag", async () => {
    const date1 = new Date("2026-01-03T00:00:00Z");
    const date2 = new Date("2026-01-02T00:00:00Z");
    const date3 = new Date("2026-01-01T00:00:00Z");
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          { version: 3, created_at: date1, data: Buffer.alloc(0) },
          { version: 2, created_at: date2, data: Buffer.from("content") },
          { version: 1, created_at: date3, data: Buffer.from("old") },
        ],
        rowCount: 3,
      } as unknown as QueryResult),
    );

    const result = await listPageVersions(pool, "about");

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ version: 3, createdAt: date1, isEmpty: true });
    expect(result[1]).toEqual({ version: 2, createdAt: date2, isEmpty: false });
    expect(result[2]).toEqual({ version: 1, createdAt: date3, isEmpty: false });
  });
});

describe("restorePageVersion", () => {
  it("returns an error when the specified version does not exist", async () => {
    const pool = makeMockPool((text) => {
      if (text.includes("SELECT mimetype")) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const result = await restorePageVersion(pool, "about", 99);

    expect(result).toMatch(/not found/);
    expect(result).toMatch(/version 99/);
  });

  it("inserts a new row copying data from the specified version", async () => {
    const insertedRows: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      if (text.includes("SELECT mimetype")) {
        return Promise.resolve({
          rows: [{ mimetype: "text/html", data: Buffer.from("<h1>Old</h1>"), is_public: true, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("MAX(version)")) {
        return Promise.resolve({
          rows: [{ max_version: 3 }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("INSERT INTO pages")) {
        insertedRows.push({ text, values: values ?? [] });
        return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const result = await restorePageVersion(pool, "about", 2);

    expect(result).toMatch(/restored from version 2 as version 4/);
    expect(insertedRows).toHaveLength(1);
    // version = max(3) + 1 = 4 is the last positional parameter.
    expect(insertedRows[0].values[insertedRows[0].values.length - 1]).toBe(4);
    // mimetype carried from source.
    expect(insertedRows[0].values[1]).toBe("text/html");
  });

  it("handles null max_version (no existing rows) by starting at version 1", async () => {
    const insertedRows: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      if (text.includes("SELECT mimetype")) {
        return Promise.resolve({
          rows: [{ mimetype: "text/html", data: Buffer.from("content"), is_public: false, queries: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("MAX(version)")) {
        return Promise.resolve({
          rows: [{ max_version: null }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (text.includes("INSERT INTO pages")) {
        insertedRows.push({ text, values: values ?? [] });
        return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const result = await restorePageVersion(pool, "about", 1);

    expect(result).toMatch(/version 1/);
    expect(insertedRows[0].values[insertedRows[0].values.length - 1]).toBe(1);
  });
});
