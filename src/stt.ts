import type { SttConfig } from "./config.js";

export async function transcribeAudio(audio: Buffer, config: SttConfig): Promise<string> {
  console.log("[stavrobot] transcribeAudio called: audio size", audio.byteLength, "bytes");

  const formData = new FormData();
  formData.append("model", config.model);
  formData.append("file", new Blob([new Uint8Array(audio)]), "audio.ogg");

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
