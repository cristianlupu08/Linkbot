import Anthropic from "@anthropic-ai/sdk";
import type { Slide } from "./carousel";
import type { ChatTurn, Variant } from "./db";
import { slideCount, type PostOptions } from "./options";

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

// One Claude call that must answer with JSON matching `schema`.
async function askJson<T>(
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
  effort: "low" | "medium",
): Promise<{ data: T; costUsd: number }> {
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort, format: { type: "json_schema", schema } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: userContent }],
  });
  if (response.stop_reason === "refusal") throw new AiRefusal("Claude declined the request");
  return { data: JSON.parse(textOf(response)) as T, costUsd: costOf(response.usage) };
}

const stringArray = { type: "array", items: { type: "string" } };

// ---------- Free chat ----------

const CHAT_SYSTEM = `You are LinkBot, a Telegram bot that helps people turn real stories from their work life into LinkedIn posts. The user talks to you in a chat, so write like a person texting, not like a bot or a customer-support agent.

How you talk:
- Short. One to three sentences, usually. No lists, no headings, no markdown.
- Warm, relaxed, a little playful. Reply in the language the user writes in.
- Never use corporate filler ("Great question!", "I'm here to help", "How can I assist you today?").
- At most one emoji, and only when it fits.

What you do:
- If the user just says hi or makes small talk, answer naturally, like a friend would. When it fits, get curious about what's been happening at their work lately, because that's where post ideas come from. Don't push it every message.
- If they ask what you can do: they send a voice note (or type) telling a story, you write the LinkedIn post, plus a PDF carousel or an image to go with it. You never post anything on LinkedIn yourself; you only prepare it.
- When they want to make a post, tell them to just send a voice note with the story, or type /new and write it out.
- /settings is where they add their photo, name and job title for the carousels and quote cards.
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

// ---------- Post variants, hooks and image idea ----------

const NO_INVENTION = `- Use only what is in the story. Never add numbers, names, places, events or results that the person didn't mention.
- Don't add plans, resolutions, advice or reflections the person didn't express (no "next time I'll…" unless they said it). You may phrase a lesson they stated more sharply.`;

const POST_SYSTEM = `You are a ghostwriter who turns a person's spoken story into a LinkedIn post that sounds like them, not like AI.

Structure that works on LinkedIn: a concrete moment -> the tension -> the turn -> the lesson. Short paragraphs (1-2 sentences), lots of white space. The first line must make people stop scrolling, because LinkedIn hides everything after roughly the first 200 characters behind "…see more".

Hard rules:
${NO_INVENTION}
- Keep the person's own words and expressions wherever they work. It should sound like them talking.
- Write in English. If the story is in another language, carry its meaning and voice over naturally.
- Banned: "In today's world", "game-changer", "Let's talk about", "Here's why", "Here's the thing", "I'm thrilled to announce", "humbled", "journey", "unlock", "delve", "leverage", "in the ever-evolving", "I'll be honest", "I say this sincerely", "Let that sink in". No empty motivational endings ("Never give up!", "Keep pushing!"). No em dashes; use commas or periods.
- Never include links in the post.
- End with 3 relevant hashtags on their own line.
- Plain text only, no markdown, no bold.

Write three versions:
- direct: gets to the point fast, clear and confident.
- personal: more emotion and inner thoughts, more "I".
- short: the tightest version, about half the length of the others.

Also write:
- hooks: 5 alternative first lines for the post. Ideally under 8 words. Curiosity, or the opposite of what you'd expect. Each must be true to the story.
- quote: the single most quotable line of the story for a quote card, under 20 words. Ideally the person's own words, lightly tightened. No hashtags, no emoji.
- imagePrompt: a description for an AI image to go with the post. A single striking scene or metaphor from the story, described visually (setting, light, mood, composition), photographic or editorial-illustration style. Don't show the storyteller's face or make them a specific person (the image must not misrepresent who they are): focus on the setting, objects, hands, or a figure seen from behind or far away. The image must contain no text, letters, numbers, logos, or readable screens.`;

const LENGTH_GUIDE: Record<PostOptions["length"], string> = {
  Short: "about 400-700 characters",
  Medium: "about 900-1400 characters",
  Long: "about 1600-2400 characters",
};

const EMOJI_GUIDE: Record<PostOptions["emoji"], string> = {
  None: "No emoji at all.",
  "A few": "One to three emoji, only where they feel natural.",
  Lots: "Use emoji generously, roughly one per paragraph.",
};

function endingGuide(ending: PostOptions["ending"], firstName: string) {
  if (ending === "Question") return "End with one short, genuine question that invites people to comment.";
  if (ending === "Follow me") {
    return `End with one short, natural line inviting people to follow ${firstName} for more stories like this. Not salesy.`;
  }
  return "End on the lesson itself. No question, no call to action.";
}

const VARIANT_LABELS = { direct: "Direct", personal: "Personal", short: "Short" } as const;

export async function generateVariants(
  transcript: string,
  options: PostOptions,
  firstName: string,
): Promise<{ variants: Variant[]; hooks: string[]; quote: string; imagePrompt: string; costUsd: number }> {
  const request = [
    `Tone: ${options.tone}.`,
    `Length of the direct and personal versions: ${LENGTH_GUIDE[options.length]}.`,
    `Written for: ${options.audience}.`,
    `Emoji: ${EMOJI_GUIDE[options.emoji]}`,
    `Ending: ${endingGuide(options.ending, firstName)}`,
    "",
    "The story, as the person told it:",
    "<story>",
    transcript,
    "</story>",
  ].join("\n");

  type Result = Record<keyof typeof VARIANT_LABELS, string> & {
    hooks: string[];
    quote: string;
    imagePrompt: string;
  };
  const { data, costUsd } = await askJson<Result>(
    POST_SYSTEM,
    request,
    {
      type: "object",
      properties: {
        direct: { type: "string" },
        personal: { type: "string" },
        short: { type: "string" },
        hooks: stringArray,
        quote: { type: "string" },
        imagePrompt: { type: "string" },
      },
      required: ["direct", "personal", "short", "hooks", "quote", "imagePrompt"],
      additionalProperties: false,
    },
    "medium",
  );

  const variants = (Object.keys(VARIANT_LABELS) as (keyof typeof VARIANT_LABELS)[]).map((key) => ({
    label: VARIANT_LABELS[key],
    text: data[key].trim(),
  }));
  return {
    variants,
    hooks: data.hooks.map((hook) => hook.trim()).filter(Boolean).slice(0, 5),
    quote: data.quote.trim(),
    imagePrompt: data.imagePrompt.trim(),
    costUsd,
  };
}

// ---------- Carousel text ----------

const STRUCTURE_GUIDE: Record<PostOptions["structure"], string> = {
  Story: "cover -> the moment -> the tension -> the turn -> the lesson(s) -> closing slide.",
  Tips: "cover -> one tip per slide, each drawn from the story -> closing slide.",
  "Before/After": "cover -> how it was before -> what changed -> how it is now -> the lesson -> closing slide.",
};

const SLIDES_SYSTEM = `You write the text for LinkedIn carousel slides (a swipeable PDF). The design is done by code; you only write words.

Rules:
- Every slide has a title and a body. Title: short and punchy, ideally under 8 words, max 12. Body: one or two short sentences.
- Max about 30 words per slide in total. Big text, so less is more.
- The cover title is the hook given to you, word for word. The cover body is a short teaser (under 10 words) that makes people swipe.
- Each slide should make people want the next one.
${NO_INVENTION}
- English. Plain text, no emoji (the font can't show them), no hashtags, no markdown, no slide numbers.
- No em dashes; use commas or periods.`;

function closingSlideGuide(ending: PostOptions["ending"], firstName: string) {
  if (ending === "Question") return "The closing slide asks the post's question to the reader (title) and invites comments (body).";
  if (ending === "Follow me") return `The closing slide invites people to follow ${firstName} for more stories like this.`;
  return "The closing slide states the single key takeaway, with no call to action.";
}

export async function generateSlides(
  post: string,
  hook: string,
  transcript: string,
  options: PostOptions,
  firstName: string,
): Promise<{ slides: Slide[]; costUsd: number }> {
  const count = slideCount(options);
  const request = [
    `Write exactly ${count} slides. Structure: ${STRUCTURE_GUIDE[options.structure]}`,
    closingSlideGuide(options.ending, firstName),
    `Tone: ${options.tone}. Written for: ${options.audience}.`,
    "",
    `Hook (the cover title): ${hook}`,
    "",
    "The post:",
    "<post>",
    post,
    "</post>",
    "",
    "The original story:",
    "<story>",
    transcript,
    "</story>",
  ].join("\n");

  const { data, costUsd } = await askJson<{ slides: Slide[] }>(
    SLIDES_SYSTEM,
    request,
    {
      type: "object",
      properties: {
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
            required: ["title", "body"],
            additionalProperties: false,
          },
        },
      },
      required: ["slides"],
      additionalProperties: false,
    },
    "medium",
  );
  const slides = data.slides
    .map((slide) => ({ title: slide.title.trim(), body: slide.body?.trim() }))
    .filter((slide) => slide.title)
    .slice(0, count);
  return { slides, costUsd };
}

// ---------- Score and first comment ----------

const REVIEW_SYSTEM = `You are a blunt, kind LinkedIn editor. Rate a post from 1 to 10 for how well it will do on LinkedIn: hook strength, concreteness, readability on a phone, authenticity (does it sound like a real person, not AI), and the ending.

Be honest: 9-10 is rare. Give 1 or 2 tips, each one short, specific and actionable for this exact post (quote the part you mean). No generic advice. If it's already strong, one tip is enough.

Also write firstComment: the comment the author should post under their own post right after publishing, to get the conversation going. One to three short sentences, in the author's voice, adding a small extra detail or angle from the story (never invented) or asking readers something specific. If the story mentions a link or resource, put it here. Plain text, at most one emoji.`;

export async function reviewPost(
  post: string,
  transcript: string,
): Promise<{ score: number; tips: string[]; firstComment: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ score: number; tips: string[]; firstComment: string }>(
    REVIEW_SYSTEM,
    `<post>\n${post}\n</post>\n\nThe original story, for the first comment:\n<story>\n${transcript}\n</story>`,
    {
      type: "object",
      properties: { score: { type: "integer" }, tips: stringArray, firstComment: { type: "string" } },
      required: ["score", "tips", "firstComment"],
      additionalProperties: false,
    },
    "low",
  );
  return {
    score: Math.min(10, Math.max(1, Math.round(data.score))),
    tips: data.tips.slice(0, 2),
    firstComment: data.firstComment.trim(),
    costUsd,
  };
}

// ---------- Adjustments after the final post ----------

const REVISE_SYSTEM = `You edit a LinkedIn post on request. Change only what the instruction asks for and keep everything else exactly as it is: same words, same line breaks, same hashtags.

Rules:
${NO_INVENTION}
- If the instruction asks for a fact that isn't in the story (e.g. "add a number"), use only facts from the story; if there is none, make the smallest change that honors the spirit of the request without inventing.
- No em dashes. Plain text, no markdown.
- Return the full revised post.`;

export async function revisePost(
  post: string,
  instruction: string,
  transcript: string,
): Promise<{ text: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ post: string }>(
    REVISE_SYSTEM,
    [
      `Instruction: ${instruction}`,
      "",
      "<post>",
      post,
      "</post>",
      "",
      "The original story (the only source of facts):",
      "<story>",
      transcript,
      "</story>",
    ].join("\n"),
    {
      type: "object",
      properties: { post: { type: "string" } },
      required: ["post"],
      additionalProperties: false,
    },
    "low",
  );
  return { text: data.post.trim(), costUsd };
}

// ---------- /ideas: questions that pull a story out ----------

const IDEAS_SYSTEM = `You help someone find a story from their work life worth posting on LinkedIn. Ask exactly 3 questions that each pull out one concrete moment (a specific day, a conversation, a mistake, a win, a surprise).

Rules:
- Each question is short (under 20 words), specific and easy to answer out loud in a voice note.
- Make the 3 questions different kinds: e.g. a mistake or failure, a person who changed their mind about something, a small win or surprise.
- Avoid generic prompts like "What's your biggest achievement?". Ask about moments, not opinions.
- If you know their job, tailor the questions to it. Don't repeat topics they've already posted about.
- English, plain text, no emoji.`;

export async function ideaQuestions(
  headline: string | undefined,
  recentTopics: string[],
): Promise<{ questions: string[]; costUsd: number }> {
  const context = [
    headline ? `Their job: ${headline}` : "Their job: unknown",
    recentTopics.length ? `Recent posts (avoid these topics):\n${recentTopics.map((t) => `- ${t}`).join("\n")}` : "",
    `Random seed for variety: ${Math.random().toString(36).slice(2, 8)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { data, costUsd } = await askJson<{ questions: string[] }>(
    IDEAS_SYSTEM,
    context,
    {
      type: "object",
      properties: { questions: stringArray },
      required: ["questions"],
      additionalProperties: false,
    },
    "low",
  );
  return { questions: data.questions.map((q) => q.trim()).filter(Boolean).slice(0, 3), costUsd };
}

// ---------- /banner: tagline suggestions ----------

const TAGLINE_SYSTEM = `You write the one-line text for someone's LinkedIn profile banner. It says what they do and why it matters, in their own human voice.

Rules:
- Exactly 3 options, each under 60 characters. Different angles: one about what they build or do, one about who they help, one with a bit of personality.
- No buzzwords ("passionate", "synergy", "results-driven", "ninja", "guru"), no em dashes, no emoji, no hashtags.
- Use only what you know about them; don't invent achievements or employers.
- English.`;

export async function suggestTaglines(
  name: string,
  headline: string | undefined,
  recentTopics: string[],
): Promise<string[]> {
  const context = [
    `Name: ${name}`,
    headline ? `Job title: ${headline}` : "Job title: unknown",
    recentTopics.length ? `Things they've posted about:\n${recentTopics.map((t) => `- ${t}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const { data } = await askJson<{ taglines: string[] }>(
    TAGLINE_SYSTEM,
    context,
    {
      type: "object",
      properties: { taglines: stringArray },
      required: ["taglines"],
      additionalProperties: false,
    },
    "low",
  );
  return data.taglines.map((t) => t.trim()).filter(Boolean).slice(0, 3);
}
