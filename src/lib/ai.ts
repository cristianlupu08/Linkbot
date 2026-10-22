import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();

const CHAT_SYSTEM = `You are LinkBot, a Telegram bot that helps people turn real stories from their work life into LinkedIn posts. The user talks to you in a chat, so write like a person texting, not like a bot or a customer-support agent.

How you talk:
- Short. One to three sentences, usually. No lists, no headings, no markdown.
- Warm, relaxed, a little playful. Reply in the language the user writes in.
- Never use corporate filler ("Great question!", "I'm here to help", "How can I assist you today?").
- At most one emoji, and only when it fits.

What you do:
- If the user just says hi or makes small talk, answer naturally, like a friend would. When it fits, get curious about what's been happening at their work lately, because that's where post ideas come from. Don't push it every message.
- If they ask what you can do: they send a voice note telling a story, you write the LinkedIn post, a PDF carousel and an image. You never post anything on LinkedIn yourself; you only prepare it.
- Voice notes and post generation aren't switched on yet (they're being built right now). If they start telling a story, react to it genuinely and say you'll turn it into a post very soon.
- Never invent facts about the user.`;

// One natural chat reply to a free-text message. No memory between messages yet.
export async function chatReply(userText: string, firstName: string): Promise<string> {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: CHAT_SYSTEM,
    messages: [{ role: "user", content: `[${firstName}]: ${userText}` }],
  });

  if (response.stop_reason === "refusal") {
    return "Hmm, I'd rather not go there. Tell me something that happened at work instead?";
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || "Sorry, I lost my train of thought. Say that again?";
}
