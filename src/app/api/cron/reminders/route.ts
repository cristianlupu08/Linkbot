import { sendSavedPost } from "@/lib/bot";
import { postsDueForReminder, updatePost } from "@/lib/db";

export const maxDuration = 60;

// Vercel calls this every morning (see vercel.json) and sends back the posts people asked to be reminded about.
export async function GET(request: Request) {
  // Vercel sends "Authorization: Bearer <CRON_SECRET>"; anyone else is turned away.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Forbidden", { status: 403 });
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Bucharest" });
  const posts = await postsDueForReminder(today);
  let sent = 0;
  for (const post of posts) {
    try {
      await sendSavedPost(
        post.telegram_id,
        post,
        "Reminder: your post is ready to publish. Mornings tend to perform well on LinkedIn.",
      );
      await updatePost(post.id, { meta: { ...post.meta, remindedAt: new Date().toISOString() } });
      sent += 1;
    } catch (error) {
      console.error("reminder failed", post.id, error);
    }
  }
  return Response.json({ due: posts.length, sent });
}
