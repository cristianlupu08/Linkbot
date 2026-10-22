import { AiRefusal, chatReply, generateSlides, generateVariants, reviewPost } from "./ai";
import { buildCarousel, type CarouselStyle } from "./carousel";
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
import { generateImage } from "./image";
import {
  applyOptionTap,
  DEFAULT_OPTIONS,
  isCarousel,
  screenKeyboard,
  screenText,
  SCREEN_COUNT,
  summaryKeyboard,
  summaryText,
  type PostOptions,
} from "./options";
import {
  answerCallback,
  editMessage,
  sendDocument,
  sendMessage,
  sendPhoto,
  sendTyping,
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
// LinkedIn shows roughly this many characters before "…see more".
const SEE_MORE_AT = 200;

// Context for one user in one chat, passed to every handler.
type Ctx = { chatId: number; user: TgUser; session: Session };

// ---------- Texts ----------

function welcome(firstName: string) {
  return [
    `Hey ${firstName} 👋`,
    "",
    "Got something from work lately you keep thinking about? A win, a mess-up, a weird day?",
    "",
    "Just hit the mic and tell me like you'd tell a friend. I'll turn it into a LinkedIn post, with a carousel or an image, and you decide if it ever goes out.",
  ].join("\n");
}

const HELP = [
  "How it works:",
  "",
  "1. Send me a voice note with a story from work (or type /new and write it).",
  "2. Check I heard it right.",
  "3. Pick the tone, the visual (carousel or image) and a few details.",
  "4. Flip through 3 versions, pick one, then pick the first line.",
  "5. You get the post, its score, and the carousel PDF or the image. Copy it all to LinkedIn.",
  "",
  "Tips for a good voice note: one story, a real moment (where you were, what happened), what was hard about it, and what you'd tell someone now. 1 to 3 minutes is perfect.",
  "",
  "I never post anything for you.",
].join("\n");

const ERROR_TEXT = "Something didn't work on my side. Try again?";
const retryKeyboard: ReplyMarkup = {
  inline_keyboard: [[{ text: "Try again 🔄", callback_data: "retry" }]],
};

function fullName(user: TgUser) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

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
  await showScreen(ctx, post, 0);
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

// ---------- Options: 3 screens + summary ----------

async function savedPrefs(userId: number): Promise<Partial<PostOptions>> {
  return (await getUser(userId))?.prefs ?? {};
}

function postOptions(post: Post): PostOptions {
  return { ...DEFAULT_OPTIONS, ...post.options };
}

async function showScreen(ctx: Ctx, post: Post, screen: number) {
  const prefs = await savedPrefs(ctx.user.id);
  // Pre-select whatever the user chose last time.
  const options = { ...DEFAULT_OPTIONS, ...prefs, ...post.options };
  await updatePost(post.id, { options });
  const canRepeatLast = Object.keys(prefs).length > 0;
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    screenText(screen, options),
    screenKeyboard(screen, options, canRepeatLast),
  );
}

async function showSummary(ctx: Ctx, post: Post) {
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, summaryText(postOptions(post)), summaryKeyboard);
}

// ---------- Generate and browse versions ----------

async function generate(ctx: Ctx, post: Post) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  await editMessage(ctx.chatId, panelId, "Writing 3 versions for you… ✍️");

  try {
    const { variants, hooks, imagePrompt, costUsd } = await withTyping(ctx.chatId, () =>
      generateVariants(post.transcript!, options, ctx.user.first_name),
    );
    const meta = { ...post.meta, hooks, imagePrompt };
    await updatePost(post.id, { variants, meta });
    await addPostCost(post.id, costUsd);
    await upsertUser(ctx.user.id, { first_name: ctx.user.first_name, prefs: options });

    ctx.session.data.variantIndex = 0;
    ctx.session.data.retry = undefined;
    await saveSession(ctx.user.id, ctx.session);
    await showVariant(ctx, { ...post, variants, meta });
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

// ---------- Hooks ----------

function firstLine(text: string) {
  return text.split("\n")[0].trim();
}

// The chosen hook replaces the post's first line.
function applyHook(text: string, hook: string) {
  const newline = text.indexOf("\n");
  return newline === -1 ? `${hook}\n\n${text}` : `${hook}${text.slice(newline)}`;
}

async function showHooks(ctx: Ctx, post: Post) {
  const variant = post.variants![ctx.session.data.variantIndex ?? 0];
  const hooks = post.meta.hooks ?? [];
  if (hooks.length === 0) {
    await finish(ctx, post, variant.text);
    return;
  }
  const text = [
    "Last choice: the first line. It's what people see before they tap “…see more”.",
    "",
    `Yours now: "${firstLine(variant.text)}"`,
    "",
    ...hooks.map((hook, i) => `${i + 1}. ${hook}`),
  ].join("\n");
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, text, {
    inline_keyboard: [
      hooks.map((_, i) => ({ text: String(i + 1), callback_data: `h:${i}` })),
      [{ text: "Keep mine ✓", callback_data: "h:k" }],
    ],
  });
}

// ---------- Final: post, score, carousel or image ----------

// Cut the preview at a word boundary, like LinkedIn does.
function seeMorePreview(text: string) {
  if (text.length <= SEE_MORE_AT) return null;
  const cut = text.slice(0, SEE_MORE_AT);
  return `${cut.slice(0, cut.lastIndexOf(" "))}… see more`;
}

function statsText(text: string, score: number, tips: string[], hasVisual: boolean) {
  const lines = [`${text.length.toLocaleString("en-US")} characters · Score ${score}/10`];
  if (tips.length) lines.push("", "To make it even better:", ...tips.map((tip) => `• ${tip}`));
  const preview = seeMorePreview(text);
  if (preview) lines.push("", "What people see before they tap:", `"${preview}"`);
  if (/https?:\/\/|www\./i.test(text)) {
    lines.push("", "⚠️ Move the link to the first comment. Posts with links get shown to fewer people.");
  }
  if (!hasVisual) lines.push("", "Got another story? Just send a voice note.");
  return lines.join("\n");
}

async function finish(ctx: Ctx, post: Post, text: string) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  ctx.session.data.chosenText = text;
  await saveSession(ctx.user.id, ctx.session);

  const doing = isCarousel(options)
    ? "Putting it together and designing your carousel… 🎨"
    : options.visual === "Image"
      ? "Putting it together and painting your image… 🎨 (about half a minute)"
      : "Putting it together… ✍️";
  await editMessage(ctx.chatId, panelId, doing);

  try {
    const hook = post.meta.hooks?.includes(firstLine(text)) ? firstLine(text) : (post.meta.hooks?.[0] ?? firstLine(text));
    const [review, visual] = await withTyping(ctx.chatId, () =>
      Promise.all([reviewPost(text), makeVisual(ctx, post, options, text, hook)]),
    );

    await updatePost(post.id, {
      final_text: text,
      status: "done",
      meta: { ...post.meta, score: review.score, tips: review.tips, slides: visual?.slides },
    });
    await addPostCost(post.id, review.costUsd + (visual?.costUsd ?? 0));

    await editMessage(ctx.chatId, panelId, "✓ Done. Here's everything 👇");
    // The post goes alone in its own message so it's easy to copy.
    await sendMessage(ctx.chatId, text);
    await sendMessage(ctx.chatId, statsText(text, review.score, review.tips, Boolean(visual)));

    if (visual?.kind === "carousel") {
      await sendPhoto(ctx.chatId, visual.cover, "Carousel cover 👆 The full carousel is the PDF below.");
      await sendDocument(
        ctx.chatId,
        visual.pdf,
        "carousel.pdf",
        "On LinkedIn: start a post → + → Add a document → upload this PDF and give it a title.\n\nGot another story? Just send a voice note.",
      );
    } else if (visual?.kind === "image") {
      await sendPhoto(
        ctx.chatId,
        visual.png,
        "Your image. Add it to the post on LinkedIn.\n\nGot another story? Just send a voice note.",
        anotherImageKeyboard(post.id),
      );
    }
    await resetSession(ctx);
  } catch (error) {
    console.error("finish failed", error);
    await offerRetry(ctx, "finish");
  }
}

type Visual =
  | { kind: "carousel"; pdf: Uint8Array; cover: Buffer; slides: { title: string; body?: string }[]; costUsd: number }
  | { kind: "image"; png: Buffer; slides?: undefined; costUsd: number };

async function makeVisual(
  ctx: Ctx,
  post: Post,
  options: PostOptions,
  text: string,
  hook: string,
): Promise<Visual | null> {
  if (isCarousel(options)) {
    const { slides, costUsd } = await generateSlides(text, hook, post.transcript!, options, ctx.user.first_name);
    const { pdf, cover } = await buildCarousel(slides, options.style as CarouselStyle, fullName(ctx.user), hook);
    return { kind: "carousel", pdf, cover, slides, costUsd };
  }
  if (options.visual === "Image" && post.meta.imagePrompt) {
    const { png, costUsd } = await generateImage(post.meta.imagePrompt);
    return { kind: "image", png, costUsd };
  }
  return null;
}

function anotherImageKeyboard(postId: string): ReplyMarkup {
  return { inline_keyboard: [[{ text: "Another image 🔄", callback_data: `img:${postId}` }]] };
}

async function anotherImage(ctx: Ctx, postId: string) {
  const post = await getPost(postId);
  if (!post || post.telegram_id !== ctx.user.id || !post.meta.imagePrompt) return;
  await sendTyping(ctx.chatId);
  try {
    const { png, costUsd } = await withTyping(ctx.chatId, () => generateImage(post.meta.imagePrompt!));
    await addPostCost(post.id, costUsd);
    await sendPhoto(ctx.chatId, png, "Here's another one.", anotherImageKeyboard(post.id));
  } catch (error) {
    console.error("another image failed", error);
    await sendMessage(ctx.chatId, "Couldn't paint that one. Tap the button again in a moment?");
  }
}

// ---------- Errors ----------

async function offerRetry(ctx: Ctx, action: "transcribe" | "generate" | "finish") {
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

  // "Another image" lives under a finished post, not on the panel.
  if (data.startsWith("img:")) {
    await answerCallback(query.id, "Painting a new one… 🎨");
    await anotherImage(ctx, data.slice(4));
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
    await showScreen(ctx, post, 0);
  } else if (data === "fix") {
    ctx.session.step = "awaiting_correction";
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "No problem. Send me the right version as text 👇");
    // Plain copy so it's easy to copy, edit and send back.
    await sendMessage(ctx.chatId, post.transcript ?? "");
  } else if (data.startsWith("o:")) {
    const tap = applyOptionTap(postOptions(post), data);
    if (!tap) return;
    await updatePost(post.id, { options: tap.options });
    await showScreen(ctx, { ...post, options: tap.options }, tap.screen);
  } else if (data.startsWith("sc:")) {
    const screen = Number(data.slice(3));
    if (screen >= 0 && screen < SCREEN_COUNT) await showScreen(ctx, post, screen);
  } else if (data === "sum") {
    await showSummary(ctx, post);
  } else if (data === "fast") {
    const options = { ...DEFAULT_OPTIONS, ...(await savedPrefs(ctx.user.id)) };
    await updatePost(post.id, { options });
    await generate(ctx, { ...post, options });
  } else if (data === "gen") {
    await generate(ctx, post);
  } else if (data.startsWith("v:") && post.variants) {
    ctx.session.data.variantIndex = Number(data.slice(2)) % post.variants.length;
    await saveSession(ctx.user.id, ctx.session);
    await showVariant(ctx, post);
  } else if (data === "pick" && post.variants) {
    await showHooks(ctx, post);
  } else if (data.startsWith("h:") && post.variants) {
    const variant = post.variants[ctx.session.data.variantIndex ?? 0];
    const hook = data === "h:k" ? null : post.meta.hooks?.[Number(data.slice(2))];
    await finish(ctx, post, hook ? applyHook(variant.text, hook) : variant.text);
  } else if (data === "retry") {
    const retry = ctx.session.data.retry;
    if (retry === "transcribe") {
      await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Trying again… 🎧");
      await transcribe(ctx, post);
    } else if (retry === "generate") {
      await generate(ctx, post);
    } else if (retry === "finish" && ctx.session.data.chosenText) {
      await finish(ctx, post, ctx.session.data.chosenText);
    }
  }
}
