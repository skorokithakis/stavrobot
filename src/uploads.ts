import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import busboy from "busboy";
import { enqueueMessage } from "./queue.js";

export const UPLOADS_DIR = "/tmp/uploads";

export async function handleUploadRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });

    const bb = busboy({ headers: request.headers });

    let originalFilename: string | undefined;
    let storedFilename: string | undefined;
    let mimeType: string | undefined;
    let fileSize = 0;
    let fileFieldSeen = false;

    const fileWritePromise = new Promise<void>((resolve, reject) => {
      // Both conditions must be true before resolving: the file write must be
      // complete and busboy must have finished parsing all fields. This ensures
      // that fields appearing after the file part (e.g. "filename") are captured
      // before we read originalFilename.
      let writeFinished = false;
      let busboyFinished = false;

      function maybeResolve(): void {
        if (writeFinished && busboyFinished) {
          resolve();
        }
      }

      bb.on("file", (fieldname, fileStream, info) => {
        if (fieldname !== "file") {
          // Drain unrecognised file fields so busboy can continue parsing.
          fileStream.resume();
          return;
        }

        fileFieldSeen = true;
        mimeType = info.mimeType;

        const extension = path.extname(info.filename);
        const randomName = `upload-${crypto.randomUUID()}${extension}`;
        storedFilename = randomName;
        const filePath = path.join(UPLOADS_DIR, randomName);

        console.log("[stavrobot] Saving upload to:", filePath, "mimeType:", mimeType);

        const writeStream = fs.createWriteStream(filePath);

        fileStream.on("data", (chunk: Buffer) => {
          fileSize += chunk.length;
        });

        fileStream.pipe(writeStream);

        writeStream.on("finish", () => {
          writeFinished = true;
          maybeResolve();
        });
        writeStream.on("error", reject);
        fileStream.on("error", reject);
      });

      bb.on("field", (fieldname, value) => {
        if (fieldname === "filename") {
          originalFilename = value;
        }
      });

      bb.on("error", reject);

      bb.on("finish", () => {
        busboyFinished = true;
        if (!fileFieldSeen) {
          // No file field was present; resolve immediately so the caller can
          // return a 400 response.
          resolve();
        } else {
          maybeResolve();
        }
      });
    });

    request.pipe(bb);

    await fileWritePromise;

    if (!fileFieldSeen || storedFilename === undefined) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing required 'file' field" }));
      return;
    }

    const effectiveOriginalFilename = originalFilename ?? storedFilename;
    const effectiveMimeType = mimeType ?? "application/octet-stream";

    const fullPath = path.join(UPLOADS_DIR, storedFilename);
    const agentMessage =
      `A file has been uploaded.\n\n` +
      `Original filename: ${effectiveOriginalFilename}\n` +
      `Stored at: ${fullPath}\n` +
      `MIME type: ${effectiveMimeType}\n` +
      `Size: ${fileSize} bytes\n\n` +
      `You do not need to read this file right now. Use the read_upload tool if and when you need to access its contents.`;

    console.log("[stavrobot] File uploaded:", storedFilename, "size:", fileSize, "bytes");

    // Fire-and-forget: return the HTTP response immediately without waiting for the agent.
    void enqueueMessage(agentMessage, "upload");

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "File uploaded successfully", filename: storedFilename }));
  } catch (error) {
    console.error("[stavrobot] Error handling upload request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}
