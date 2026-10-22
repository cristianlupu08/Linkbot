import OpenAI from "openai";

// Reads OPENAI_API_KEY from the environment. Created on first use so builds work without the key.
let client: OpenAI | undefined;

// Approximate OpenAI price per image at this size and quality, for the cost we store per post.
const PRICE_PER_IMAGE = 0.05;

// Appended to every prompt so images look like real photos, not like AI.
const REALISM = `Style: an authentic, candid photograph that looks taken by a real person with a phone or a 35mm camera. Natural available light, true-to-life colors, realistic textures and small everyday imperfections, an ordinary real-world setting, slight grain, natural depth of field. Not a stock photo, not cinematic: no dramatic lighting, no glossy or plastic-looking skin, no oversaturated colors, no perfect symmetry, no fantasy or surreal elements, no illustration, painting or 3D-render look.

Absolutely no text, letters, words, numbers, logos or watermarks anywhere in the image.`;

// Portrait takes the most space in the LinkedIn feed; carousel photos are landscape.
export async function generateImage(
  prompt: string,
  size: "1024x1536" | "1536x1024" = "1024x1536",
): Promise<{ png: Buffer; costUsd: number }> {
  client ??= new OpenAI();
  const result = await client.images.generate({
    model: "gpt-image-2",
    prompt: `${prompt}\n\n${REALISM}`,
    size,
    quality: "medium",
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { png: Buffer.from(b64, "base64"), costUsd: PRICE_PER_IMAGE };
}
