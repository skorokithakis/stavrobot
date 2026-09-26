import http from "http";
import { Readable } from "stream";
import { describe, it, expect, vi } from "vitest";
import { handlePageQueryRequest, handlePageMutationRequest, handleTelegramWebhookRequest, checkBasicAuth, readRequestBody, handleChatRequest, isPublicRoute } from "./index.js";
import type { Pool, QueryResult } from "pg";
import type { TelegramConfig } from "./config.js";
import { log } from "./log.js";
import { enqueueMessage } from "./queue.js";
import { saveAttachment } from "./uploads.js";

// Mock queue and uploads so handleChatRequest tests don't need real infrastructure.
vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn().mockResolvedValue("ok"),
  initializeQueue: vi.fn(),
}));

vi.mock("./uploads.js", () => ({
  handleUploadRequest: vi.fn(),
  saveAttachment: vi.fn().mockResolvedValue({ storedPath: "/tmp/upload-test.txt", storedFilename: "upload-test.txt" }),
}));

// Minimal mock of http.IncomingMessage with only the fields the handler reads.
function makeMockRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers, url: "/api/pages/mypage/queries/myquery" } as unknown as http.IncomingMessage;
}

// Minimal mock of http.ServerResponse that captures the status code and body.
interface MockResponse {
  statusCode: number | undefined;
  body: string | undefined;
  writeHead: (status: number) => void;
  end: (body: string) => void;
}

function makeMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    body: undefined,
    writeHead(status: number): void {
      this.statusCode = status;
    },
    end(body: string): void {
      this.body = body;
    },
  };
  return response;
}

// Build a mock Pool whose query() returns rows shaped the way getPageQueryByPath expects,
// and whose connect() returns a mock client for the READ ONLY transaction.
// The pool.query() is used by getPageQueryByPath; pool.connect() is used for the actual
// page query execution inside a READ ONLY transaction.
function makeMockPool(isPublic: boolean, clientQueryImpl?: (sql: string) => QueryResult, storedQuery: string = "SELECT 1"): Pool {
  const pageRow = { query: storedQuery, is_public: isPublic, data: Buffer.from("content") };

  const defaultClientQuery = (sql: string): QueryResult => {
    if (sql === "BEGIN TRANSACTION READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], command: sql, rowCount: 0 } as unknown as QueryResult;
    }
    return { rows: [{ result: 1 }], command: "SELECT", rowCount: 1 } as unknown as QueryResult;
  };

  const clientQueryFn = clientQueryImpl ?? defaultClientQuery;

  const mockClient = {
    query: vi.fn().mockImplementation((sql: string) => Promise.resolve(clientQueryFn(sql))),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn().mockImplementation(() =>
      Promise.resolve({ rows: [pageRow], command: "SELECT", rowCount: 1 } as unknown as QueryResult),
    ),
    connect: vi.fn().mockResolvedValue(mockClient),
  };
  return pool as unknown as Pool;
}

describe("handlePageQueryRequest auth enforcement", () => {
  const pathname = "/api/pages/mypage/queries/myquery";
  const password = "secret";
  const url = new URL("http://localhost/api/pages/mypage/queries/myquery");

  it("returns 401 for a private page when no auth header is provided", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();
    const pool = makeMockPool(false);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a private page when wrong password is provided", async () => {
    const credentials = Buffer.from("user:wrongpassword").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    const response = makeMockResponse();
    const pool = makeMockPool(false);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(401);
  });

  it("does not return 401 for a public page when no auth header is provided", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();
    const pool = makeMockPool(true);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    // Auth was not enforced — the handler proceeded past the auth check.
    // It ran the query and returned 200.
    expect(response.statusCode).not.toBe(401);
  });
});

describe("handlePageQueryRequest transaction enforcement", () => {
  const pathname = "/api/pages/mypage/queries/myquery";
  const password = "secret";
  const url = new URL("http://localhost/api/pages/mypage/queries/myquery");

  it("issues BEGIN TRANSACTION READ ONLY before the query and COMMIT after", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();
    const pool = makeMockPool(true);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(200);
    // pool.connect() must have been called to obtain a client.
    const connectMock = (pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect;
    expect(connectMock).toHaveBeenCalledOnce();

    const mockClient = await connectMock.mock.results[0].value as { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    const queryCalls = mockClient.query.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(queryCalls[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queryCalls[queryCalls.length - 1]).toBe("COMMIT");
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it("rejects a writable CTE that passes validateReadOnlySql but is blocked by the READ ONLY transaction", async () => {
    // This query starts with WITH and has no extra semicolons, so validateReadOnlySql
    // passes it. Postgres rejects it at the engine level inside a READ ONLY transaction.
    const writableCte = "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x";

    const request = makeMockRequest();
    const response = makeMockResponse();

    const pool = makeMockPool(true, (sql: string) => {
      if (sql === "BEGIN TRANSACTION READ ONLY" || sql === "ROLLBACK") {
        return { rows: [], command: sql, rowCount: 0 } as unknown as QueryResult;
      }
      if (sql === writableCte) {
        throw new Error("cannot execute DELETE in a read-only transaction");
      }
      return { rows: [], command: "SELECT", rowCount: 0 } as unknown as QueryResult;
    }, writableCte);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(500);
    const parsed = JSON.parse(response.body ?? "{}") as { error: string };
    expect(parsed.error).toContain("read-only transaction");

    const connectMock = (pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect;
    const mockClient = await connectMock.mock.results[0].value as { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    const queryCalls = mockClient.query.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(queryCalls[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queryCalls).toContain(writableCte);
    expect(queryCalls).toContain("ROLLBACK");
    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});

// Builds a readable IncomingMessage carrying a JSON body for the mutation endpoint.
function makeMutationRequest(
  body: string,
  headers: Record<string, string> = {},
  pathname: string = "/api/pages/mypage/mutations/mymutation",
): http.IncomingMessage {
  const readable = Readable.from([Buffer.from(body)]);
  return Object.assign(readable, {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    url: pathname,
  }) as unknown as http.IncomingMessage;
}

interface MutationPoolOptions {
  pageRows?: unknown[];
  execResult?: QueryResult;
}

// Mock Pool for the mutation handler: the first query() call is the
// getPageMutationByPath lookup (identified by "mutations->>"), the second is the
// mutation execution.
function makeMutationPool(options: MutationPoolOptions = {}): { pool: Pool; queryMock: ReturnType<typeof vi.fn> } {
  const pageRows = options.pageRows ?? [{ mutation: "UPDATE widgets SET name = 'x'", data: Buffer.from("content") }];
  const execResult = options.execResult ?? ({ rows: [{ id: 1 }], command: "UPDATE", rowCount: 1 } as unknown as QueryResult);
  const queryMock = vi.fn().mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("mutations->>")) {
      return Promise.resolve({ rows: pageRows, rowCount: pageRows.length } as unknown as QueryResult);
    }
    return Promise.resolve(execResult);
  });
  return { pool: { query: queryMock } as unknown as Pool, queryMock };
}

async function invokeMutation(
  pool: Pool,
  body: string = "{}",
  headers: Record<string, string> = {},
  pathname: string = "/api/pages/mypage/mutations/mymutation",
): Promise<MockResponse> {
  const request = makeMutationRequest(body, headers, pathname);
  const response = makeMockResponse();
  await handlePageMutationRequest(request, response as unknown as http.ServerResponse, pathname, pool);
  return response;
}

describe("handlePageMutationRequest", () => {
  it("runs the mutation and returns rowCount and rows", async () => {
    const { pool, queryMock } = makeMutationPool({
      execResult: { rows: [{ id: 7 }], command: "UPDATE", rowCount: 1 } as unknown as QueryResult,
    });
    const response = await invokeMutation(pool);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ rowCount: 1, rows: [{ id: 7 }] }));
    // The execution query is the second pool.query() call (the first is the lookup).
    expect(queryMock.mock.calls[1][0]).toContain("UPDATE widgets");
    expect(queryMock.mock.calls[1][1]).toEqual([]);
  });

  it("binds $param:name values from the JSON body", async () => {
    const { pool, queryMock } = makeMutationPool({
      pageRows: [{ mutation: "INSERT INTO widgets (a, b) VALUES ($param:first, $param:second)", data: Buffer.from("content") }],
    });
    const response = await invokeMutation(pool, JSON.stringify({ first: "hello", second: 42 }));

    expect(response.statusCode).toBe(200);
    expect(queryMock.mock.calls[1][0]).toBe("INSERT INTO widgets (a, b) VALUES ($1, $2)");
    expect(queryMock.mock.calls[1][1]).toEqual(["hello", 42]);
  });

  it("returns 400 when a $param:name key is missing from the body", async () => {
    const { pool, queryMock } = makeMutationPool({
      pageRows: [{ mutation: "UPDATE widgets SET name = $param:name", data: Buffer.from("content") }],
    });
    const response = await invokeMutation(pool, "{}");

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "{}").error).toContain("name");
    // The execution query must not run.
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid JSON", async () => {
    const { pool } = makeMutationPool();
    const response = await invokeMutation(pool, "not json");

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for a non-object JSON body", async () => {
    const { pool } = makeMutationPool();
    const response = await invokeMutation(pool, JSON.stringify([1, 2, 3]));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "{}").error).toMatch(/object/i);
  });

  it("returns 415 when the content type is not JSON", async () => {
    const { pool, queryMock } = makeMutationPool();
    const response = await invokeMutation(pool, "{}", { "content-type": "application/x-www-form-urlencoded" });

    expect(response.statusCode).toBe(415);
    // Only the lookup ran; the mutation execution did not.
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("returns 415 when the content type is empty", async () => {
    const { pool } = makeMutationPool();
    const response = await invokeMutation(pool, "{}", { "content-type": "" });

    expect(response.statusCode).toBe(415);
  });

  it("allows a JSON content type with parameters such as charset", async () => {
    const { pool } = makeMutationPool();
    const response = await invokeMutation(pool, "{}", { "content-type": "application/json; charset=utf-8" });

    expect(response.statusCode).toBe(200);
  });

  it("returns 404 when the page or mutation is unknown", async () => {
    const { pool } = makeMutationPool({ pageRows: [] });
    const response = await invokeMutation(pool, "{}");

    expect(response.statusCode).toBe(404);
  });

  it("rejects multi-statement SQL", async () => {
    const { pool, queryMock } = makeMutationPool({
      pageRows: [{ mutation: "UPDATE widgets SET name = 'x'; DELETE FROM widgets", data: Buffer.from("content") }],
    });
    const response = await invokeMutation(pool, "{}");

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "{}").error).toMatch(/Multiple SQL statements/);
    // Only the lookup query ran.
    expect(queryMock).toHaveBeenCalledOnce();
  });
});

describe("isPublicRoute — page mutations", () => {
  it("treats POST mutations as non-public even for public pages", () => {
    expect(isPublicRoute("POST", "/api/pages/public-page/mutations/do_thing")).toBe(false);
  });

  it("still treats GET page queries as public with per-page auth", () => {
    expect(isPublicRoute("GET", "/api/pages/public-page/queries/do_thing")).toBe(true);
  });
});

describe("checkBasicAuth", () => {
  it("returns false when no authorization header is present", () => {
    const request = makeMockRequest();
    expect(checkBasicAuth(request, "secret")).toBe(false);
  });

  it("returns false when the password is wrong", () => {
    const credentials = Buffer.from("user:wrong").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    expect(checkBasicAuth(request, "secret")).toBe(false);
  });

  it("returns true when the correct password is provided", () => {
    const credentials = Buffer.from("user:secret").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    expect(checkBasicAuth(request, "secret")).toBe(true);
  });
});

describe("handleTelegramWebhookRequest secret verification", () => {
  const telegramConfig: TelegramConfig = {
    botToken: "test-token",
  };
  const webhookSecret = "test-secret-uuid";

  it("returns 403 when the secret header is missing", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when the secret header is wrong", async () => {
    const request = makeMockRequest({ "x-telegram-bot-api-secret-token": "wrong-secret" });
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).toBe(403);
  });

  it("does not return 403 when the correct secret header is provided", async () => {
    const request = {
      headers: { "x-telegram-bot-api-secret-token": webhookSecret },
      url: "/telegram/webhook",
      [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"message":{"chat":{"id":999},"text":"hi"}}'); },
    } as unknown as http.IncomingMessage;
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).not.toBe(403);
  });

  it("returns 404 when telegramConfig is undefined", async () => {
    const request = makeMockRequest({ "x-telegram-bot-api-secret-token": webhookSecret });
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      undefined,
      webhookSecret,
    );

    expect(response.statusCode).toBe(404);
  });
});

// Helper to build a readable stream from a buffer, usable as IncomingMessage.
function makeBodyRequest(body: Buffer, headers: Record<string, string> = {}): http.IncomingMessage {
  const readable = Readable.from([body]);
  return Object.assign(readable, {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    url: "/chat",
  }) as unknown as http.IncomingMessage;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("readRequestBody size limit", () => {
  it("returns the body when it is within the limit", async () => {
    const body = Buffer.from(JSON.stringify({ message: "hello" }));
    const request = makeBodyRequest(body);
    const result = await readRequestBody(request, 1024);
    expect(result).toBe(JSON.stringify({ message: "hello" }));
  });

  it("throws 'Request body too large' when the body exceeds maxBytes", async () => {
    const body = Buffer.alloc(1025, "x");
    const request = makeBodyRequest(body);
    await expect(readRequestBody(request, 1024)).rejects.toThrow("Request body too large");
  });
});

describe("handleChatRequest body size limit", () => {
  it("returns 413 when the request body exceeds 25 MB", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, "x");
    const request = makeBodyRequest(oversized);
    const response = makeMockResponse();

    await handleChatRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(413);
    const parsed = JSON.parse(response.body ?? "{}") as { error: string };
    expect(parsed.error).toBe("Request body too large");
  });
});

describe("handleChatRequest base64 file handling", () => {
  it("saves a small base64 file and returns 200", async () => {
    const saveMock = vi.mocked(saveAttachment);
    saveMock.mockClear();

    const smallBase64 = Buffer.from("hello world").toString("base64");
    const payload = JSON.stringify({
      message: "test",
      files: [{ data: smallBase64, filename: "small.txt", mimeType: "text/plain" }],
    });

    const request = makeBodyRequest(Buffer.from(payload));
    const response = makeMockResponse();

    await handleChatRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(saveMock).toHaveBeenCalledOnce();
  });

  it("returns 413 when a base64 file payload exceeds the 25 MB body limit", async () => {
    // A base64 payload for a 20 MB+ file is ~27 MB, which exceeds the 25 MB body
    // limit. The body limit fires before the per-file 10 MB check is reached.
    const oversizedBase64 = Buffer.alloc(20 * 1024 * 1024 + 1, "a").toString("base64");
    const payload = JSON.stringify({
      message: "hello",
      files: [{ data: oversizedBase64, filename: "big.bin", mimeType: "application/octet-stream" }],
    });

    const request = makeBodyRequest(Buffer.from(payload));
    const response = makeMockResponse();

    await handleChatRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(413);
  });
});

describe("handleChatRequest async acknowledgement", () => {
  it("acknowledges a request while its queue processing remains pending", async () => {
    const mockEnqueue = vi.mocked(enqueueMessage);
    mockEnqueue.mockClear();
    const deferred = createDeferred<string>();
    mockEnqueue.mockReturnValueOnce(deferred.promise);

    const request = makeBodyRequest(Buffer.from(JSON.stringify({
      message: "test",
      source: "signal",
      sender: "+1234567890",
      async: true,
    })));
    const response = makeMockResponse();

    await handleChatRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe(JSON.stringify({ accepted: true }));
    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledWith("test", "signal", "+1234567890", undefined);

    deferred.resolve("complete");
  });

  for (const { label, payload } of [
    { label: "omitted", payload: { message: "test" } },
    { label: "false", payload: { message: "test", async: false } },
  ]) {
    it(`waits for queue processing when async is ${label}`, async () => {
      const mockEnqueue = vi.mocked(enqueueMessage);
      mockEnqueue.mockClear();
      const deferred = createDeferred<string>();
      mockEnqueue.mockReturnValueOnce(deferred.promise);

      const request = makeBodyRequest(Buffer.from(JSON.stringify(payload)));
      const response = makeMockResponse();
      const requestPromise = handleChatRequest(request, response as unknown as http.ServerResponse);

      await vi.waitFor(() => {
        expect(mockEnqueue).toHaveBeenCalledOnce();
      });
      expect(response.statusCode).toBeUndefined();

      deferred.resolve("complete");
      await requestPromise;

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(JSON.stringify({ response: "complete" }));
    });
  }

  for (const { label, asyncValue } of [
    { label: "string", asyncValue: "true" },
    { label: "number", asyncValue: 1 },
    { label: "null", asyncValue: null },
    { label: "object", asyncValue: {} },
    { label: "array", asyncValue: [] },
  ]) {
    it(`rejects a ${label} async value before file writes or enqueueing`, async () => {
      const mockEnqueue = vi.mocked(enqueueMessage);
      const mockSaveAttachment = vi.mocked(saveAttachment);
      mockEnqueue.mockClear();
      mockSaveAttachment.mockClear();

      const request = makeBodyRequest(Buffer.from(JSON.stringify({
        message: "test",
        async: asyncValue,
        files: [{ data: Buffer.from("file").toString("base64"), filename: "file.txt", mimeType: "text/plain" }],
      })));
      const response = makeMockResponse();

      await handleChatRequest(request, response as unknown as http.ServerResponse);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body ?? "{}").error).toMatch(/async.*boolean/i);
      expect(mockSaveAttachment).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  }

  it("keeps required-content validation for async requests", async () => {
    const mockEnqueue = vi.mocked(enqueueMessage);
    mockEnqueue.mockClear();
    const request = makeBodyRequest(Buffer.from(JSON.stringify({ async: true })));
    const response = makeMockResponse();

    await handleChatRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(JSON.stringify({ error: "At least one of 'message', 'attachments', or 'files' must be present" }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("logs a detached enqueue rejection without sending another response", async () => {
    const mockEnqueue = vi.mocked(enqueueMessage);
    mockEnqueue.mockClear();
    const deferred = createDeferred<string>();
    mockEnqueue.mockReturnValueOnce(deferred.promise);
    const error = new Error("queue failed");
    const logErrorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const request = makeBodyRequest(Buffer.from(JSON.stringify({ message: "test", async: true })));
    const response = makeMockResponse();
    const writeHeadSpy = vi.spyOn(response, "writeHead");
    const endSpy = vi.spyOn(response, "end");

    try {
      await handleChatRequest(request, response as unknown as http.ServerResponse);
      deferred.reject(error);

      await vi.waitFor(() => {
        expect(logErrorSpy).toHaveBeenCalledWith("[stavrobot] Error processing asynchronous chat request:", error);
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe(JSON.stringify({ accepted: true }));
      expect(writeHeadSpy).toHaveBeenCalledOnce();
      expect(endSpy).toHaveBeenCalledOnce();
    } finally {
      logErrorSpy.mockRestore();
    }
  });
});
