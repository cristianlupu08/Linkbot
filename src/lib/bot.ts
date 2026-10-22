import { AiRefusal, chatReply, generateVariants } from "./ai";
import { config } from "./config";
import {
  addChatMessages,
  addPostCost,
  createPost,
  getPost,
  getRecentChat,
  getSession,
  getUser,
  markUpdateProcessed,
  saveSession,
  updatePost,
  upsertUser,
  type Post,
  type Session,
} from "./db";
import {
  applyOptionTap,
  DEFAULT_OPTIONS,
  optionsKeyboard,
  optionsText,
  type PostOptions,
} from "./options";
import {
  answerCallback,
  editMessage,
  sendMessage,
  withTyping,
  type ReplyMarkup,
  type TgAudioFile,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "./telegram";
import { transcribeVoice } from "./transcribe";

const MAX_VOICE_SECONDS = 5 * 60;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Typed messages at least this long are probably a story, so we offer to turn them into a post.
const STORY_LENGTH_HINT = 300;

// Context for one user in one chat, passed to every handler.
type Ctx = { chatId: number; user: TgUser; session: Session };

// ---------- Texts ----------

function welcome(firstName: string) {
  return [
    `Hey ${firstName} 👋`,
    "",
    "Got something from work lately you keep thinking about? A win, a mess-up, a weird day?",
    "",
    "Just hit the mic and tell me like you'd tell a friend. I'll turn it into a LinkedIn post, and you decide if it ever goes out.",
  ].join("\n");
}

const HELP = [
  "How it works:",
  "",
  "1. Send me a voice note with a story from work (or type /new and write it).",
  "2. Check I heard it right.",
  "3. Pick the tone, length and who it's for.",
  "4. Flip through 3 versions and pick one. Copy it to LinkedIn.",
  "",
  "Tips for a good voice note: one story, a real moment (where you were, what happened), what was hard about it, and what you'd tell someone now. 1 to 3 minutes is perfect.",
  "",
  "I never post anything for you.",
].join("\n");

const ERROR_TEXT = "Something didn't work on my side. Try again?";
const retryKeyboard: ReplyMarkup = {
  inline_keyboard: [[{ text: "Try again 🔄", callback_data: "retry" }]],
};

// ---------- Entry point ----------

// All bot logic for one incoming update. Runs after the webhook has already answered Telegram.
export async function handleUpdate(update: TgUpdate) {
  if (!(await markUpdateProcessed(update.update_id))) return;

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  } else if (update.message?.from) {
    await handleMessage(update.message, update.message.from);
  }
}

async function isAllowed(user: TgUser) {
  if (config.ownerIds.has(user.id)) return true;
  return (await getUser(user.id))?.approved ?? false;
}

// ---------- Messages ----------

async function handleMessage(message: TgMessage, user: TgUser) {
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? "").trim();

  // Invite link: t.me/<bot>?start=<code> approves whoever opens it.
  const startCode = text.match(/^\/start\s+(\S+)/)?.[1];
  if (startCode && config.inviteCode && startCode === config.inviteCode) {
    await upsertUser(user.id, { first_name: user.first_name, approved: true });
  }

  if (!(await isAllowed(user))) {
    await sendMessage(chatId, "Access restricted.");
    return;
  }

  const ctx: Ctx = { chatId, user, session: await getSession(user.id) };

  if (/^\/start\b/.test(text)) {
    await resetSession(ctx);
    await sendMessage(chatId, welcome(user.first_name));
    return;
  }
  if (/^\/new\b/.test(text)) {
    ctx.session = { step: "awaiting_story", data: {} };
    await saveSession(user.id, ctx.session);
    await sendMessage(chatId, "Let's do it. Tell me the story: a voice note works best, but you can type it too.");
    return;
  }
  if (/^\/help\b/.test(text)) {
    await sendMessage(chatId, HELP);
    return;
  }

  const audio = message.voice ?? message.audio;
  if (audio) {
    await startFromVoice(ctx, audio);
    return;
  }

  if (!text) {
    await sendMessage(chatId, "I can't open that one. Send me a voice note or type to me.");
    return;
  }

  if (ctx.session.step === "awaiting_correction") {
    await applyCorrection(ctx, text);
  } else if (ctx.session.step === "awaiting_story" || message.forward_origin) {
    await startFromText(ctx, text);
  } else if (text.length >= STORY_LENGTH_HINT) {
    ctx.session.data.pendingText = text;
    await saveSession(user.id, ctx.session);
    await sendMessage(chatId, "That sounds like a story. Want me to turn it into a post?", {
      inline_keyboard: [
        [
          { text: "Yes, make it a post", callback_data: "mk" },
          { text: "Just chatting", callback_data: "chat" },
        ],
      ],
    });
  } else {
    await chat(ctx, text);
  }
}

async function resetSession(ctx: Ctx) {
  ctx.session = { step: "idle", data: {} };
  await saveSession(ctx.user.id, ctx.session);
}

async function chat(ctx: Ctx, text: string) {
  const history = [...(await getRecentChat(ctx.user.id)), { role: "user" as const, content: text }];
  const reply = await withTyping(ctx.chatId, () => chatReply(history, ctx.user.first_name));
  await sendMessage(ctx.chatId, reply);
  await addChatMessages(ctx.user.id, [
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ]);
}

// ---------- Story in: voice or text ----------

async function startFromVoice(ctx: Ctx, audio: TgAudioFile) {
  if (audio.duration > MAX_VOICE_SECONDS) {
    await sendMessage(
      ctx.chatId,
      "That one's a bit long for me (5 minutes max). Could you tell it again, a little shorter?",
    );
    return;
  }
  if (audio.file_size && audio.file_size > MAX_FILE_BYTES) {
    await sendMessage(ctx.chatId, "That file is too big for me to open (20 MB max). A shorter one?");
    return;
  }

  const post = await createPost(ctx.user.id, { voice_file_id: audio.file_id });
  const panel = await sendMessage(ctx.chatId, "Got it, listening… 🎧");
  ctx.session = {
    step: "idle",
    data: {
      postId: post.id,
      panelMessageId: panel.message_id,
      audioFileName: audio.file_name,
      audioDuration: audio.duration,
    },
  };
  await saveSession(ctx.user.id, ctx.session);

  await transcribe(ctx, post);
}

async function transcribe(ctx: Ctx, post: Post) {
  const { panelMessageId, audioDuration, audioFileName } = ctx.session.data;
  try {
    const { text, costUsd } = await withTyping(ctx.chatId, () =>
      transcribeVoice(post.voice_file_id!, audioDuration ?? 60, audioFileName),
    );
    if (!text) {
      await editMessage(
        ctx.chatId,
        panelMessageId!,
        "I couldn't hear anything in that one. Want to try another voice note?",
      );
      return;
    }
    await updatePost(post.id, { transcript: text });
    await addPostCost(post.id, costUsd);
    ctx.session.data.retry = undefined;
    await saveSession(ctx.user.id, ctx.session);
    await showTranscript(ctx, text);
  } catch (error) {
    console.error("transcribe failed", error);
    await offerRetry(ctx, "transcribe");
  }
}

async function startFromText(ctx: Ctx, text: string) {
  const post = await createPost(ctx.user.id, { transcript: text });
  const panel = await sendMessage(ctx.chatId, "Got it ✍️");
  ctx.session = { step: "idle", data: { postId: post.id, panelMessageId: panel.message_id } };
  await saveSession(ctx.user.id, ctx.session);
  await showOptions(ctx, post);
}

async function showTranscript(ctx: Ctx, transcript: string) {
  const shown = transcript.length > 3500 ? `${transcript.slice(0, 3500)}…` : transcript;
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    `Here's what I heard:\n\n"${shown}"\n\nDid I get it right?`,
    {
      inline_keyboard: [
        [
          { text: "Looks right ✓", callback_data: "ok" },
          { text: "Let me fix it ✏️", callback_data: "fix" },
        ],
      ],
    },
  );
}

async function applyCorrection(ctx: Ctx, text: string) {
  const postId = ctx.session.data.postId;
  if (!postId) {
    await startFromText(ctx, text);
    return;
  }
  await updatePost(postId, { transcript: text });
  // Show the corrected version in a fresh panel at the bottom of the chat.
  const panel = await sendMessage(ctx.chatId, "Updated ✓");
  ctx.session = { step: "idle", data: { postId, panelMessageId: panel.message_id } };
  await saveSession(ctx.user.id, ctx.session);
  await showTranscript(ctx, text);
}

// ---------- Options ----------

async function userOptions(userId: number): Promise<PostOptions> {
  const user = await getUser(userId);
  return { ...DEFAULT_OPTIONS, ...user?.prefs };
}

async function showOptions(ctx: Ctx, post: Post) {
  // Pre-select whatever the user chose last time.
  const options = { ...(await userOptions(ctx.user.id)), ...post.options };
  await updatePost(post.id, { options });
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, optionsText(), optionsKeyboard(options));
}

// ---------- Generate and browse versions ----------

async function generate(ctx: Ctx, post: Post) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = { ...DEFAULT_OPTIONS, ...post.options };
  await editMessage(ctx.chatId, panelId, "Writing 3 versions for you… ✍️");

  try {
    const { variants, costUsd } = await withTyping(ctx.chatId, () =>
      generateVariants(post.transcript!, options),
    );
    await updatePost(post.id, { variants });
    await addPostCost(post.id, costUsd);
    await upsertUser(ctx.user.id, { first_name: ctx.user.first_name, prefs: options });

    ctx.session.data.variantIndex = 0;
    ctx.session.data.retry = undefined;
    await saveSession(ctx.user.id, ctx.session);
    await showVariant(ctx, { ...post, variants });
  } catch (error) {
    console.error("generate failed", error);
    if (error instanceof AiRefusal) {
      await editMessage(
        ctx.chatId,
        panelId,
        "I couldn't write this one. Could you tell the story a bit differently?",
      );
      return;
    }
    await offerRetry(ctx, "generate");
  }
}

async function showVariant(ctx: Ctx, post: Post) {
  const variants = post.variants ?? [];
  const index = ctx.session.data.variantIndex ?? 0;
  const variant = variants[index];
  const total = variants.length;
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    `Version ${index + 1}/${total} · ${variant.label}\n\n${variant.text}`,
    {
      inline_keyboard: [
        [
          { text: "◀", callback_data: `v:${(index - 1 + total) % total}` },
          { text: `${index + 1}/${total}`, callback_data: "noop" },
          { text: "▶", callback_data: `v:${(index + 1) % total}` },
        ],
        [{ text: "Pick this one ✓", callback_data: "pick" }],
      ],
    },
  );
}

async function pick(ctx: Ctx, post: Post) {
  const index = ctx.session.data.variantIndex ?? 0;
  const variant = post.variants![index];
  await updatePost(post.id, { final_text: variant.text, status: "done" });

  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    `✓ You picked version ${index + 1} (${variant.label}). Here's your post 👇`,
  );
  // The post goes alone in its own message so it's easy to copy.
  await sendMessage(ctx.chatId, variant.text);
  await sendMessage(
    ctx.chatId,
    `${variant.text.length.toLocaleString("en-US")} characters.\n\nCopy it, paste it on LinkedIn, done. Got another story? Just send a voice note.`,
  );
  await resetSession(ctx);
}

// ---------- Errors ----------

async function offerRetry(ctx: Ctx, action: "transcribe" | "generate") {
  ctx.session.data.retry = action;
  await saveSession(ctx.user.id, ctx.session);
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, ERROR_TEXT, retryKeyboard);
}

// ---------- Buttons ----------

async function handleCallback(query: TgCallbackQuery) {
  const message = query.message;
  const data = query.data ?? "";
  if (!message) {
    await answerCallback(query.id);
    return;
  }
  if (!(await isAllowed(query.from))) {
    await answerCallback(query.id, "Access restricted.");
    return;
  }

  const ctx: Ctx = { chatId: message.chat.id, user: query.from, session: await getSession(query.from.id) };

  // Buttons on the "is this a story?" question.
  if (data === "mk" || data === "chat") {
    await answerCallback(query.id);
    const text = ctx.session.data.pendingText;
    await editMessage(ctx.chatId, message.message_id, data === "mk" ? "On it ✍️" : "Got it, just chatting 🙂");
    if (!text) return;
    ctx.session.data.pendingText = undefined;
    await saveSession(ctx.user.id, ctx.session);
    if (data === "mk") await startFromText(ctx, text);
    else await chat(ctx, text);
    return;
  }

  // Every other button belongs to the post panel. Ignore taps on old panels.
  const postId = ctx.session.data.postId;
  const post = postId ? await getPost(postId) : null;
  if (!post || message.message_id !== ctx.session.data.panelMessageId) {
    await answerCallback(query.id, "That one's done. Send a new voice note to start again.");
    return;
  }
  await answerCallback(query.id);

  if (data === "ok") {
    await showOptions(ctx, post);
  } else if (data === "fix") {
    ctx.session.step = "awaiting_correction";
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "No problem. Send me the right version as text 👇");
    // Plain copy so it's easy to copy, edit and send back.
    await sendMessage(ctx.chatId, post.transcript ?? "");
  } else if (data.startsWith("o:")) {
    const options = applyOptionTap({ ...DEFAULT_OPTIONS, ...post.options }, data);
    if (!options) return;
    await updatePost(post.id, { options });
    await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, optionsText(), optionsKeyboard(options));
  } else if (data === "gen") {
    await generate(ctx, post);
  } else if (data.startsWith("v:") && post.variants) {
    ctx.session.data.variantIndex = Number(data.slice(2)) % post.variants.length;
    await saveSession(ctx.user.id, ctx.session);
    await showVariant(ctx, post);
  } else if (data === "pick" && post.variants) {
    await pick(ctx, post);
  } else if (data === "retry") {
    if (ctx.session.data.retry === "transcribe") {
      await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Trying again… 🎧");
      await transcribe(ctx, post);
    } else if (ctx.session.data.retry === "generate") {
      await generate(ctx, post);
    }
  }
}
