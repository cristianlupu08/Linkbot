import { config } from "./config";
import { sendMessage, type TgUpdate } from "./telegram";

const WELCOME = [
  "Hi! I turn your stories into LinkedIn posts.",
  "You talk, I write the post, the carousel and the image.",
  "I never post anything for you, I just prepare it.",
  "",
  "Send me a voice note with your story.",
].join("\n");

// All bot logic for one incoming update. Runs after the webhook has already answered Telegram.
export async function handleUpdate(update: TgUpdate) {
  const message = update.message;
  if (!message?.from) return;

  const chatId = message.chat.id;

  if (!config.allowedUserIds.has(message.from.id)) {
    await sendMessage(chatId, "Access restricted.");
    return;
  }

  const text = message.text?.trim() ?? "";

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(chatId, WELCOME);
    return;
  }

  if (text) {
    // Stage 1: prove the bot is alive. Real handling comes in stage 2.
    await sendMessage(chatId, `Got it: "${text}"\n\nSoon you'll be able to send me a voice note here.`);
    return;
  }

  await sendMessage(chatId, "For now I only understand text. Voice notes are coming soon.");
}
