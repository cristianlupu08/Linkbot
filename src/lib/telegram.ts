import { config } from "./config";

// Minimal types for the parts of the Telegram Bot API we use.
// Full reference: https://core.telegram.org/bots/api

export type TgUser = {
  id: number;
  first_name: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: string;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
};

export type ReplyMarkup = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

async function callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description}`);
  }
  return data.result as T;
}

export function sendMessage(
  chatId: number,
  text: string,
  options: { replyMarkup?: ReplyMarkup; parseMode?: "HTML" } = {},
) {
  return callApi<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: options.replyMarkup,
    parse_mode: options.parseMode,
  });
}

export function sendTyping(chatId: number) {
  return callApi<boolean>("sendChatAction", { chat_id: chatId, action: "typing" });
}
