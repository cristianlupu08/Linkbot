// Reads secrets from environment variables (.env.local locally, Vercel settings in production).
// Never hardcode them here.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  get botToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get webhookSecret() {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },
  // Comma-separated Telegram user IDs, e.g. "123456789,987654321".
  get allowedUserIds(): Set<number> {
    return new Set(
      (process.env.ALLOWED_TELEGRAM_IDS ?? "")
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
  },
};
