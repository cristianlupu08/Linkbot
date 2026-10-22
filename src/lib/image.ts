import OpenAI from "openai";

// Reads OPENAI_API_KEY from the environment. Created on first use so builds work without the key.
let client: OpenAI | undefined;

// Approximate OpenAI price per image at this size and quality, for the cost we store per post.
const PRICE_PER_IMAGE = 0.05;

export async function generateImage(prompt: string): Promise<{ png: Buffer; costUsd: number }> {
  client ??= new OpenAI();
  const result = await client.images.generate({
    model: "gpt-image-2",
    prompt: `${prompt}\n\nAbsolutely no text, letters, words, numbers, logos or watermarks anywhere in the image.`,
    // Portrait takes the most space in the LinkedIn feed.
    size: "1024x1536",
    quality: "medium",
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { png: Buffer.from(b64, "base64"), costUsd: PRICE_PER_IMAGE };
}
