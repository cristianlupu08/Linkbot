import { after } from "next/server";
import { handleUpdate } from "@/lib/bot";
import { config } from "@/lib/config";
import { sendMessage, type TgUpdate } from "@/lib/telegram";

// Transcription and writing can take a while; give the background work up to 5 minutes.
export const maxDuration = 300;

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
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      if (chatId) {
        await sendMessage(chatId, "Something didn't work on my side. Try that again in a moment?").catch(
          () => {},
        );
      }
    }
  });

  return new Response("OK");
}
