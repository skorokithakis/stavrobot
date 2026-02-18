import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { SttConfig } from "./config.js";

const execFileAsync = promisify(execFile);

// MIME types accepted by the OpenAI transcription API.
const SUPPORTED_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/mpga",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
]);

// Maps MIME types to file extensions for the Blob filename. OpenAI uses the
// filename extension to determine the audio format.
const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/mpga": "mpga",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

async function convertToMp3(audio: Buffer, inputExtension: string): Promise<Buffer> {
  const inputPath = join(tmpdir(), `stavrobot-stt-input-${Date.now()}.${inputExtension}`);
  const outputPath = join(tmpdir(), `stavrobot-stt-output-${Date.now()}.mp3`);

  try {
    await writeFile(inputPath, audio);
    console.log("[stavrobot] convertToMp3: running ffmpeg on", inputPath);
    await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-c:a", "libmp3lame", "-q:a", "2", outputPath]);
    const converted = await readFile(outputPath);
    console.log("[stavrobot] convertToMp3: converted to mp3, size:", converted.byteLength, "bytes");
    return converted;
  } finally {
    await unlink(inputPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}

export async function transcribeAudio(audio: Buffer, config: SttConfig, contentType: string): Promise<string> {
  console.log("[stavrobot] transcribeAudio called: audio size", audio.byteLength, "bytes, contentType:", contentType);

  let audioBuffer = audio;
  let blobFilename: string;

  if (SUPPORTED_CONTENT_TYPES.has(contentType)) {
    const extension = CONTENT_TYPE_TO_EXTENSION[contentType] ?? "ogg";
    blobFilename = `audio.${extension}`;
  } else {
    // Strip parameters (e.g. "audio/aac; codecs=...") before using as extension.
    const baseType = contentType.split(";")[0].trim();
    const inputExtension = baseType.split("/")[1] ?? "bin";
    console.log("[stavrobot] transcribeAudio: unsupported content type", contentType, "- converting to mp3 via ffmpeg");
    audioBuffer = await convertToMp3(audio, inputExtension);
    blobFilename = "audio.mp3";
  }

  const formData = new FormData();
  formData.append("model", config.model);
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), blobFilename);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[stavrobot] transcribeAudio error:", response.status, errorText);
    throw new Error(`OpenAI STT API error ${response.status}: ${errorText}`);
  }

  const result = await response.json() as unknown;
  const text = (result as { text: string }).text;

  console.log("[stavrobot] transcribeAudio success: transcribed", text.length, "characters");

  return text;
}
