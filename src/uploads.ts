import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import busboy from "busboy";
import { enqueueMessage } from "./queue.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";

export interface FileAttachment {
  storedPath: string;
  originalFilename: string;
  mimeType: string;
  size: number;
}

export async function saveAttachment(
  data: Buffer,
  originalFilename: string,
  mimeType: string,
): Promise<{ storedPath: string; storedFilename: string }> {
  await fs.promises.mkdir(TEMP_ATTACHMENTS_DIR, { recursive: true });

  const extension = path.extname(originalFilename);
  const storedFilename = `upload-${crypto.randomUUID()}${extension}`;
  const storedPath = path.join(TEMP_ATTACHMENTS_DIR, storedFilename);

  log.debug("[stavrobot] Saving attachment to:", storedPath, "mimeType:", mimeType);

  await fs.promises.writeFile(storedPath, data);

  return { storedPath, storedFilename };
}

export async function handleUploadRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    const bb = busboy({ headers: request.headers, limits: { fileSize: 10 * 1024 * 1024 } });

    let originalFilename: string | undefined;
    let storedFilename: string | undefined;
    let storedPath: string | undefined;
    let mimeType: string | undefined;
    let fileSize = 0;
    let fileFieldSeen = false;
    let fileTruncated = false;

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

        const chunks: Buffer[] = [];

        fileStream.on("data", (chunk: Buffer) => {
          fileSize += chunk.length;
          chunks.push(chunk);
        });

        fileStream.on("limit", () => {
          fileTruncated = true;
          log.warn("[stavrobot] Upload rejected: file exceeds 10 MB limit");
        });

        fileStream.on("end", () => {
          if (fileTruncated) {
            // Discard the truncated data and signal completion so the caller
            // can return a 413 response.
            writeFinished = true;
            maybeResolve();
            return;
          }

          const data = Buffer.concat(chunks);
          const effectiveMimeType = mimeType ?? "application/octet-stream";

          saveAttachment(data, info.filename, effectiveMimeType)
            .then((result) => {
              storedFilename = result.storedFilename;
              storedPath = result.storedPath;
              writeFinished = true;
              maybeResolve();
            })
            .catch(reject);
        });

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

    if (fileTruncated) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "File too large (max 10 MB)" }));
      return;
    }

    if (!fileFieldSeen || storedFilename === undefined || storedPath === undefined) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing required 'file' field" }));
      return;
    }

    const effectiveOriginalFilename = originalFilename ?? storedFilename;
    const effectiveMimeType = mimeType ?? "application/octet-stream";

    const attachment: FileAttachment = {
      storedPath,
      originalFilename: effectiveOriginalFilename,
      mimeType: effectiveMimeType,
      size: fileSize,
    };

    log.debug("[stavrobot] File uploaded:", storedFilename, "size:", fileSize, "bytes");

    // Fire-and-forget: return the HTTP response immediately without waiting for the agent.
    void enqueueMessage(undefined, "upload", undefined, [attachment]);

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "File uploaded successfully", filename: storedFilename }));
  } catch (error) {
    log.error("[stavrobot] Error handling upload request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}
