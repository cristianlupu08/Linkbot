import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, Variant } from "./db";
import type { PostOptions } from "./options";

// Reads ANTHROPIC_API_KEY from the environment. Created on first use so builds work without the key.
let anthropic: Anthropic | undefined;
const client = () => (anthropic ??= new Anthropic());

const MODEL = "claude-opus-5-5";
// Claude Opus 5.5 list prices, USD per token. Used for the approximate cost we store per post.
const PRICE_IN = 4 / 1_000_000;
const PRICE_OUT = 20 / 1_000_000;

export class AiRefusal extends Error {}

function costOf(usage: Anthropic.Beta.BetaUsage) {
  const input =
    usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return input * PRICE_IN + usage.output_tokens * PRICE_OUT;
}

function textOf(response: Anthropic.Beta.BetaMessage) {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

// ---------- Free chat ----------

const CHAT_SYSTEM = `You are LinkBot, a Telegram bot that helps people turn real stories from their work life into LinkedIn posts. The user talks to you in a chat, so write like a person texting, not like a bot or a customer-support agent.

How you talk:
- Short. One to three sentences, usually. No lists, no headings, no markdown.
- Warm, relaxed, a little playful. Reply in the language the user writes in.
- Never use corporate filler ("Great question!", "I'm here to help", "How can I assist you today?").
- At most one emoji, and only when it fits.

What you do:
- If the user just says hi or makes small talk, answer naturally, like a friend would. When it fits, get curious about what's been happening at their work lately, because that's where post ideas come from. Don't push it every message.
- If they ask what you can do: they send a voice note (or type) telling a story, you write the LinkedIn post. You never post anything on LinkedIn yourself; you only prepare it.
- When they want to make a post, tell them to just send a voice note with the story, or type /new and write it out.
- If they start telling a story in the chat, react to it genuinely and suggest sending it as a voice note (or with /new) so you can turn it into a post.
- Never invent facts about the user.`;

export async function chatReply(history: ChatTurn[], firstName: string): Promise<string> {
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: `${CHAT_SYSTEM}\n\nThe user's first name is ${firstName}.`,
    messages: history,
  });

  if (response.stop_reason === "refusal") {
    return "Hmm, I'd rather not go there. Tell me something that happened at work instead?";
  }
  return textOf(response) || "Sorry, I lost my train of thought. Say that again?";
}

// ---------- Post variants ----------

const POST_SYSTEM = `You are a ghostwriter who turns a person's spoken story into a LinkedIn post that sounds like them, not like AI.

Structure that works on LinkedIn: a concrete moment -> the tension -> the turn -> the lesson. Short paragraphs (1-2 sentences), lots of white space, a first line that makes people stop scrolling.

Hard rules:
- Use only what is in the story. Never add numbers, names, places, events or results that the person didn't mention.
- Keep the person's own words and expressions wherever they work. It should sound like them talking.
- Write in English. If the story is in another language, carry its meaning and voice over naturally.
- Banned: "In today's world", "game-changer", "Let's talk about", "Here's why", "Here's the thing", "I'm thrilled to announce", "humbled", "journey", "unlock", "delve", "leverage", "in the ever-evolving". No empty motivational endings ("Never give up!", "Keep pushing!"). No em dashes; use commas or periods.
- No emoji unless one really fits; never more than two.
- Never include links in the post.
- End with 3 relevant hashtags on their own line.
- Plain text only, no markdown, no bold.

Write three versions:
- direct: gets to the point fast, clear and confident.
- personal: more emotion and inner thoughts, more "I".
- short: the tightest version, about half the length of the others.`;

const LENGTH_GUIDE: Record<PostOptions["length"], string> = {
  Short: "about 400-700 characters",
  Medium: "about 900-1400 characters",
  Long: "about 1600-2400 characters",
};

const VARIANT_LABELS = { direct: "Direct", personal: "Personal", short: "Short" } as const;

export async function generateVariants(
  transcript: string,
  options: PostOptions,
): Promise<{ variants: Variant[]; costUsd: number }> {
  const request = [
    `Tone: ${options.tone}.`,
    `Length of the direct and personal versions: ${LENGTH_GUIDE[options.length]}.`,
    `Written for: ${options.audience}.`,
    "",
    "The story, as the person told it:",
    "<story>",
    transcript,
    "</story>",
  ].join("\n");

  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            direct: { type: "string" },
            personal: { type: "string" },
            short: { type: "string" },
          },
          required: ["direct", "personal", "short"],
          additionalProperties: false,
        },
      },
    },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: POST_SYSTEM,
    messages: [{ role: "user", content: request }],
  });

  if (response.stop_reason === "refusal") throw new AiRefusal("Claude declined the story");

  const parsed = JSON.parse(textOf(response)) as Record<keyof typeof VARIANT_LABELS, string>;
  const variants = (Object.keys(VARIANT_LABELS) as (keyof typeof VARIANT_LABELS)[]).map((key) => ({
    label: VARIANT_LABELS[key],
    text: parsed[key].trim(),
  }));
  return { variants, costUsd: costOf(response.usage) };
}
