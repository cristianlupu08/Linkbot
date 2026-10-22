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

const CHAT_SYSTEM = `You are LinkBot, a Telegram bot that helps people turn real stories from their life, at work or anywhere else, into LinkedIn posts. The user talks to you in a chat, so write like a person texting, not like a bot or a customer-support agent.

How you talk:
- Short. One to three sentences, usually. No lists, no headings, no markdown.
- Friendly but professional, like a sharp colleague. Reply in the language the user writes in.
- Never use corporate filler ("Great question!", "I'm here to help", "How can I assist you today?").
- No emoji unless the user uses them first.

What you do:
- If the user just says hi or makes small talk, answer naturally, like a friend would. When it fits, get curious about what's been happening in their life lately (work, a project, sport, a trip, anything they learned from), because that's where post ideas come from. Don't push it every message.
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
    return "I can't help with that. Is there a story you'd like to turn into a post?";
  }
  return textOf(response) || "Sorry, something went wrong. Could you repeat that?";
}

// ---------- Post variants, hooks and image idea ----------

const NO_INVENTION = `- Use only what is in the story. Never add numbers, names, places, events or results that the person didn't mention.
- Don't add plans, resolutions, advice or reflections the person didn't express (no "next time I'll…" unless they said it). You may phrase a lesson they stated more sharply.`;

const POST_SYSTEM = `You are a ghostwriter who turns a person's spoken story into a LinkedIn post that sounds like them, not like AI.

It must read like a strong LinkedIn post, not like a chat message.

The top (what people see before "…see more"):
- On mobile LinkedIn shows only about the first 3 lines (~140 characters). Everything that decides whether people keep reading must be there.
- Line 1 is the hook: short, concrete, standing alone on its own line. Curiosity, tension or a surprising contrast. Never a greeting, never "I want to share".
- Line 2 (after a blank line) deepens the hook so people tap "see more": the stakes, a twist, or the moment it went wrong.

The body:
- Story arc: a concrete moment -> the tension or cost -> the turn -> what it taught them.
- Paragraphs of 1 to 3 sentences, separated by exactly one blank line. Never a wall of text.
- Vary the rhythm on purpose. Use a few short one-line paragraphs for punch at key moments, mixed with normal 2-3 sentence paragraphs. Do NOT put every single sentence on its own line: a post made only of one-liners looks like a stream of chat messages.
- Concrete beats abstract: specific moments, numbers and words they actually said.
- If there are several lessons or steps, a short list is fine: each item on its own line starting with "→ " or "1. ", 2 to 4 items, no blank lines inside the list.

The end:
- The lesson in one or two plain sentences, then the ending asked for (a specific question that's easy to answer, an invitation to follow, or nothing). Never "Agree?", "Thoughts?" alone, or engagement bait like "Comment YES".
- Then one blank line and 3 to 5 relevant hashtags on the last line, nothing after them.

Hard rules:
${NO_INVENTION}
- Keep the person's own words and expressions wherever they work. It should sound like them talking.
- Write in English. If the story is in another language, carry its meaning and voice over naturally.
- Banned: "In today's world", "game-changer", "Let's talk about", "Here's why", "Here's the thing", "I'm thrilled to announce", "humbled", "journey", "unlock", "delve", "leverage", "in the ever-evolving", "I'll be honest", "I say this sincerely", "Let that sink in". No empty motivational endings ("Never give up!", "Keep pushing!"). No em dashes; use commas or periods.
- Never include links in the post.
- Plain text only: LinkedIn shows no markdown, so no **bold**, no # headings, no bullet asterisks.

Write three versions:
- direct: gets to the point fast, clear and confident.
- personal: more emotion and inner thoughts, more "I".
- short: the tightest version, about half the length of the others.

Also write:
- hooks: 5 alternative first lines for the post. Ideally under 8 words. Curiosity, or the opposite of what you'd expect. Each must be true to the story.
- quote: the single most quotable line of the story for a quote card, under 20 words. Ideally the person's own words, lightly tightened. No hashtags, no emoji.
- imagePrompt: a description for an image to go with the post. A single believable scene from the story, described visually (setting, light, mood, composition), as a realistic candid photo. Don't show the storyteller's face or make them a specific person (the image must not misrepresent who they are): focus on the setting, objects, hands, or a figure seen from behind or far away. The image must contain no text, letters, numbers, logos, or readable screens.`;

// Story posts do best around 1,300-2,000 characters; LinkedIn's limit is 3,000.
const LENGTH_GUIDE: Record<PostOptions["length"], string> = {
  Short: "about 500-800 characters",
  Medium: "about 1200-1700 characters",
  Long: "about 1800-2600 characters",
};

// Makes the spacing LinkedIn-clean whatever the model returned: one blank line between paragraphs,
// no trailing spaces, no markdown bold, hashtags alone on the last line.
export function formatForLinkedIn(text: string): string {
  let out = text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = out.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const isHashtagLine = (line: string) => /^(#\w+\s*)+$/.test(line.trim());
  if (isHashtagLine(last) && lines.length > 1 && lines[lines.length - 2].trim() !== "") {
    out = `${lines.slice(0, -1).join("\n")}\n\n${last.trim()}`;
  }
  return out;
}

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
  styleGuide?: string,
): Promise<{ variants: Variant[]; hooks: string[]; quote: string; imagePrompt: string; costUsd: number }> {
  const request = [
    `Tone: ${options.tone}.`,
    `Length of the direct and personal versions: ${LENGTH_GUIDE[options.length]}.`,
    `Written for: ${options.audience}.`,
    `Emoji: ${EMOJI_GUIDE[options.emoji]}`,
    `Ending: ${endingGuide(options.ending, firstName)}`,
    ...styleLines(styleGuide),
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
    text: formatForLinkedIn(data[key]),
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

// ---------- Final polish, score and first comment ----------

const POLISH_SYSTEM = `You are a sharp LinkedIn editor doing a final pass on a post before the author sees it.

1. Polish: fix craft problems yourself. Cut filler lines ("That is my story", "as it happened"), recap paragraphs that repeat what was already said, clichés and anything that sounds like AI. Tighten weak sentences.
   Fix the LinkedIn formatting too: paragraphs of 1 to 3 sentences separated by exactly one blank line. If almost every sentence sits on its own line (it reads like a stream of chat messages), group related sentences into short paragraphs and keep only a few one-liners for punch. Hashtags alone on the last line.
   Hard limits: keep the first line exactly as it is. Keep the overall structure, voice and ending type. Keep the hashtags. Never add facts, numbers, names, places or events that aren't in the story. If the post is already good, return it unchanged.
2. Score the polished post from 1 to 10 for how well it will do on LinkedIn: hook, concreteness, readability on a phone, authenticity, ending. Be honest, 9-10 is rare.
3. question: only if the post would be clearly stronger with one fact that only the author knows and that the story doesn't contain, write one short question asking for it (under 20 words). Otherwise an empty string.
4. firstComment: the comment the author should post under their own post right after publishing. One to three short sentences, in the author's voice, adding a small extra detail or angle from the story (never invented) or asking readers something specific. If the story mentions a link or resource, put it here. Plain text, no emoji unless the post uses them.

No em dashes. Plain text, no markdown.`;

export async function polishPost(
  post: string,
  transcript: string,
): Promise<{ text: string; score: number; question: string; firstComment: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ post: string; score: number; question: string; firstComment: string }>(
    POLISH_SYSTEM,
    `<post>\n${post}\n</post>\n\nThe original story (the only source of facts):\n<story>\n${transcript}\n</story>`,
    {
      type: "object",
      properties: {
        post: { type: "string" },
        score: { type: "integer" },
        question: { type: "string" },
        firstComment: { type: "string" },
      },
      required: ["post", "score", "question", "firstComment"],
      additionalProperties: false,
    },
    "medium",
  );
  return {
    text: formatForLinkedIn(data.post.trim() || post),
    score: Math.min(10, Math.max(1, Math.round(data.score))),
    question: data.question.trim(),
    firstComment: data.firstComment.trim(),
    costUsd,
  };
}

// ---------- Adjustments after the final post ----------

const REVISE_SYSTEM = `You edit a LinkedIn post on request. Change only what the instruction asks for and keep everything else exactly as it is: same words, same line breaks, same hashtags.

Rules:
${NO_INVENTION}
- If the instruction asks for a fact that isn't in the story (e.g. "add a number"), use only facts from the story; if there is none, make the smallest change that honors the spirit of the request without inventing.
- Keep the LinkedIn formatting: paragraphs of 1 to 3 sentences separated by one blank line, hashtags alone on the last line.
- No em dashes. Plain text, no markdown.
- Return the full revised post.`;

export async function revisePost(
  post: string,
  instruction: string,
  transcript: string,
  styleGuide?: string,
): Promise<{ text: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ post: string }>(
    REVISE_SYSTEM,
    [
      `Instruction: ${instruction}`,
      ...styleLines(styleGuide),
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
  return { text: formatForLinkedIn(data.post), costUsd };
}

// ---------- /ideas: questions that pull a story out ----------

const IDEAS_SYSTEM = `You help someone find a story from their life worth posting on LinkedIn. It can come from anywhere: work, a side project, sport, travel, family, a hobby. Ask exactly 3 questions that each pull out one concrete moment (a specific day, a conversation, a mistake, a win, a surprise).

Rules:
- Each question is short (under 20 words), specific and easy to answer out loud in a voice note.
- Make the 3 questions different kinds: e.g. a mistake or failure, a person who changed their mind about something, a small win or surprise.
- Avoid generic prompts like "What's your biggest achievement?". Ask about moments, not opinions.
- Mix areas of life: not all 3 about work. If you know their job, at most one question can be about it. Don't repeat topics they've already posted about.
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

// ---------- Personal style (/style) ----------

function styleLines(styleGuide?: string) {
  return styleGuide
    ? ["", "Write in this person's own style, learned from their past posts (style only, never reuse their facts):", styleGuide]
    : [];
}

const STYLE_SYSTEM = `You study someone's past LinkedIn posts and describe how they write, so a ghostwriter can match it.

Describe only style, never topics or facts: sentence length and rhythm, paragraph length, how they open, how they close, use of questions, emoji (how many, which kind), hashtags, formatting (line breaks, lists), vocabulary and register (formal, casual, technical), humor, and any signature phrases.

Write guide: 6 to 10 short bullet lines starting with "- ", concrete and specific ("Opens with a one-line confession", not "engaging openings").
Write summary: one short sentence describing their style, for the user to read. English.`;

export async function learnStyle(samples: string[]): Promise<{ guide: string; summary: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ guide: string; summary: string }>(
    STYLE_SYSTEM,
    samples.map((sample, i) => `<post ${i + 1}>\n${sample}\n</post ${i + 1}>`).join("\n\n"),
    {
      type: "object",
      properties: { guide: { type: "string" }, summary: { type: "string" } },
      required: ["guide", "summary"],
      additionalProperties: false,
    },
    "low",
  );
  return { guide: data.guide.trim(), summary: data.summary.trim(), costUsd };
}

// ---------- Interview: questions about the story before writing ----------

const INTERVIEW_SYSTEM = `You interview someone about a story they told for a LinkedIn post, so the post can be written well. You ask one question at a time and decide the next one based on everything they've said so far.

Ask about what's genuinely missing, most important first:
- The stakes: what it cost them (time, money, effort, a risk, a mistake, a hard conversation). Stories without a cost read like bragging.
- The why: why they did what they did, what was going through their head.
- Concrete details that make it real: where, when, who (roles, not necessarily names), numbers they can share.
- How it ended, and what they took from it, if that's unclear.

Rules:
- Return the single best next question, short (under 20 words), specific to this story, easy to answer out loud.
- Never ask about something they already answered or that the story already makes clear.
- If the story now has clear stakes, enough concrete detail and a clear ending, return an empty question. Don't ask for nice-to-haves.
- Be sparing: a complete story needs no questions, most stories need one or two. When in doubt, return an empty question.
- English, plain text.`;

export async function nextInterviewQuestion(
  transcript: string,
  skipped: string[],
): Promise<{ question: string; costUsd: number }> {
  const skippedNote = skipped.length
    ? `\n\nQuestions they chose to skip (don't ask these or anything close to them):\n${skipped.map((q) => `- ${q}`).join("\n")}`
    : "";
  const { data, costUsd } = await askJson<{ question: string }>(
    INTERVIEW_SYSTEM,
    `<story>\n${transcript}\n</story>${skippedNote}`,
    {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    "low",
  );
  return { question: data.question.trim(), costUsd };
}

// ---------- Image brief: understand what the user wants before generating ----------

const IMAGE_PLANNER_SYSTEM = `You help someone get the right image for their LinkedIn post. They describe what they want; you make sure you understand it before anything is generated.

Return:
- question: if something important about the image is unclear (the main subject, the setting, whether people appear and how, the mood or time of day), one short question about the most important unclear point, under 20 words. A first description of only a few words almost always leaves something important open, so ask. Once you understand enough to create it, an empty string. Don't ask about nice-to-haves, and never about something already answered. If the brief asks you to suggest an image yourself, don't ask anything.
- summary: one or two plain sentences describing the image you would create, for the user to confirm. Use their words.
- prompt: a detailed prompt for an image model: subject, setting, composition, light, mood, camera angle. Only what the user described or clearly implied; fill gaps with ordinary, believable choices that fit the post.

The image must look like a real photograph, never like AI: a candid, ordinary, believable scene. Don't show the author's face unless they explicitly ask for a person who is them; prefer hands, objects, places, or people from behind. No text, letters, numbers, logos or readable screens. English.`;

export async function planImage(
  conversation: string,
  post: string,
): Promise<{ question: string; summary: string; prompt: string; costUsd: number }> {
  const { data, costUsd } = await askJson<{ question: string; summary: string; prompt: string }>(
    IMAGE_PLANNER_SYSTEM,
    `The post:\n<post>\n${post}\n</post>\n\nWhat they've said about the image so far:\n<brief>\n${conversation}\n</brief>`,
    {
      type: "object",
      properties: { question: { type: "string" }, summary: { type: "string" }, prompt: { type: "string" } },
      required: ["question", "summary", "prompt"],
      additionalProperties: false,
    },
    "low",
  );
  return { question: data.question.trim(), summary: data.summary.trim(), prompt: data.prompt.trim(), costUsd };
}
