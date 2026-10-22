import { chatReply } from "./ai";
import { config } from "./config";
import { sendMessage, sendTyping, type TgUpdate } from "./telegram";

function welcome(firstName: string) {
  return [
    `Hey ${firstName} 👋`,
    "",
    "Got something from work lately you keep thinking about? A win, a mess-up, a weird day?",
    "",
    "Just hit the mic and tell me like you'd tell a friend. I'll turn it into a LinkedIn post, and you decide if it ever goes out.",
  ].join("\n");
}

// All bot logic for one incoming update. Runs after the webhook has already answered Telegram.
export async function handleUpdate(update: TgUpdate) {
  const message = update.message;
  if (!message?.from) return;

  const chatId = message.chat.id;
  const firstName = message.from.first_name;

  if (!config.allowedUserIds.has(message.from.id)) {
    await sendMessage(chatId, "Access restricted.");
    return;
  }

  const text = message.text?.trim() ?? "";

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(chatId, welcome(firstName));
    return;
  }

  if (text) {
    await sendTyping(chatId);
    await sendMessage(chatId, await chatReply(text, firstName));
    return;
  }

  await sendMessage(chatId, "I can't open that one yet. Voice notes are coming very soon, for now just type to me.");
}
