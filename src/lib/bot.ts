import { AiRefusal, chatReply, generateSlides, generateVariants, revisePost, reviewPost } from "./ai";
import { buildCarousel, renderQuoteCard, type CarouselStyle, type Profile } from "./carousel";
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
  type UserProfile,
} from "./db";
import { generateImage } from "./image";
import {
  applyOptionTap,
  isCarousel,
  normalizeOptions,
  screenKeyboard,
  screenText,
  SCREEN_COUNT,
  summaryKeyboard,
  summaryText,
  type PostOptions,
} from "./options";
import {
  answerCallback,
  downloadFile,
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
    "Just hit the mic and tell me like you'd tell a friend. I'll turn it into a LinkedIn post, with a carousel, a quote card or an image, and you decide if it ever goes out.",
    "",
    "Tip: send /settings once to add your photo and job title. They'll show up on your carousels.",
  ].join("\n");
}

const HELP = [
  "How it works:",
  "",
  "1. Send me a voice note with a story from work (or type /new and write it).",
  "2. Check I heard it right.",
  "3. Pick the tone and the visual: carousel, quote card or image. Next time I remember your choices.",
  "4. Flip through 3 versions, pick one, then pick the first line.",
  "5. You get the post, its score, a first comment and the visual. Want changes? Just tell me.",
  "",
  "/settings: your photo, name and job title for the visuals.",
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

// Edits the panel with a new line every few seconds while slow work runs, so nobody waits in silence.
function startProgress(chatId: number, messageId: number, steps: string[], everyMs = 9000) {
  let step = 0;
  let pending: Promise<unknown> = editMessage(chatId, messageId, steps[0]).catch(() => {});
  const timer = setInterval(() => {
    if (step >= steps.length - 1) return;
    step += 1;
    pending = pending.then(() => editMessage(chatId, messageId, steps[step]).catch(() => {}));
  }, everyMs);
  return async () => {
    clearInterval(timer);
    await pending;
  };
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
  if (/^\/settings\b/.test(text)) {
    await resetSession(ctx);
    await showSettings(ctx);
    return;
  }

  const audio = message.voice ?? message.audio;
  if (audio) {
    await startFromVoice(ctx, audio);
    return;
  }

  if (message.photo?.length) {
    await receivePhoto(ctx, message.photo[message.photo.length - 1].file_id);
    return;
  }

  if (!text) {
    await sendMessage(chatId, "I can't open that one. Send me a voice note or type to me.");
    return;
  }

  switch (ctx.session.step) {
    case "awaiting_correction":
      await applyCorrection(ctx, text);
      return;
    case "awaiting_name":
    case "awaiting_headline":
      await saveProfileText(ctx, text);
      return;
    case "adjusting":
      await adjust(ctx, text);
      return;
    case "awaiting_story":
      await startFromText(ctx, text);
      return;
  }

  if (message.forward_origin) {
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

// ---------- Settings: name, headline and photo for the visuals ----------

async function getProfile(userId: number): Promise<UserProfile> {
  return (await getUser(userId))?.profile ?? {};
}

async function updateProfile(ctx: Ctx, changes: UserProfile) {
  const user = await getUser(ctx.user.id);
  await upsertUser(ctx.user.id, {
    first_name: ctx.user.first_name,
    profile: { ...user?.profile, ...changes },
  });
}

async function showSettings(ctx: Ctx, messageId?: number) {
  const profile = await getProfile(ctx.user.id);
  const text = [
    "Your profile. It goes on your carousels and quote cards.",
    "",
    `Name: ${profile.name ?? fullName(ctx.user)}`,
    `Job title: ${profile.headline ?? "not set (e.g. Software Engineer at Acme)"}`,
    `Photo: ${profile.photoFileId ? "✓ set" : "not set"}`,
  ].join("\n");
  const keyboard: ReplyMarkup = {
    inline_keyboard: [
      [
        { text: "📷 Photo", callback_data: "set:photo" },
        { text: "✏️ Name", callback_data: "set:name" },
        { text: "✏️ Job title", callback_data: "set:headline" },
      ],
      [{ text: "Done ✓", callback_data: "set:done" }],
    ],
  };
  if (messageId) await editMessage(ctx.chatId, messageId, text, keyboard);
  else await sendMessage(ctx.chatId, text, keyboard);
}

async function receivePhoto(ctx: Ctx, fileId: string) {
  if (ctx.session.step === "awaiting_photo") {
    await updateProfile(ctx, { photoFileId: fileId });
    await resetSession(ctx);
    await sendMessage(ctx.chatId, "Looking good 📸 Your photo will be on your carousels and quote cards.");
    await showSettings(ctx);
    return;
  }
  ctx.session.data.pendingPhotoId = fileId;
  await saveSession(ctx.user.id, ctx.session);
  await sendMessage(ctx.chatId, "Nice photo. Want me to put it on your carousels and quote cards?", {
    inline_keyboard: [
      [
        { text: "Yes, use it ✓", callback_data: "ph:yes" },
        { text: "No", callback_data: "ph:no" },
      ],
    ],
  });
}

async function saveProfileText(ctx: Ctx, text: string) {
  const isName = ctx.session.step === "awaiting_name";
  await updateProfile(ctx, isName ? { name: text.slice(0, 40) } : { headline: text.slice(0, 60) });
  await resetSession(ctx);
  await showSettings(ctx);
}

// The profile as the renderer needs it: the photo downloaded and inlined.
async function visualProfile(ctx: Ctx): Promise<Profile> {
  const profile = await getProfile(ctx.user.id);
  let photo: string | undefined;
  if (profile.photoFileId) {
    try {
      const bytes = await downloadFile(profile.photoFileId);
      photo = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
    } catch (error) {
      console.error("profile photo download failed", error);
    }
  }
  return { name: profile.name ?? fullName(ctx.user), headline: profile.headline, photo };
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
  await showOptionsStart(ctx, post);
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
  return normalizeOptions(post.options);
}

// Returning users skip the screens: straight to the summary with last time's choices.
async function showOptionsStart(ctx: Ctx, post: Post) {
  const prefs = await savedPrefs(ctx.user.id);
  if (Object.keys(prefs).length === 0) {
    await showScreen(ctx, post, 0);
    return;
  }
  const options = normalizeOptions(prefs);
  await updatePost(post.id, { options });
  await showSummary(ctx, { ...post, options }, true);
}

async function showScreen(ctx: Ctx, post: Post, screen: number) {
  // Pre-select whatever the user chose last time.
  const options = normalizeOptions({ ...(await savedPrefs(ctx.user.id)), ...post.options });
  await updatePost(post.id, { options });
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    screenText(screen, options),
    screenKeyboard(screen, options),
  );
}

async function showSummary(ctx: Ctx, post: Post, fromLastTime = false) {
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    summaryText(postOptions(post), fromLastTime),
    summaryKeyboard,
  );
}

// ---------- Generate and browse versions ----------

async function generate(ctx: Ctx, post: Post) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  const stopProgress = startProgress(ctx.chatId, panelId, [
    "Writing 3 versions for you… ✍️",
    "Still writing, choosing the best words… ✍️",
    "Almost there… ✍️",
  ]);

  try {
    const { variants, hooks, quote, imagePrompt, costUsd } = await withTyping(ctx.chatId, () =>
      generateVariants(post.transcript!, options, ctx.user.first_name),
    );
    await stopProgress();
    const meta = { ...post.meta, hooks, quote, imagePrompt };
    await updatePost(post.id, { variants, meta });
    await addPostCost(post.id, costUsd);
    await upsertUser(ctx.user.id, { first_name: ctx.user.first_name, prefs: options });

    ctx.session.data.variantIndex = 0;
    ctx.session.data.retry = undefined;
    await saveSession(ctx.user.id, ctx.session);
    await showVariant(ctx, { ...post, variants, meta });
  } catch (error) {
    await stopProgress();
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

// ---------- Final: post, score, first comment, visual ----------

// Cut the preview at a word boundary, like LinkedIn does.
function seeMorePreview(text: string) {
  if (text.length <= SEE_MORE_AT) return null;
  const cut = text.slice(0, SEE_MORE_AT);
  return `${cut.slice(0, cut.lastIndexOf(" "))}… see more`;
}

function statsText(text: string, score: number, tips: string[]) {
  const lines = [`${text.length.toLocaleString("en-US")} characters · Score ${score}/10`];
  if (tips.length) lines.push("", "To make it even better:", ...tips.map((tip) => `• ${tip}`));
  const preview = seeMorePreview(text);
  if (preview) lines.push("", "What people see before they tap:", `"${preview}"`);
  if (/https?:\/\/|www\./i.test(text)) {
    lines.push("", "⚠️ Move the link to the first comment. Posts with links get shown to fewer people.");
  }
  lines.push("", "💬 Your first comment is next. Post it right after publishing: early comments help the post travel.");
  return lines.join("\n");
}

const ADJUST_TEXT =
  "Want to change anything? Tap below, or just tell me in your own words (e.g. “mention it was my first month”).";

const adjustKeyboard: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "✂️ Shorter", callback_data: "a:short" },
      { text: "🔁 New ending", callback_data: "a:end" },
    ],
    [
      { text: "🪝 Other hook", callback_data: "a:hook" },
      { text: "😶 Fewer emoji", callback_data: "a:emoji" },
    ],
    [{ text: "All good, done ✓", callback_data: "a:done" }],
  ],
};

type Visual =
  | { kind: "carousel"; pdf: Uint8Array; cover: Buffer; slides: { title: string; body?: string }[]; costUsd: number }
  | { kind: "quote"; png: Buffer; costUsd: number }
  | { kind: "image"; png: Buffer; costUsd: number };

function progressSteps(options: PostOptions, isAdjustment: boolean) {
  if (isCarousel(options)) {
    return ["Checking your post and writing the slides… ✍️", "Designing your slides… 🎨", "Building the PDF… 📄"];
  }
  if (options.visual === "Image" && !isAdjustment) {
    return ["Painting your image… 🎨 (about 30 seconds)", "Still painting… 🎨", "Adding the last details… 🎨"];
  }
  return ["Checking your post… ✍️", "Almost there… ✍️"];
}

async function finish(ctx: Ctx, post: Post, text: string, isAdjustment = false) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  ctx.session.data.chosenText = text;
  await saveSession(ctx.user.id, ctx.session);

  const stopProgress = startProgress(ctx.chatId, panelId, progressSteps(options, isAdjustment), 8000);
  try {
    const hooks = post.meta.hooks ?? [];
    const hook = hooks.includes(firstLine(text)) ? firstLine(text) : (hooks[0] ?? firstLine(text));
    const [review, visual] = await withTyping(ctx.chatId, () =>
      Promise.all([reviewPost(text, post.transcript!), makeVisual(ctx, post, options, text, hook, isAdjustment)]),
    );
    await stopProgress();

    const meta = {
      ...post.meta,
      score: review.score,
      tips: review.tips,
      firstComment: review.firstComment,
      ...(visual?.kind === "carousel" ? { slides: visual.slides } : {}),
    };
    await updatePost(post.id, { final_text: text, status: "done", meta });
    await addPostCost(post.id, review.costUsd + (visual?.costUsd ?? 0));

    await editMessage(
      ctx.chatId,
      panelId,
      isAdjustment ? "✓ Updated. Here's the new version 👇" : "✓ Done. Here's everything 👇",
    );
    // The post and the comment go alone in their own messages so they're easy to copy.
    await sendMessage(ctx.chatId, text);
    await sendMessage(ctx.chatId, statsText(text, review.score, review.tips));
    await sendMessage(ctx.chatId, review.firstComment);

    if (visual?.kind === "carousel") {
      await sendPhoto(ctx.chatId, visual.cover, "Carousel cover 👆 The full carousel is the PDF below.");
      await sendDocument(
        ctx.chatId,
        visual.pdf,
        "carousel.pdf",
        `On LinkedIn: start a post → + → Add a document → upload this PDF. Title idea: "${hook}"`,
      );
    } else if (visual?.kind === "quote") {
      await sendPhoto(ctx.chatId, visual.png, "Your quote card. Add it to the post on LinkedIn as an image.");
    } else if (visual?.kind === "image") {
      await sendPhoto(
        ctx.chatId,
        visual.png,
        "Your image. Add it to the post on LinkedIn.",
        anotherImageKeyboard(post.id),
      );
    } else if (isAdjustment && options.visual === "Image") {
      await sendMessage(ctx.chatId, "Your image above stays the same.");
    }

    // The adjustment buttons become the new panel; free text now means "change this".
    const panel = await sendMessage(ctx.chatId, ADJUST_TEXT, adjustKeyboard);
    ctx.session = {
      step: "adjusting",
      data: { postId: post.id, panelMessageId: panel.message_id, chosenText: text, hookTries: ctx.session.data.hookTries },
    };
    await saveSession(ctx.user.id, ctx.session);
  } catch (error) {
    await stopProgress();
    console.error("finish failed", error);
    await offerRetry(ctx, "finish");
  }
}

async function makeVisual(
  ctx: Ctx,
  post: Post,
  options: PostOptions,
  text: string,
  hook: string,
  isAdjustment: boolean,
): Promise<Visual | null> {
  if (isCarousel(options)) {
    const [{ slides, costUsd }, profile] = await Promise.all([
      generateSlides(text, hook, post.transcript!, options, ctx.user.first_name),
      visualProfile(ctx),
    ]);
    const { pdf, cover } = await buildCarousel(slides, options.style as CarouselStyle, profile, hook);
    return { kind: "carousel", pdf, cover, slides, costUsd };
  }
  if (options.visual === "Quote card") {
    const quote = post.meta.quote ?? hook;
    const png = await renderQuoteCard(quote, options.style as CarouselStyle, await visualProfile(ctx));
    return { kind: "quote", png, costUsd: 0 };
  }
  // The image doesn't depend on the exact wording, so text tweaks keep it.
  if (options.visual === "Image" && post.meta.imagePrompt && !isAdjustment) {
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

// ---------- Adjustments ----------

const ADJUST_INSTRUCTIONS: Record<string, string> = {
  short: "Make it noticeably shorter, about 30% shorter. Keep the first line, the ending and the hashtags.",
  end: "Rewrite only the closing lines before the hashtags with a different, stronger ending. Keep the same kind of ending (question, follow invitation, or plain lesson).",
  emoji: "Remove most emoji. Keep at most one, only if it truly fits.",
};

async function adjust(ctx: Ctx, instruction: string) {
  const postId = ctx.session.data.postId;
  const current = ctx.session.data.chosenText;
  const post = postId ? await getPost(postId) : null;
  if (!post || !current) {
    await resetSession(ctx);
    await chat(ctx, instruction);
    return;
  }
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "On it… ✍️");
  try {
    const { text, costUsd } = await withTyping(ctx.chatId, () =>
      revisePost(current, instruction, post.transcript!),
    );
    await addPostCost(post.id, costUsd);
    await finish(ctx, post, text, true);
  } catch (error) {
    console.error("adjust failed", error);
    await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, `${ERROR_TEXT}\n\n${ADJUST_TEXT}`, adjustKeyboard);
  }
}

async function otherHook(ctx: Ctx, post: Post) {
  const current = ctx.session.data.chosenText!;
  const hooks = (post.meta.hooks ?? []).filter((hook) => hook !== firstLine(current));
  if (hooks.length === 0) {
    await adjust(ctx, "Write a different, stronger first line (hook). Change nothing else.");
    return;
  }
  const tries = ctx.session.data.hookTries ?? 0;
  ctx.session.data.hookTries = tries + 1;
  await finish(ctx, post, applyHook(current, hooks[tries % hooks.length]), true);
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

  // Settings buttons.
  if (data.startsWith("set:")) {
    await answerCallback(query.id);
    const what = data.slice(4);
    if (what === "done") {
      await editMessage(ctx.chatId, message.message_id, "Saved ✓ Send me a voice note whenever you have a story.");
      return;
    }
    const prompts: Record<string, [Session["step"], string]> = {
      photo: ["awaiting_photo", "Send me a photo of you. A clear, friendly headshot works best 📸"],
      name: ["awaiting_name", "What name should go on your visuals?"],
      headline: ["awaiting_headline", "What's your job title? (e.g. Software Engineer at Acme)"],
    };
    const prompt = prompts[what];
    if (!prompt) return;
    ctx.session = { step: prompt[0], data: {} };
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, message.message_id, prompt[1]);
    return;
  }

  // "Use this photo?" after a photo sent outside /settings.
  if (data === "ph:yes" || data === "ph:no") {
    await answerCallback(query.id);
    const fileId = ctx.session.data.pendingPhotoId;
    ctx.session.data.pendingPhotoId = undefined;
    await saveSession(ctx.user.id, ctx.session);
    if (data === "ph:yes" && fileId) {
      await updateProfile(ctx, { photoFileId: fileId });
      await editMessage(ctx.chatId, message.message_id, "Done 📸 Your photo will be on your carousels and quote cards.");
    } else {
      await editMessage(ctx.chatId, message.message_id, "Okay, I won't use it.");
    }
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
    await showOptionsStart(ctx, post);
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
  } else if (data.startsWith("a:") && ctx.session.step === "adjusting") {
    const action = data.slice(2);
    if (action === "done") {
      await editMessage(ctx.chatId, message.message_id, "Saved ✓ Good luck with the post! Send me a voice note whenever you have another story.");
      await resetSession(ctx);
    } else if (action === "hook") {
      await otherHook(ctx, post);
    } else if (ADJUST_INSTRUCTIONS[action]) {
      await adjust(ctx, ADJUST_INSTRUCTIONS[action]);
    }
  } else if (data === "retry") {
    const retry = ctx.session.data.retry;
    if (retry === "transcribe") {
      await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Trying again… 🎧");
      await transcribe(ctx, post);
    } else if (retry === "generate") {
      await generate(ctx, post);
    } else if (retry === "finish" && ctx.session.data.chosenText) {
      await finish(ctx, post, ctx.session.data.chosenText, ctx.session.step === "adjusting");
    }
  }
}
