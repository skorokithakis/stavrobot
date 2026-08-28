import http from "http";
import busboy from "busboy";
import { enqueueMessage } from "./queue.js";
import { saveAttachment } from "./uploads.js";
import type { FileAttachment } from "./uploads.js";
import { log } from "./log.js";

// The source is "pebble-index", named after the product rather than the company,
// because Pebble may ship other devices that warrant their own source. It is a fixed
// string rather than something read off the request (e.g. the User-Agent header)
// because sources are compared exactly against the routing lists in queue.ts, so a
// value that drifts between firmware releases would silently change routing and
// fragment message history. Devices are told apart by the "client" field instead,
// which becomes the sender.
export async function handlePebbleIndexWebhookRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    let transcription: string | undefined;
    let recordedAt: string | undefined;
    let client: string | undefined;
    let audioChunks: Buffer[] | undefined;
    let audioTooLarge = false;

    await new Promise<void>((resolve, reject) => {
      const parser = busboy({
        headers: request.headers,
        limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      });
      parser.on("field", (fieldName, value) => {
        if (fieldName === "transcription") transcription = value;
        if (fieldName === "recordedAt") recordedAt = value;
        if (fieldName === "client") client = value;
      });
      parser.on("file", (fieldName, fileStream) => {
        if (fieldName !== "audio") {
          fileStream.resume();
          return;
        }
        const chunks: Buffer[] = [];
        audioChunks = chunks;
        fileStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        fileStream.on("limit", () => {
          audioTooLarge = true;
        });
        fileStream.on("error", reject);
      });
      parser.on("error", reject);
      parser.on("finish", resolve);
      request.pipe(parser);
    });

    if (audioTooLarge) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Audio too large (max 25 MB)" }));
      return;
    }
    // An empty transcription part must not select the "transcription follows:"
    // message, which would leave the agent looking for text that is not there.
    if (transcription !== undefined && transcription.trim() === "") {
      transcription = undefined;
    }

    if (transcription === undefined && audioChunks === undefined) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing transcription or audio" }));
      return;
    }
    if (client === undefined || client.trim() === "") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing client" }));
      return;
    }
    // Blank is checked separately from Number() below because Number("") is 0,
    // a valid date that would silently timestamp the recording as 1970.
    if (recordedAt === undefined || recordedAt.trim() === "") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing recordedAt" }));
      return;
    }

    const recordedAtMilliseconds = Number(recordedAt);
    if (!Number.isFinite(recordedAtMilliseconds)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid recordedAt" }));
      return;
    }
    const recordedAtDate = new Date(recordedAtMilliseconds);
    if (Number.isNaN(recordedAtDate.getTime())) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid recordedAt" }));
      return;
    }
    const recordedAtIso = recordedAtDate.toISOString();
    const message = transcription !== undefined
      ? audioChunks !== undefined
        ? `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Audio attached, transcription follows:\n\n${transcription}`
        : `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Transcription follows:\n\n${transcription}`
      : `Voice recording from Pebble Index, recorded at ${recordedAtIso}. Available as audio only, no transcription.`;

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));

    void (async (): Promise<void> => {
      let attachments: FileAttachment[] | undefined;
      if (audioChunks !== undefined) {
        const audio = Buffer.concat(audioChunks);
        const { storedPath } = await saveAttachment(audio, `recording-${recordedAt}.m4a`, "audio/mp4");
        attachments = [{ storedPath, originalFilename: `recording-${recordedAt}.m4a`, mimeType: "audio/mp4", size: audio.length }];
      }
      log.info("[stavrobot] Enqueueing Pebble Index recording from:", client);
      void enqueueMessage(message, "pebble-index", client, attachments);
    })().catch((error: unknown) => {
      log.error("[stavrobot] Error processing Pebble Index webhook:", error);
    });
  } catch (error) {
    log.error("[stavrobot] Error handling Pebble Index webhook request:", error);
    if (!response.headersSent) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: errorMessage }));
    }
  }
}
