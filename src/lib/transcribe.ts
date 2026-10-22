import OpenAI, { toFile } from "openai";
import { downloadFile } from "./telegram";

// Reads OPENAI_API_KEY from the environment. Created on first use so builds work without the key.
let client: OpenAI | undefined;

// Approximate OpenAI price per minute of audio, for the cost we store per post.
const PRICE_PER_MINUTE = 0.006;

export async function transcribeVoice(
  fileId: string,
  durationSeconds: number,
  fileName = "voice.ogg",
): Promise<{ text: string; costUsd: number }> {
  const audio = await downloadFile(fileId);
  client ??= new OpenAI();
  const result = await client.audio.transcriptions.create({
    // Telegram voice notes are OGG/Opus, which the API accepts as-is. The extension tells it the format.
    file: await toFile(Buffer.from(audio), fileName),
    model: "gpt-transcribe",
  });
  return {
    text: result.text.trim(),
    costUsd: (durationSeconds / 60) * PRICE_PER_MINUTE,
  };
}
