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

export type TgAudioFile = {
  file_id: string;
  duration: number;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  voice?: TgAudioFile;
  audio?: TgAudioFile;
  forward_origin?: unknown;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type Button = { text: string; callback_data: string };
export type ReplyMarkup = { inline_keyboard: Button[][] };

// Telegram's hard limit for one message.
export const MAX_MESSAGE_LENGTH = 4096;

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

export function sendMessage(chatId: number, text: string, replyMarkup?: ReplyMarkup) {
  return callApi<TgMessage>("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, MAX_MESSAGE_LENGTH),
    reply_markup: replyMarkup,
    link_preview_options: { is_disabled: true },
  });
}

export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
) {
  try {
    await callApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, MAX_MESSAGE_LENGTH),
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    // Tapping the button that's already selected changes nothing; Telegram reports that as an error.
    if (!String(error).includes("message is not modified")) throw error;
  }
}

export function answerCallback(callbackId: string, text?: string) {
  return callApi("answerCallbackQuery", { callback_query_id: callbackId, text });
}

export function sendTyping(chatId: number) {
  return callApi<boolean>("sendChatAction", { chat_id: chatId, action: "typing" });
}

// Telegram's "typing…" disappears after ~5 seconds, so keep refreshing it while work runs.
export async function withTyping<T>(chatId: number, work: () => Promise<T>): Promise<T> {
  sendTyping(chatId).catch(() => {});
  const timer = setInterval(() => sendTyping(chatId).catch(() => {}), 4500);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// Bots can only download files up to 20 MB.
export async function downloadFile(fileId: string): Promise<ArrayBuffer> {
  const file = await callApi<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  return res.arrayBuffer();
}
