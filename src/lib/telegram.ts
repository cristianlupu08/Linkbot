import { config } from "./config";

// Minimal types for the parts of the Telegram Bot API we use.
// Full reference: https://core.telegram.org/bots/api

export type TgUser = {
  id: number;
  first_name: string;
  last_name?: string;
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
  // Same photo in several sizes, smallest first.
  photo?: { file_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string };
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

// Uploads a file (photo or document) with multipart/form-data.
async function callApiWithFile<T>(
  method: string,
  field: "photo" | "document",
  file: Uint8Array,
  fileName: string,
  fields: Record<string, unknown>,
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  form.append(field, new Blob([new Uint8Array(file)]), fileName);
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result as T;
}

// Captions are limited to 1024 characters.
export function sendPhoto(chatId: number, png: Uint8Array, caption?: string, replyMarkup?: ReplyMarkup) {
  return callApiWithFile<TgMessage>("sendPhoto", "photo", png, "image.png", {
    chat_id: String(chatId),
    caption: caption?.slice(0, 1024),
    reply_markup: replyMarkup,
  });
}

// Re-sends a file Telegram already has (e.g. a carousel from /history), by its file_id. No upload needed.
export function resendFile(chatId: number, kind: "photo" | "document", fileId: string, caption?: string) {
  return callApi<TgMessage>(kind === "photo" ? "sendPhoto" : "sendDocument", {
    chat_id: chatId,
    [kind]: fileId,
    caption: caption?.slice(0, 1024),
  });
}

// Several files as one album. Documents keep full quality (photos get compressed).
export async function sendDocumentAlbum(
  chatId: number,
  files: { bytes: Uint8Array; fileName: string }[],
  caption?: string,
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "media",
    JSON.stringify(
      files.map((file, i) => ({
        type: "document",
        media: `attach://file${i}`,
        ...(i === files.length - 1 && caption ? { caption: caption.slice(0, 1024) } : {}),
      })),
    ),
  );
  files.forEach((file, i) => form.append(`file${i}`, new Blob([new Uint8Array(file.bytes)]), file.fileName));
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMediaGroup failed: ${data.description}`);
}

export function sendDocument(chatId: number, file: Uint8Array, fileName: string, caption?: string) {
  return callApiWithFile<TgMessage>("sendDocument", "document", file, fileName, {
    chat_id: String(chatId),
    caption: caption?.slice(0, 1024),
  });
}

// Only stops the button's loading spinner, so a failure (e.g. a tap older than 15 minutes) is harmless.
export async function answerCallback(callbackId: string, text?: string) {
  await callApi("answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => {});
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
