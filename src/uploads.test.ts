import http from "http";
import fs from "fs";
import { Readable } from "stream";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUploadRequest, saveAttachment } from "./uploads.js";
import { enqueueMessage } from "./queue.js";

// Mock enqueueMessage so tests don't need a real queue.
vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn().mockResolvedValue("ok"),
}));

interface MockResponse {
  statusCode: number | undefined;
  body: string | undefined;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (body: string) => void;
}

function makeMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    body: undefined,
    headersSent: false,
    writeHead(status: number): void {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body: string): void {
      this.body = body;
    },
  };
  return response;
}

// Build a minimal multipart/form-data body with a single file field.
function buildMultipartBody(
  boundary: string,
  fields: Array<{ name: string; value: string }>,
  file: { fieldname: string; filename: string; contentType: string; data: Buffer } | undefined,
): Buffer {
  const parts: Buffer[] = [];
  const crlf = "\r\n";

  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="${field.name}"${crlf}` +
        `${crlf}` +
        `${field.value}${crlf}`,
      ),
    );
  }

  if (file !== undefined) {
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}${crlf}` +
          `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"${crlf}` +
          `Content-Type: ${file.contentType}${crlf}` +
          `${crlf}`,
        ),
        file.data,
        Buffer.from(crlf),
      ]),
    );
  }

  parts.push(Buffer.from(`--${boundary}--${crlf}`));
  return Buffer.concat(parts);
}

function makeMultipartRequest(
  boundary: string,
  body: Buffer,
): http.IncomingMessage {
  const readable = Readable.from([body]);
  const request = Object.assign(readable, {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    method: "POST",
    url: "/api/upload",
  });
  return request as unknown as http.IncomingMessage;
}

describe("saveAttachment", () => {
  it("writes the buffer to disk and returns the correct path and filename", async () => {
    const data = Buffer.from("test file contents");
    const { storedPath, storedFilename } = await saveAttachment(data, "example.txt", "text/plain");

    expect(storedFilename).toMatch(/^upload-.+\.txt$/);
    expect(storedPath).toContain(storedFilename);

    const written = await fs.promises.readFile(storedPath);
    expect(written).toEqual(data);

    // Clean up the file created during the test.
    await fs.promises.unlink(storedPath);
  });

  it("preserves the file extension from the original filename", async () => {
    const data = Buffer.from("image data");
    const { storedFilename, storedPath } = await saveAttachment(data, "photo.png", "image/png");

    expect(storedFilename).toMatch(/^upload-.+\.png$/);

    await fs.promises.unlink(storedPath);
  });

  it("handles filenames with no extension", async () => {
    const data = Buffer.from("no extension");
    const { storedFilename, storedPath } = await saveAttachment(data, "noext", "application/octet-stream");

    expect(storedFilename).toMatch(/^upload-[^.]+$/);

    await fs.promises.unlink(storedPath);
  });
});

describe("handleUploadRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no file field is present", async () => {
    const boundary = "testboundary";
    const body = buildMultipartBody(boundary, [{ name: "filename", value: "test.txt" }], undefined);
    const request = makeMultipartRequest(boundary, body);
    const response = makeMockResponse();

    await handleUploadRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body ?? "{}") as { error: string };
    expect(parsed.error).toMatch(/file/i);
  });

  it("returns 200 and the stored filename when a file is uploaded", async () => {
    const boundary = "testboundary";
    const fileData = Buffer.from("hello world");
    const body = buildMultipartBody(
      boundary,
      [{ name: "filename", value: "hello.txt" }],
      { fieldname: "file", filename: "hello.txt", contentType: "text/plain", data: fileData },
    );
    const request = makeMultipartRequest(boundary, body);
    const response = makeMockResponse();

    await handleUploadRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body ?? "{}") as { message: string; filename: string };
    expect(parsed.message).toBe("File uploaded successfully");
    // The stored filename should start with "upload-" and end with ".txt".
    expect(parsed.filename).toMatch(/^upload-.+\.txt$/);
  });

  it("uses the original filename when the filename field appears after the file part", async () => {
    // Build the multipart body with the file part first and the filename field
    // after, to exercise the race condition where busboy hasn't parsed the
    // filename field yet when the write stream finishes.
    const boundary = "latefieldboundary";
    const crlf = "\r\n";
    const fileData = Buffer.from("late field test content");
    const body = Buffer.concat([
      Buffer.concat([
        Buffer.from(
          `--${boundary}${crlf}` +
          `Content-Disposition: form-data; name="file"; filename="original.txt"${crlf}` +
          `Content-Type: text/plain${crlf}` +
          `${crlf}`,
        ),
        fileData,
        Buffer.from(crlf),
      ]),
      Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="filename"${crlf}` +
        `${crlf}` +
        `original.txt${crlf}`,
      ),
      Buffer.from(`--${boundary}--${crlf}`),
    ]);

    const request = makeMultipartRequest(boundary, body);
    const response = makeMockResponse();

    await handleUploadRequest(request, response as unknown as http.ServerResponse);

    expect(response.statusCode).toBe(200);

    const mockEnqueue = vi.mocked(enqueueMessage);
    expect(mockEnqueue).toHaveBeenCalledOnce();
    const attachments = mockEnqueue.mock.calls[0][3];
    // The attachment must contain the original filename, not the random stored name.
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments![0].originalFilename).toBe("original.txt");
  });
});
