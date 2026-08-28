import http from "http";
import { Readable } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueMessage } from "./queue.js";
import { saveAttachment } from "./uploads.js";
import { handlePebbleIndexWebhookRequest } from "./pebble-index.js";

vi.mock("./queue.js", () => ({
  enqueueMessage: vi.fn().mockResolvedValue("ok"),
}));

vi.mock("./uploads.js", () => ({
  saveAttachment: vi.fn().mockResolvedValue({
    storedPath: "/tmp/upload-recording.m4a",
    storedFilename: "upload-recording.m4a",
  }),
}));

interface MockResponse {
  statusCode: number | undefined;
  body: string | undefined;
  headersSent: boolean;
  writeHead(status: number): void;
  end(body: string): void;
}

interface MultipartPart {
  name: string;
  value?: string;
  audio?: Buffer;
}

function makeMockResponse(): MockResponse {
  return {
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
}

function makeMultipartRequest(parts: MultipartPart[]): http.IncomingMessage {
  const boundary = "pebble-index-test-boundary";
  const bodyParts: Buffer[] = [];
  for (const part of parts) {
    if (part.audio !== undefined) {
      bodyParts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="ignored.mp4"\r\nContent-Type: audio/mp4\r\n\r\n`),
        part.audio,
        Buffer.from("\r\n"),
      );
    } else {
      bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(bodyParts);
  return Object.assign(Readable.from([body]), {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }) as unknown as http.IncomingMessage;
}

async function submit(parts: MultipartPart[]): Promise<MockResponse> {
  const response = makeMockResponse();
  await handlePebbleIndexWebhookRequest(
    makeMultipartRequest(parts),
    response as unknown as http.ServerResponse,
  );
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handlePebbleIndexWebhookRequest", () => {
  const recordedAt = "1704067200000";
  const recordedAtIso = "2024-01-01T00:00:00.000Z";
  const baseFields: MultipartPart[] = [
    { name: "recordedAt", value: recordedAt },
    { name: "client", value: "ring" },
  ];

  it("enqueues a text-only recording", async () => {
    const response = await submit([...baseFields, { name: "transcription", value: "Take out the trash." }]);

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(enqueueMessage).toHaveBeenCalledWith(
        `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Transcription follows:\n\nTake out the trash.`,
        "pebble-index",
        "ring",
        undefined,
      );
    });
  });

  it("enqueues an audio-only recording", async () => {
    const audio = Buffer.from("audio");
    const response = await submit([...baseFields, { name: "audio", audio }]);

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(enqueueMessage).toHaveBeenCalledWith(
        `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Available as audio only, no transcription.`,
        "pebble-index",
        "ring",
        [{ storedPath: "/tmp/upload-recording.m4a", originalFilename: `recording-${recordedAt}.m4a`, mimeType: "audio/mp4", size: audio.length }],
      );
    });
    expect(saveAttachment).toHaveBeenCalledWith(audio, `recording-${recordedAt}.m4a`, "audio/mp4");
  });

  it("enqueues an audio recording with a transcription after the file part", async () => {
    const response = await submit([
      ...baseFields,
      { name: "audio", audio: Buffer.from("audio") },
      { name: "transcription", value: "Buy milk." },
    ]);

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(enqueueMessage).toHaveBeenCalledWith(
        `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Audio attached, transcription follows:\n\nBuy milk.`,
        "pebble-index",
        "ring",
        expect.any(Array),
      );
    });
  });

  it("returns 400 when no transcription or audio is provided", async () => {
    const response = await submit(baseFields);

    expect(response.statusCode).toBe(400);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when client is missing", async () => {
    const response = await submit([
      { name: "recordedAt", value: recordedAt },
      { name: "transcription", value: "Take out the trash." },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(JSON.stringify({ error: "Missing client" }));
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when recordedAt is missing", async () => {
    const response = await submit([
      { name: "client", value: "ring" },
      { name: "transcription", value: "Take out the trash." },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(JSON.stringify({ error: "Missing recordedAt" }));
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
