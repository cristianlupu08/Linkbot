import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import type { PostOptions } from "./options";

// Server-only client with the secret key. Tables are in supabase/schema.sql.
let client: SupabaseClient | undefined;
function db() {
  client ??= createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false },
  });
  return client;
}

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Supabase: ${result.error.message}`);
  return result.data;
}

// ---------- Updates ----------

// Returns false if we've already seen this update (Telegram resent it).
export async function markUpdateProcessed(updateId: number): Promise<boolean> {
  const { error } = await db().from("processed_updates").insert({ update_id: updateId });
  if (!error) return true;
  if (error.code === "23505") return false; // duplicate key
  throw new Error(`Supabase: ${error.message}`);
}

// ---------- Users ----------

export type User = {
  telegram_id: number;
  first_name: string | null;
  approved: boolean;
  prefs: Partial<PostOptions>;
};

export async function getUser(telegramId: number): Promise<User | null> {
  return check(await db().from("users").select("*").eq("telegram_id", telegramId).maybeSingle());
}

export async function upsertUser(telegramId: number, fields: Partial<Omit<User, "telegram_id">>) {
  check(await db().from("users").upsert({ telegram_id: telegramId, ...fields }));
}

// ---------- Sessions (conversation state) ----------

export type Step = "idle" | "awaiting_story" | "awaiting_correction";

export type SessionData = {
  postId?: string;
  // The message we keep editing (transcript, options, variants), so stale buttons can be ignored.
  panelMessageId?: number;
  variantIndex?: number;
  // Audio files keep their own name (e.g. "story.m4a") so transcription knows the format.
  audioFileName?: string;
  audioDuration?: number;
  // What to redo when the user taps [Try again].
  retry?: "transcribe" | "generate" | "finish";
  // The post text after a hook was picked, waiting for the finishing step.
  chosenText?: string;
  // A long text we asked about: "make it a post or just chatting?"
  pendingText?: string;
};

export type Session = { step: Step; data: SessionData };

export async function getSession(telegramId: number): Promise<Session> {
  const row = check(
    await db().from("sessions").select("step, data").eq("telegram_id", telegramId).maybeSingle(),
  );
  return (row as Session | null) ?? { step: "idle", data: {} };
}

export async function saveSession(telegramId: number, session: Session) {
  check(
    await db().from("sessions").upsert({
      telegram_id: telegramId,
      step: session.step,
      data: session.data,
      updated_at: new Date().toISOString(),
    }),
  );
}

// ---------- Chat memory ----------

export type ChatTurn = { role: "user" | "assistant"; content: string };

export async function getRecentChat(telegramId: number, limit = 20): Promise<ChatTurn[]> {
  const rows = check(
    await db()
      .from("chat_messages")
      .select("role, content")
      .eq("telegram_id", telegramId)
      .order("id", { ascending: false })
      .limit(limit),
  ) as ChatTurn[];
  return rows.reverse();
}

export async function addChatMessages(telegramId: number, turns: ChatTurn[]) {
  check(
    await db()
      .from("chat_messages")
      .insert(turns.map((turn) => ({ telegram_id: telegramId, ...turn }))),
  );
}

// ---------- Posts ----------

export type Variant = { label: string; text: string };

// Everything generated after the variants, kept for the final message and later steps.
export type PostMeta = {
  hooks?: string[];
  imagePrompt?: string;
  slides?: { title: string; body?: string }[];
  score?: number;
  tips?: string[];
};

export type Post = {
  id: string;
  telegram_id: number;
  status: "draft" | "done";
  voice_file_id: string | null;
  transcript: string | null;
  options: Partial<PostOptions>;
  variants: Variant[] | null;
  meta: PostMeta;
  final_text: string | null;
  cost_usd: number;
};

export async function createPost(
  telegramId: number,
  fields: Partial<Pick<Post, "voice_file_id" | "transcript" | "options">>,
): Promise<Post> {
  const post = check(
    await db()
      .from("posts")
      .insert({ telegram_id: telegramId, ...fields })
      .select()
      .single(),
  );
  return post as Post;
}

export async function getPost(id: string): Promise<Post | null> {
  return check(await db().from("posts").select("*").eq("id", id).maybeSingle());
}

export async function updatePost(id: string, fields: Partial<Omit<Post, "id" | "telegram_id">>) {
  check(
    await db()
      .from("posts")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", id),
  );
}

export async function addPostCost(id: string, usd: number) {
  const post = await getPost(id);
  if (post) await updatePost(id, { cost_usd: Number(post.cost_usd) + usd });
}
