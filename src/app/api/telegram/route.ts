import { after } from "next/server";
import { handleUpdate } from "@/lib/bot";
import { config } from "@/lib/config";
import { sendMessage, type TgUpdate } from "@/lib/telegram";

// Telegram calls this URL for every new message (webhook).
export async function POST(request: Request) {
  // Only Telegram knows the secret we set with setWebhook. Ignore everyone else.
  if (request.headers.get("x-telegram-bot-api-secret-token") !== config.webhookSecret) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = await request.json();
  } catch {
    return new Response("OK");
  }

  // Answer Telegram right away; the real work runs after the response is sent,
  // otherwise Telegram retries and the message gets processed twice.
  after(async () => {
    try {
      await handleUpdate(update);
    } catch (error) {
      console.error("handleUpdate failed", update.update_id, error);
      const chatId = update.message?.chat.id;
      if (chatId) {
        await sendMessage(chatId, "Something went wrong. Please try again.").catch(() => {});
      }
    }
  });

  return new Response("OK");
}
