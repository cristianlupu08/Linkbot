// Tells Telegram where to send messages: node scripts/set-webhook.mjs https://your-app.vercel.app
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const baseUrl = process.argv[2]?.replace(/\/$/, "");
if (!baseUrl?.startsWith("https://")) {
  console.error("Usage: node scripts/set-webhook.mjs https://your-app.vercel.app");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const result = await api("setWebhook", {
  url: `${baseUrl}/api/telegram`,
  secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
console.log("setWebhook:", result);

await api("setMyCommands", {
  // Add more commands here as they get built (/new, /settings, /history, ...).
  commands: [
    { command: "new", description: "Start a new post" },
    { command: "help", description: "How it works + tips for a good voice note" },
    { command: "start", description: "Welcome" },
  ],
});

console.log("getWebhookInfo:", (await api("getWebhookInfo")).result);
