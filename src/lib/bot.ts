import {
  AiRefusal,
  chatReply,
  generateSlides,
  generateVariants,
  ideaQuestions,
  learnStyle,
  planImage,
  revisePost,
  nextInterviewQuestion,
  polishPost,
  suggestTaglines,
} from "./ai";
import { buildCarousel, renderBanner, renderQuoteCard, type CarouselStyle, type Profile } from "./carousel";
import { config } from "./config";
import {
  addChatMessages,
  addPostCost,
  createPost,
  getPost,
  getRecentChat,
  getSession,
  getUser,
  costSummary,
  discardDrafts,
  listDonePosts,
  listDraftPosts,
  markUpdateProcessed,
  saveSession,
  updatePost,
  upsertUser,
  type Post,
  type PostMeta,
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
  VISUAL_SCREEN,
  visualFromCode,
  visualMenuKeyboard,
  summaryKeyboard,
  summaryText,
  type PostOptions,
} from "./options";
import {
  answerCallback,
  downloadFile,
  editMessage,
  resendFile,
  sendDocument,
  sendDocumentAlbum,
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
    `Welcome back, ${firstName}.`,
    "",
    "Send a voice note when you have a story worth sharing. For a starting point, use /ideas.",
  ].join("\n");
}

function onboardingIntro(firstName: string) {
  return [
    `Hi ${firstName}. LinkBot turns your voice notes into ready-to-publish LinkedIn posts, with a matching carousel, quote card or image. Nothing is ever posted on your behalf.`,
    "",
    "Two details for your visuals before we start.",
    "",
    "Your job title? (e.g. Product Designer at Acme)",
  ].join("\n");
}

const ONBOARDING_PHOTO = "A headshot for your carousel covers. Send a photo, or skip for now.";

const ALL_SET = [
  "Setup complete.",
  "",
  "Send a voice note about something that happened to you: at work, in sport, on a trip, at home. A decision, a mistake, a lesson. One to three minutes works best.",
  "",
  "Need a starting point? Use /ideas.",
  "",
  "All commands: tap ☰ Menu, next to the message field.",
].join("\n");

const skipKeyboard: ReplyMarkup = { inline_keyboard: [[{ text: "Skip", callback_data: "ob:skip" }]] };

const FIRST_POST_TIPS = [
  "Also available:",
  "",
  "/ideas: prompts to find your next story",
  "/style: match the writing style of your past posts",
  "/history: your recent posts, ready to resend",
  "/banner: a profile banner in your style",
  "/settings: photo, name and job title",
  "",
  "All commands are under ☰ Menu, next to the message field.",
].join("\n");

const HELP = [
  "How it works",
  "",
  "1. Send a voice note with a story (work, life, anything you learned from), or use /new to type it.",
  "2. Confirm the transcript and answer a few quick questions about the story.",
  "3. Choose tone, length and ending. Your choices are remembered.",
  "4. Pick one of 3 versions and the opening line, then the visual: carousel, your own photo, a generated image, or a quote card.",
  "5. Receive the post, a score, a suggested first comment and the visual. Request edits in plain words.",
  "",
  "Commands",
  "/ideas: prompts to find a story",
  "/style: match the writing style of your past posts",
  "/drafts: resume unfinished posts",
  "/history: resend recent posts",
  "/banner: profile banner in your style",
  "/costs: what your posts have cost",
  "/settings: photo, name and job title",
  "",
  "A good voice note covers one concrete moment: what happened, what was at stake, and what you took from it. One to three minutes works best.",
  "",
  "Nothing is ever posted on your behalf.",
].join("\n");

const ERROR_TEXT = "Something went wrong. Please try again.";
const retryKeyboard: ReplyMarkup = {
  inline_keyboard: [[{ text: "Try again", callback_data: "retry" }]],
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
    const profile = await getProfile(user.id);
    if (profile.onboarded) {
      await resetSession(ctx);
      await sendMessage(chatId, welcome(user.first_name));
      return;
    }
    // First time: a short guided setup so nobody has to discover /settings on their own.
    ctx.session = { step: "awaiting_headline", data: { onboarding: true } };
    await saveSession(user.id, ctx.session);
    await sendMessage(chatId, onboardingIntro(user.first_name), skipKeyboard);
    return;
  }
  if (/^\/new\b/.test(text)) {
    ctx.session = { step: "awaiting_story", data: {} };
    await saveSession(user.id, ctx.session);
    await sendMessage(chatId, "Send the story as a voice note, or type it out.");
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
  if (/^\/ideas\b/.test(text)) {
    await showIdeas(ctx);
    return;
  }
  if (/^\/history\b/.test(text)) {
    await resetSession(ctx);
    await showHistory(ctx);
    return;
  }
  if (/^\/banner\b/.test(text)) {
    await startBanner(ctx);
    return;
  }
  if (/^\/style\b/.test(text)) {
    await showStyle(ctx);
    return;
  }
  if (/^\/drafts\b/.test(text)) {
    await resetSession(ctx);
    await showDrafts(ctx);
    return;
  }
  if (/^\/costs\b/.test(text)) {
    await showCosts(ctx);
    return;
  }

  const audio = message.voice ?? message.audio;
  if (audio && ctx.session.step === "awaiting_followup") {
    await answerFollowUpVoice(ctx, audio);
    return;
  }
  if (audio && ctx.session.step === "awaiting_image_brief") {
    const answer = await transcribeAnswer(ctx, audio);
    if (answer) await addImageBrief(ctx, answer);
    return;
  }
  if (audio) {
    await startFromVoice(ctx, audio);
    return;
  }

  if (message.photo?.length) {
    await receivePhoto(ctx, message.photo[message.photo.length - 1].file_id);
    return;
  }

  if (!text) {
    await sendMessage(chatId, "This file type isn't supported. Send a voice note or text.");
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
    case "awaiting_banner":
      await makeBanner(ctx, text);
      return;
    case "awaiting_style":
      await addStyleSample(ctx, text);
      return;
    case "awaiting_followup":
      await answerFollowUp(ctx, text);
      return;
    case "awaiting_image_brief":
      await addImageBrief(ctx, text);
      return;
    case "awaiting_user_image":
      await sendMessage(ctx.chatId, "Send the photo as an image, or tap Back to choose another visual.");
      return;
    case "adjusting":
      await adjust(ctx, text, true);
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
    await sendMessage(chatId, "This reads like a story. Turn it into a post?", {
      inline_keyboard: [
        [
          { text: "Create post", callback_data: "mk" },
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
    `Photo: ${profile.photoFileId ? "set" : "not set"}`,
  ].join("\n");
  const keyboard: ReplyMarkup = {
    inline_keyboard: [
      [
        { text: "📷 Photo", callback_data: "set:photo" },
        { text: "✏️ Name", callback_data: "set:name" },
        { text: "✏️ Job title", callback_data: "set:headline" },
      ],
      [
        { text: "Profile banner", callback_data: "set:banner" },
        { text: "Done ✓", callback_data: "set:done" },
      ],
    ],
  };
  if (messageId) await editMessage(ctx.chatId, messageId, text, keyboard);
  else await sendMessage(ctx.chatId, text, keyboard);
}

async function receivePhoto(ctx: Ctx, fileId: string) {
  if (ctx.session.step === "awaiting_user_image") {
    await applyOwnImage(ctx, fileId);
    return;
  }
  if (ctx.session.step === "awaiting_photo") {
    const onboarding = ctx.session.data.onboarding;
    await updateProfile(ctx, { photoFileId: fileId });
    await resetSession(ctx);
    await sendMessage(ctx.chatId, "Photo saved. It will appear on your carousels and quote cards.");
    if (onboarding) await finishOnboarding(ctx);
    else await showSettings(ctx);
    return;
  }
  ctx.session.data.pendingPhotoId = fileId;
  await saveSession(ctx.user.id, ctx.session);
  await sendMessage(ctx.chatId, "Use this photo on your carousels and quote cards?", {
    inline_keyboard: [
      [
        { text: "Use photo", callback_data: "ph:yes" },
        { text: "No", callback_data: "ph:no" },
      ],
    ],
  });
}

async function saveProfileText(ctx: Ctx, text: string) {
  const isName = ctx.session.step === "awaiting_name";
  await updateProfile(ctx, isName ? { name: text.slice(0, 40) } : { headline: text.slice(0, 60) });
  if (ctx.session.data.onboarding) {
    await askOnboardingPhoto(ctx);
    return;
  }
  await resetSession(ctx);
  await showSettings(ctx);
}

async function askOnboardingPhoto(ctx: Ctx) {
  ctx.session = { step: "awaiting_photo", data: { onboarding: true } };
  await saveSession(ctx.user.id, ctx.session);
  await sendMessage(ctx.chatId, ONBOARDING_PHOTO, skipKeyboard);
}

async function finishOnboarding(ctx: Ctx) {
  await updateProfile(ctx, { onboarded: true });
  await resetSession(ctx);
  await sendMessage(ctx.chatId, ALL_SET);
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
      "Voice notes are limited to 5 minutes. Please send a shorter version.",
    );
    return;
  }
  if (audio.file_size && audio.file_size > MAX_FILE_BYTES) {
    await sendMessage(ctx.chatId, "Files are limited to 20 MB. Please send a smaller one.");
    return;
  }

  const post = await createPost(ctx.user.id, { voice_file_id: audio.file_id });
  const panel = await sendMessage(ctx.chatId, "Transcribing…");
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
        "No speech detected. Please send another voice note.",
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
  const panel = await sendMessage(ctx.chatId, "Story received.");
  ctx.session = { step: "idle", data: { postId: post.id, panelMessageId: panel.message_id } };
  await saveSession(ctx.user.id, ctx.session);
  await followUpOrContinue(ctx, post);
}

async function showTranscript(ctx: Ctx, transcript: string) {
  const shown = transcript.length > 3500 ? `${transcript.slice(0, 3500)}…` : transcript;
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    `Transcript:\n\n"${shown}"\n\nIs this accurate?`,
    {
      inline_keyboard: [
        [
          { text: "Correct", callback_data: "ok" },
          { text: "Edit", callback_data: "fix" },
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
  const panel = await sendMessage(ctx.chatId, "Transcript updated.");
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
  const profile = await getProfile(ctx.user.id);
  const stopProgress = startProgress(ctx.chatId, panelId, [
    "Writing 3 versions…",
    "Still writing…",
    "Almost done…",
  ]);

  try {
    const { variants, hooks, quote, imagePrompt, costUsd } = await withTyping(ctx.chatId, () =>
      generateVariants(post.transcript!, options, ctx.user.first_name, profile.styleGuide),
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
        "This story couldn't be processed. Try rephrasing it.",
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
        [{ text: "Use this version", callback_data: "pick" }],
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
    await chooseVisual(ctx, post, variant.text);
    return;
  }
  const text = [
    "Choose the opening line. It's what readers see before “…see more”.",
    "",
    `Current: "${firstLine(variant.text)}"`,
    "",
    ...hooks.map((hook, i) => `${i + 1}. ${hook}`),
  ].join("\n");
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, text, {
    inline_keyboard: [
      hooks.map((_, i) => ({ text: String(i + 1), callback_data: `h:${i}` })),
      [{ text: "Keep current", callback_data: "h:k" }],
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

function statsText(text: string, score: number, detailQuestion: string) {
  const lines = [`${text.length.toLocaleString("en-US")} characters · Score ${score}/10`];
  const preview = seeMorePreview(text);
  if (preview) lines.push("", "Preview before “…see more”:", `"${preview}"`);
  if (/https?:\/\/|www\./i.test(text)) {
    lines.push("", "Note: move the link to the first comment. Posts with links get less reach.");
  }
  if (detailQuestion) {
    lines.push("", `To make it stronger: ${detailQuestion} Reply with the answer and I'll work it in.`);
  }
  lines.push("", "Suggested first comment below. Post it right after publishing; early comments help reach.");
  return lines.join("\n");
}

const ADJUST_TEXT =
  "Need changes? Use the buttons, or describe the edit (e.g. “mention it was my first month”).";

const adjustKeyboard: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "Shorter", callback_data: "a:short" },
      { text: "New ending", callback_data: "a:end" },
    ],
    [
      { text: "Different hook", callback_data: "a:hook" },
      { text: "Fewer emoji", callback_data: "a:emoji" },
    ],
    [
      { text: "Change visual", callback_data: "a:visual" },
      { text: "Remind me tomorrow", callback_data: "a:remind" },
    ],
    [{ text: "Done", callback_data: "a:done" }],
  ],
};

function carouselCaption(hook: string) {
  return `To publish: start a post → + → Add a document → upload this PDF. Suggested title: "${hook}"`;
}
const QUOTE_CAPTION = "Quote card. Attach it to the post as an image.";
const IMAGE_CAPTION = "Image. Attach it to the post.";

function largestPhoto(message: TgMessage): PostMeta["visual"] {
  const photo = message.photo?.[message.photo.length - 1];
  return photo ? { kind: "photo", fileId: photo.file_id } : undefined;
}

// "2026-10-23" for tomorrow, in Romanian time (where the cron's morning is).
function tomorrowInRomania() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Bucharest" });
}

// Sends a finished post again: text, first comment and the saved visual. Used by /history and reminders.
export async function sendSavedPost(chatId: number, post: Post, intro: string) {
  await sendMessage(chatId, intro);
  await sendMessage(chatId, post.final_text ?? "");
  if (post.meta.firstComment) {
    await sendMessage(chatId, "First comment:");
    await sendMessage(chatId, post.meta.firstComment);
  }
  const visual = post.meta.visual;
  if (visual) {
    const caption = visual.kind === "document" ? "Your carousel (PDF)." : "Your visual.";
    await resendFile(chatId, visual.kind, visual.fileId, caption);
  }
}

type Visual =
  | { kind: "carousel"; pdf: Uint8Array; cover: Buffer; slides: { title: string; body?: string }[]; costUsd: number }
  | { kind: "quote"; png: Buffer; costUsd: number }
  | { kind: "image"; png: Buffer; costUsd: number }
  // The user's own photo: already on Telegram, resent by file_id.
  | { kind: "own"; fileId: string; costUsd: number };

function progressSteps(options: PostOptions, isAdjustment: boolean, ownPhoto: boolean) {
  if (isCarousel(options)) {
    return ["Reviewing the post and writing slides…", "Designing slides…", "Building the PDF…"];
  }
  if (options.visual === "Image" && !isAdjustment && !ownPhoto) {
    return ["Generating the image (about 30 seconds)…", "Still generating…", "Finishing…"];
  }
  return ["Reviewing the post…", "Almost done…"];
}

async function finish(ctx: Ctx, post: Post, text: string, isAdjustment = false) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  ctx.session.data.chosenText = text;
  await saveSession(ctx.user.id, ctx.session);

  const stopProgress = startProgress(
    ctx.chatId,
    panelId,
    progressSteps(options, isAdjustment, Boolean(post.meta.userImageFileId)),
    8000,
  );
  try {
    const hooks = post.meta.hooks ?? [];
    const hook = hooks.includes(firstLine(text)) ? firstLine(text) : (hooks[0] ?? firstLine(text));
    // The editor pass cleans up filler before you see the post. After an edit you asked for,
    // we keep your wording and only take the score and comment.
    const [review, visual] = await withTyping(ctx.chatId, () =>
      Promise.all([polishPost(text, post.transcript!), makeVisual(ctx, post, options, text, hook, isAdjustment)]),
    );
    await stopProgress();
    if (!isAdjustment) text = review.text;

    const meta = {
      ...post.meta,
      score: review.score,
      firstComment: review.firstComment,
      ...(visual?.kind === "carousel" ? { slides: visual.slides } : {}),
    };
    await updatePost(post.id, { final_text: text, status: "done", meta });
    await addPostCost(post.id, review.costUsd + (visual?.costUsd ?? 0));

    await editMessage(
      ctx.chatId,
      panelId,
      isAdjustment ? "Updated version below." : "Your post is ready.",
    );
    // The post and the comment go alone in their own messages so they're easy to copy.
    await sendMessage(ctx.chatId, text);
    await sendMessage(ctx.chatId, statsText(text, review.score, review.question));
    await sendMessage(ctx.chatId, review.firstComment);

    const saved = visual ? await sendVisual(ctx, post, visual, hook) : undefined;
    if (!visual && isAdjustment && options.visual === "Image") {
      await sendMessage(ctx.chatId, "The image is unchanged.");
    }
    if (saved) await updatePost(post.id, { meta: { ...meta, visual: saved } });

    // The adjustment buttons become the new panel; free text now means "change this".
    const panel = await sendMessage(ctx.chatId, ADJUST_TEXT, adjustKeyboard);
    ctx.session = {
      step: "adjusting",
      data: {
        postId: post.id,
        panelMessageId: panel.message_id,
        chosenText: text,
        hookTries: ctx.session.data.hookTries,
        detailQuestion: review.question || undefined,
      },
    };
    await saveSession(ctx.user.id, ctx.session);

    // After the very first post, point out the features nobody would find on their own.
    if (!isAdjustment && !(await getProfile(ctx.user.id)).tipsShown) {
      await updateProfile(ctx, { tipsShown: true });
      await sendMessage(ctx.chatId, FIRST_POST_TIPS);
    }
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
    const { pdf, cover } = await buildCarousel(
      slides,
      options.style as CarouselStyle,
      profile,
      hook,
      options.structure === "Tips",
    );
    return { kind: "carousel", pdf, cover, slides, costUsd };
  }
  if (options.visual === "Quote card") {
    const quote = post.meta.quote ?? hook;
    const png = await renderQuoteCard(quote, options.style as CarouselStyle, await visualProfile(ctx));
    return { kind: "quote", png, costUsd: 0 };
  }
  // The image doesn't depend on the exact wording, so text tweaks keep it.
  if (options.visual === "Image" && post.meta.userImageFileId && !isAdjustment) {
    return { kind: "own", fileId: post.meta.userImageFileId, costUsd: 0 };
  }
  if (options.visual === "Image" && post.meta.imagePrompt && !isAdjustment) {
    const { png, costUsd } = await generateImage(post.meta.imagePrompt);
    return { kind: "image", png, costUsd };
  }
  return null;
}

function anotherImageKeyboard(postId: string): ReplyMarkup {
  return { inline_keyboard: [[{ text: "Another image", callback_data: `img:${postId}` }]] };
}

async function anotherImage(ctx: Ctx, postId: string) {
  const post = await getPost(postId);
  if (!post || post.telegram_id !== ctx.user.id || !post.meta.imagePrompt) return;
  await sendTyping(ctx.chatId);
  try {
    const { png, costUsd } = await withTyping(ctx.chatId, () => generateImage(post.meta.imagePrompt!));
    await addPostCost(post.id, costUsd);
    await sendPhoto(ctx.chatId, png, "Alternative image.", anotherImageKeyboard(post.id));
  } catch (error) {
    console.error("another image failed", error);
    await sendMessage(ctx.chatId, "Image generation failed. Please try again.");
  }
}

// ---------- Choosing the visual (after the version is picked) ----------

const MAX_IMAGE_QUESTIONS = 2;

async function chooseVisual(ctx: Ctx, post: Post, text: string) {
  ctx.session.data.chosenText = text;
  ctx.session.data.changingVisual = false;
  await saveSession(ctx.user.id, ctx.session);
  await showVisualMenu(ctx, post);
}

async function showVisualMenu(ctx: Ctx, post: Post) {
  const text = [
    "Now the visual. LinkedIn allows one per post.",
    "",
    "Carousel (PDF): swipeable slides, usually the most reach.",
    "Image: your own photo, or one created from your description.",
    "Quote card: the strongest line of your post, with your photo and name.",
  ].join("\n");
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, text, visualMenuKeyboard(postOptions(post)));
}

async function setVisual(ctx: Ctx, post: Post, visual: PostOptions["visual"]): Promise<Post> {
  const options = { ...postOptions(post), visual };
  await updatePost(post.id, { options });
  // Remember it, so the same visual is pre-selected next time.
  await upsertUser(ctx.user.id, { first_name: ctx.user.first_name, prefs: options });
  return { ...post, options };
}

async function showImageMenu(ctx: Ctx) {
  ctx.session.step = ctx.session.data.changingVisual ? "adjusting" : "idle";
  await saveSession(ctx.user.id, ctx.session);
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    "Image\n\nUse your own photo, or describe the image you want and I'll create it.",
    {
      inline_keyboard: [
        [
          { text: "Upload my own", callback_data: "im:up" },
          { text: "Create one", callback_data: "im:gen" },
        ],
        [{ text: "◀ Back", callback_data: "vis:menu" }],
      ],
    },
  );
}

async function visualButton(ctx: Ctx, post: Post, data: string) {
  const panelId = ctx.session.data.panelMessageId!;
  if (data === "vis:menu") {
    ctx.session.step = ctx.session.data.changingVisual ? "adjusting" : "idle";
    await saveSession(ctx.user.id, ctx.session);
    await showVisualMenu(ctx, post);
  } else if (data === "vis:go") {
    await proceedAfterVisual(ctx, post);
  } else if (data.startsWith("vis:")) {
    const visual = visualFromCode(data.slice(4));
    if (!visual) return;
    post = await setVisual(ctx, post, visual);
    if (visual === "Carousel" || visual === "Quote card") await showScreen(ctx, post, VISUAL_SCREEN);
    else if (visual === "Image") await showImageMenu(ctx);
    else await proceedAfterVisual(ctx, post);
  } else if (data === "im:up") {
    ctx.session.step = "awaiting_user_image";
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, panelId, "Send the photo you want to use with the post.", {
      inline_keyboard: [[{ text: "◀ Back", callback_data: "vis:i" }]],
    });
  } else if (data === "im:gen") {
    ctx.session.step = "awaiting_image_brief";
    ctx.session.data = {
      ...ctx.session.data,
      imageBrief: "",
      imageQuestion: undefined,
      imageQuestionsAsked: 0,
      imagePlan: undefined,
      imageSummary: undefined,
    };
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(
      ctx.chatId,
      panelId,
      "Describe the image: what's in it, where it is, the mood. A voice note works too.\n\nOr let me suggest one based on your post.",
      {
        inline_keyboard: [
          [{ text: "Suggest one", callback_data: "im:sug" }],
          [{ text: "◀ Back", callback_data: "vis:i" }],
        ],
      },
    );
  } else if (data === "im:sug") {
    const idea = post.meta.imagePrompt ?? "an image that fits the post";
    await planAndConfirm(ctx, post, `Suggest an image that fits the post. A starting idea: ${idea}`, false);
  } else if (data === "im:noq" && ctx.session.data.imagePlan) {
    await showImageConfirm(ctx);
  } else if (data === "im:ok" && ctx.session.data.imagePlan) {
    const meta = { ...post.meta, imagePrompt: ctx.session.data.imagePlan, userImageFileId: undefined };
    await updatePost(post.id, { meta });
    await proceedAfterVisual(ctx, { ...post, meta });
  }
}

// One step of the image brief: the user's description, or their answer to our question.
async function addImageBrief(ctx: Ctx, answer: string) {
  const post = ctx.session.data.postId ? await getPost(ctx.session.data.postId) : null;
  if (!post) return;
  const question = ctx.session.data.imageQuestion;
  const brief = [ctx.session.data.imageBrief, question ? `Q: ${question}\nA: ${answer}` : answer]
    .filter(Boolean)
    .join("\n\n");
  ctx.session.data.imageBrief = brief;
  // The answer pushed the panel up; continue in a fresh one at the bottom.
  const panel = await sendMessage(ctx.chatId, "Got it. Thinking about the image…");
  ctx.session.data.panelMessageId = panel.message_id;
  await saveSession(ctx.user.id, ctx.session);
  const canAsk = (ctx.session.data.imageQuestionsAsked ?? 0) < MAX_IMAGE_QUESTIONS;
  await planAndConfirm(ctx, post, brief, canAsk);
}

async function planAndConfirm(ctx: Ctx, post: Post, brief: string, canAsk: boolean) {
  const panelId = ctx.session.data.panelMessageId!;
  await editMessage(ctx.chatId, panelId, "Thinking about the image…");
  try {
    const plan = await withTyping(ctx.chatId, () => planImage(brief, ctx.session.data.chosenText ?? post.final_text ?? ""));
    await addPostCost(post.id, plan.costUsd);
    ctx.session.data.imageBrief = brief;
    ctx.session.data.imagePlan = plan.prompt;
    ctx.session.data.imageSummary = plan.summary;
    if (canAsk && plan.question) {
      ctx.session.step = "awaiting_image_brief";
      ctx.session.data.imageQuestion = plan.question;
      ctx.session.data.imageQuestionsAsked = (ctx.session.data.imageQuestionsAsked ?? 0) + 1;
      await saveSession(ctx.user.id, ctx.session);
      await editMessage(ctx.chatId, panelId, `${plan.question}\n\nAnswer with a voice note or text.`, {
        inline_keyboard: [[{ text: "Skip, show me the plan", callback_data: "im:noq" }]],
      });
      return;
    }
    await saveSession(ctx.user.id, ctx.session);
    await showImageConfirm(ctx);
  } catch (error) {
    console.error("image planning failed", error);
    await editMessage(ctx.chatId, panelId, ERROR_TEXT, {
      inline_keyboard: [[{ text: "◀ Back", callback_data: "vis:i" }]],
    });
  }
}

async function showImageConfirm(ctx: Ctx) {
  ctx.session.step = ctx.session.data.changingVisual ? "adjusting" : "idle";
  ctx.session.data.imageQuestion = undefined;
  await saveSession(ctx.user.id, ctx.session);
  await editMessage(
    ctx.chatId,
    ctx.session.data.panelMessageId!,
    `I'll create:\n\n${ctx.session.data.imageSummary ?? ""}\n\nA realistic photo, no text in the image.`,
    {
      inline_keyboard: [
        [
          { text: "Create image", callback_data: "im:ok" },
          { text: "Change description", callback_data: "im:gen" },
        ],
      ],
    },
  );
}

// The user's own photo, sent while we wait for it.
async function applyOwnImage(ctx: Ctx, fileId: string) {
  const post = ctx.session.data.postId ? await getPost(ctx.session.data.postId) : null;
  if (!post) return;
  const meta = { ...post.meta, userImageFileId: fileId };
  await updatePost(post.id, { meta });
  const panel = await sendMessage(ctx.chatId, "Photo received.");
  ctx.session.step = ctx.session.data.changingVisual ? "adjusting" : "idle";
  ctx.session.data.panelMessageId = panel.message_id;
  await saveSession(ctx.user.id, ctx.session);
  await proceedAfterVisual(ctx, { ...post, meta });
}

async function transcribeAnswer(ctx: Ctx, audio: TgAudioFile): Promise<string | null> {
  if (audio.duration > MAX_VOICE_SECONDS || (audio.file_size ?? 0) > MAX_FILE_BYTES) {
    await sendMessage(ctx.chatId, "That's too long. Please keep it under 5 minutes.");
    return null;
  }
  try {
    const { text, costUsd } = await withTyping(ctx.chatId, () =>
      transcribeVoice(audio.file_id, audio.duration, audio.file_name),
    );
    if (ctx.session.data.postId) await addPostCost(ctx.session.data.postId, costUsd);
    if (!text) await sendMessage(ctx.chatId, "No speech detected. Please try again, or type it.");
    return text || null;
  } catch (error) {
    console.error("transcription failed", error);
    await sendMessage(ctx.chatId, "Couldn't transcribe that. Please type it instead.");
    return null;
  }
}

// After the visual is chosen: the first time we finish the whole post; from "Change visual" only the visual.
async function proceedAfterVisual(ctx: Ctx, post: Post) {
  const text = ctx.session.data.chosenText;
  if (!text) return;
  if (ctx.session.data.changingVisual) await replaceVisual(ctx, post, text);
  else await finish(ctx, post, text);
}

// Sends a finished visual and returns its Telegram file_id so /history and reminders can resend it for free.
async function sendVisual(ctx: Ctx, post: Post, visual: Visual, hook: string): Promise<PostMeta["visual"]> {
  if (visual.kind === "carousel") {
    await sendPhoto(ctx.chatId, visual.cover, "Cover preview. The full carousel is the PDF below.");
    const sent = await sendDocument(ctx.chatId, visual.pdf, "carousel.pdf", carouselCaption(hook));
    return sent.document ? { kind: "document", fileId: sent.document.file_id } : undefined;
  }
  if (visual.kind === "quote") return largestPhoto(await sendPhoto(ctx.chatId, visual.png, QUOTE_CAPTION));
  if (visual.kind === "own") {
    await resendFile(ctx.chatId, "photo", visual.fileId, "Your photo. Attach it to the post.");
    return { kind: "photo", fileId: visual.fileId };
  }
  return largestPhoto(await sendPhoto(ctx.chatId, visual.png, IMAGE_CAPTION, anotherImageKeyboard(post.id)));
}

async function replaceVisual(ctx: Ctx, post: Post, text: string) {
  const panelId = ctx.session.data.panelMessageId!;
  const options = postOptions(post);
  const stopProgress = startProgress(
    ctx.chatId,
    panelId,
    progressSteps(options, false, Boolean(post.meta.userImageFileId)),
    8000,
  );
  try {
    const hooks = post.meta.hooks ?? [];
    const hook = hooks.includes(firstLine(text)) ? firstLine(text) : (hooks[0] ?? firstLine(text));
    const visual = await withTyping(ctx.chatId, () => makeVisual(ctx, post, options, text, hook, false));
    await stopProgress();
    await editMessage(ctx.chatId, panelId, visual ? "New visual below." : "No visual for this post.");
    const saved = visual ? await sendVisual(ctx, post, visual, hook) : undefined;
    await updatePost(post.id, { meta: { ...post.meta, visual: saved } });
    if (visual) await addPostCost(post.id, visual.costUsd);

    const panel = await sendMessage(ctx.chatId, ADJUST_TEXT, adjustKeyboard);
    ctx.session = {
      step: "adjusting",
      data: { postId: post.id, panelMessageId: panel.message_id, chosenText: text, hookTries: ctx.session.data.hookTries },
    };
    await saveSession(ctx.user.id, ctx.session);
  } catch (error) {
    await stopProgress();
    console.error("replace visual failed", error);
    await editMessage(ctx.chatId, panelId, ERROR_TEXT, {
      inline_keyboard: [[{ text: "◀ Back", callback_data: "vis:menu" }]],
    });
  }
}

// ---------- Adjustments ----------

const ADJUST_INSTRUCTIONS: Record<string, string> = {
  short: "Make it noticeably shorter, about 30% shorter. Keep the first line, the ending and the hashtags.",
  end: "Rewrite only the closing lines before the hashtags with a different, stronger ending. Keep the same kind of ending (question, follow invitation, or plain lesson).",
  emoji: "Remove most emoji. Keep at most one, only if it truly fits.",
};

async function adjust(ctx: Ctx, instruction: string, typedByUser = false) {
  const postId = ctx.session.data.postId;
  const current = ctx.session.data.chosenText;
  let post = postId ? await getPost(postId) : null;
  if (!post || !current) {
    await resetSession(ctx);
    await chat(ctx, instruction);
    return;
  }
  // A typed reply to "To make it stronger: …" is a new fact: add it to the story so the writer may use it.
  const detailQuestion = ctx.session.data.detailQuestion;
  if (typedByUser && detailQuestion) {
    const transcript = `${post.transcript}\n\nQ: ${detailQuestion}\nA: ${instruction}`;
    await updatePost(post.id, { transcript });
    post = { ...post, transcript };
    instruction = `Work in the author's answer to "${detailQuestion}": ${instruction}. Add it where it fits naturally and change nothing else.`;
    ctx.session.data.detailQuestion = undefined;
  }
  const story = post.transcript!;
  await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Revising…");
  const { styleGuide } = await getProfile(ctx.user.id);
  try {
    const { text, costUsd } = await withTyping(ctx.chatId, () =>
      revisePost(current, instruction, story, styleGuide),
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

// ---------- /ideas ----------

async function recentTopics(userId: number) {
  return (await listDonePosts(userId, 5)).map((post) => firstLine(post.final_text ?? "")).filter(Boolean);
}

async function showIdeas(ctx: Ctx, messageId?: number) {
  ctx.session = { step: "awaiting_story", data: {} };
  await saveSession(ctx.user.id, ctx.session);
  try {
    const profile = await getProfile(ctx.user.id);
    const { questions } = await withTyping(ctx.chatId, async () =>
      ideaQuestions(profile.headline, await recentTopics(ctx.user.id)),
    );
    const text = [
      "Pick one and answer it in a voice note.",
      "",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      "Your answer becomes the story for your post.",
    ].join("\n");
    const keyboard: ReplyMarkup = { inline_keyboard: [[{ text: "New questions", callback_data: "ideas" }]] };
    if (messageId) await editMessage(ctx.chatId, messageId, text, keyboard);
    else await sendMessage(ctx.chatId, text, keyboard);
  } catch (error) {
    console.error("ideas failed", error);
    await sendMessage(ctx.chatId, "Couldn't generate questions. Please try /ideas again.");
  }
}

// ---------- /history ----------

async function showHistory(ctx: Ctx) {
  const posts = await listDonePosts(ctx.user.id, 5);
  if (posts.length === 0) {
    await sendMessage(ctx.chatId, "No finished posts yet.");
    return;
  }
  const lines = posts.map((post, i) => {
    const date = new Date(post.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const score = post.meta.score ? ` · ${post.meta.score}/10` : "";
    return `${i + 1}. ${firstLine(post.final_text ?? "").slice(0, 70)}\n    ${date}${score}`;
  });
  await sendMessage(ctx.chatId, ["Recent posts. Select one to resend:", "", ...lines].join("\n"), {
    inline_keyboard: [posts.map((post, i) => ({ text: String(i + 1), callback_data: `hi:${post.id}` }))],
  });
}

// ---------- /banner ----------

async function startBanner(ctx: Ctx, messageId?: number) {
  ctx.session = { step: "awaiting_banner", data: {} };
  const intro = "Profile banner (1584 × 396).\n\nSend the line it should say, or choose one:";
  const panel = messageId
    ? (await editMessage(ctx.chatId, messageId, `${intro}\n\nGenerating suggestions…`), messageId)
    : (await sendMessage(ctx.chatId, `${intro}\n\nGenerating suggestions…`)).message_id;
  try {
    const profile = await getProfile(ctx.user.id);
    const taglines = await withTyping(ctx.chatId, async () =>
      suggestTaglines(profile.name ?? fullName(ctx.user), profile.headline, await recentTopics(ctx.user.id)),
    );
    ctx.session.data = { bannerOptions: taglines, panelMessageId: panel };
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, panel, [intro, "", ...taglines.map((t, i) => `${i + 1}. ${t}`)].join("\n"), {
      inline_keyboard: [taglines.map((_, i) => ({ text: String(i + 1), callback_data: `bn:${i}` }))],
    });
  } catch (error) {
    console.error("taglines failed", error);
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, panel, `${intro.split("\n\n")[0]}\n\nSend the line it should say.`);
  }
}

async function makeBanner(ctx: Ctx, tagline: string) {
  await resetSession(ctx);
  const line = tagline.trim().slice(0, 90);
  await sendTyping(ctx.chatId);
  try {
    const profile = await visualProfile(ctx);
    const styles: CarouselStyle[] = ["Minimal", "Colorful", "Dark"];
    const pngs = await withTyping(ctx.chatId, () => Promise.all(styles.map((style) => renderBanner(line, style, profile))));
    await sendDocumentAlbum(
      ctx.chatId,
      pngs.map((png, i) => ({ bytes: png, fileName: `banner-${styles[i].toLowerCase()}.png` })),
      "Your banner in 3 styles, full resolution. To upload: your LinkedIn profile → edit the background photo. For different text, send /banner again.",
    );
  } catch (error) {
    console.error("banner failed", error);
    await sendMessage(ctx.chatId, "Banner generation failed. Please try /banner again.");
  }
}

// ---------- Interview: up to 3 questions about the story before writing ----------

const MAX_INTERVIEW_QUESTIONS = 3;

const interviewKeyboard: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "Skip question", callback_data: "fu:skip" },
      { text: "Enough, continue", callback_data: "fu:done" },
    ],
  ],
};

// Each question is chosen from everything said so far, so nothing gets asked twice. Done once per post.
async function followUpOrContinue(ctx: Ctx, post: Post) {
  if (post.meta.followUpAsked) {
    await showOptionsStart(ctx, post);
    return;
  }
  await askNextQuestion(ctx, post);
}

async function askNextQuestion(ctx: Ctx, post: Post) {
  const panelId = ctx.session.data.panelMessageId!;
  const asked = ctx.session.data.followUpCount ?? 0;
  if (asked >= MAX_INTERVIEW_QUESTIONS) {
    await endInterview(ctx, post);
    return;
  }

  await editMessage(ctx.chatId, panelId, asked === 0 ? "Reviewing the story…" : "Noted. Reviewing…");
  let question = "";
  try {
    const result = await withTyping(ctx.chatId, () =>
      nextInterviewQuestion(post.transcript!, ctx.session.data.skippedQuestions ?? []),
    );
    question = result.question;
    await addPostCost(post.id, result.costUsd);
  } catch (error) {
    // Not essential: if the check fails, carry on to the options.
    console.error("interview question failed", error);
  }
  if (!question) {
    await endInterview(ctx, post);
    return;
  }

  ctx.session.step = "awaiting_followup";
  ctx.session.data.followUpQuestion = question;
  ctx.session.data.followUpCount = asked + 1;
  await saveSession(ctx.user.id, ctx.session);
  const intro = asked === 0 ? "A few questions first, so the post has real detail.\n\n" : "";
  await editMessage(
    ctx.chatId,
    panelId,
    `${intro}Question ${asked + 1}: ${question}\n\nAnswer with a voice note or text.`,
    interviewKeyboard,
  );
}

async function endInterview(ctx: Ctx, post: Post) {
  const meta = { ...post.meta, followUpAsked: true };
  await updatePost(post.id, { meta });
  ctx.session = { step: "idle", data: { postId: post.id, panelMessageId: ctx.session.data.panelMessageId } };
  await saveSession(ctx.user.id, ctx.session);
  await showOptionsStart(ctx, { ...post, meta });
}

async function answerFollowUp(ctx: Ctx, answer: string) {
  const post = ctx.session.data.postId ? await getPost(ctx.session.data.postId) : null;
  if (!post) {
    await resetSession(ctx);
    await chat(ctx, answer);
    return;
  }
  const question = ctx.session.data.followUpQuestion ?? "More context";
  const transcript = `${post.transcript}\n\nQ: ${question}\nA: ${answer}`;
  await updatePost(post.id, { transcript });
  // The answer pushed the panel up; continue in a fresh one at the bottom.
  const panel = await sendMessage(ctx.chatId, "Noted.");
  ctx.session.step = "idle";
  ctx.session.data.panelMessageId = panel.message_id;
  ctx.session.data.followUpQuestion = undefined;
  await saveSession(ctx.user.id, ctx.session);
  await askNextQuestion(ctx, { ...post, transcript });
}

async function skipQuestion(ctx: Ctx, post: Post) {
  const question = ctx.session.data.followUpQuestion;
  ctx.session.step = "idle";
  ctx.session.data.skippedQuestions = [...(ctx.session.data.skippedQuestions ?? []), ...(question ? [question] : [])];
  ctx.session.data.followUpQuestion = undefined;
  await saveSession(ctx.user.id, ctx.session);
  await askNextQuestion(ctx, post);
}

async function answerFollowUpVoice(ctx: Ctx, audio: TgAudioFile) {
  if (audio.duration > MAX_VOICE_SECONDS || (audio.file_size ?? 0) > MAX_FILE_BYTES) {
    await sendMessage(ctx.chatId, "That answer is too long. Please keep it under 5 minutes.");
    return;
  }
  try {
    const { text, costUsd } = await withTyping(ctx.chatId, () =>
      transcribeVoice(audio.file_id, audio.duration, audio.file_name),
    );
    if (ctx.session.data.postId) await addPostCost(ctx.session.data.postId, costUsd);
    if (!text) {
      await sendMessage(ctx.chatId, "No speech detected. Please answer again, or type it.");
      return;
    }
    await answerFollowUp(ctx, text);
  } catch (error) {
    console.error("interview transcription failed", error);
    await sendMessage(ctx.chatId, "Couldn't transcribe that. Please type the answer instead.");
  }
}

// ---------- /style ----------

async function showStyle(ctx: Ctx) {
  const profile = await getProfile(ctx.user.id);
  if (profile.styleGuide) {
    await sendMessage(
      ctx.chatId,
      `Your style profile:\n\n${profile.styleSummary ?? ""}\n\nNew posts are written in this style.`,
      {
        inline_keyboard: [
          [
            { text: "Update", callback_data: "st:new" },
            { text: "Remove", callback_data: "st:reset" },
          ],
        ],
      },
    );
    return;
  }
  await startStyle(ctx);
}

async function startStyle(ctx: Ctx, messageId?: number) {
  ctx.session = { step: "awaiting_style", data: { styleSamples: [] } };
  await saveSession(ctx.user.id, ctx.session);
  const text =
    "Send 2 or 3 of your past LinkedIn posts, one per message. Copy the text from LinkedIn and paste it here. I'll match their style: rhythm, openings, endings, emoji.";
  if (messageId) await editMessage(ctx.chatId, messageId, text);
  else await sendMessage(ctx.chatId, text);
}

async function addStyleSample(ctx: Ctx, text: string) {
  const samples = [...(ctx.session.data.styleSamples ?? []), text.slice(0, 3500)];
  ctx.session.data.styleSamples = samples;
  await saveSession(ctx.user.id, ctx.session);
  if (samples.length >= 3) {
    await learnFromSamples(ctx);
    return;
  }
  await sendMessage(ctx.chatId, `Post ${samples.length} received. Send another, or tap Done.`, {
    inline_keyboard: [[{ text: `Done (${samples.length})`, callback_data: "st:done" }]],
  });
}

async function learnFromSamples(ctx: Ctx, messageId?: number) {
  const samples = ctx.session.data.styleSamples ?? [];
  if (samples.length === 0) {
    await sendMessage(ctx.chatId, "Send at least one post first.");
    return;
  }
  const status = messageId ?? (await sendMessage(ctx.chatId, "Analyzing your style…")).message_id;
  if (messageId) await editMessage(ctx.chatId, messageId, "Analyzing your style…");
  try {
    const { guide, summary } = await withTyping(ctx.chatId, () => learnStyle(samples));
    await updateProfile(ctx, { styleGuide: guide, styleSummary: summary });
    await resetSession(ctx);
    await editMessage(
      ctx.chatId,
      status,
      `Style saved.\n\n${summary}\n\nNew posts will be written in this style. Use /style to update or remove it.`,
    );
  } catch (error) {
    console.error("style analysis failed", error);
    await editMessage(ctx.chatId, status, "Style analysis failed. Please try /style again.");
  }
}

async function styleButton(ctx: Ctx, action: string, messageId: number) {
  if (action === "new") {
    await startStyle(ctx, messageId);
  } else if (action === "reset") {
    await updateProfile(ctx, { styleGuide: undefined, styleSummary: undefined });
    await editMessage(ctx.chatId, messageId, "Style removed. New posts use the default style.");
  } else if (action === "done" && ctx.session.step === "awaiting_style") {
    await learnFromSamples(ctx, messageId);
  }
}

// ---------- /drafts ----------

async function showDrafts(ctx: Ctx) {
  const drafts = await listDraftPosts(ctx.user.id, 5);
  if (drafts.length === 0) {
    await sendMessage(ctx.chatId, "No unfinished posts.");
    return;
  }
  const lines = drafts.map((draft, i) => {
    const date = new Date(draft.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const stage = draft.variants?.length ? "versions ready" : "story only";
    const preview = (draft.transcript ?? "").replace(/\s+/g, " ").slice(0, 70);
    return `${i + 1}. ${preview}…\n    ${date} · ${stage}`;
  });
  await sendMessage(ctx.chatId, ["Unfinished posts. Select one to continue:", "", ...lines].join("\n"), {
    inline_keyboard: [
      drafts.map((draft, i) => ({ text: String(i + 1), callback_data: `dr:${draft.id}` })),
      [{ text: "Clear all", callback_data: "dr:clear" }],
    ],
  });
}

async function draftButton(ctx: Ctx, arg: string, messageId: number) {
  if (arg === "clear") {
    await discardDrafts(ctx.user.id);
    await editMessage(ctx.chatId, messageId, "Drafts cleared.");
    return;
  }
  const post = await getPost(arg);
  if (!post || post.telegram_id !== ctx.user.id || post.status !== "draft") {
    await sendMessage(ctx.chatId, "This draft is no longer available.");
    return;
  }
  const panel = await sendMessage(ctx.chatId, "Resuming…");
  ctx.session = { step: "idle", data: { postId: post.id, panelMessageId: panel.message_id, variantIndex: 0 } };
  await saveSession(ctx.user.id, ctx.session);
  if (post.variants?.length) await showVariant(ctx, post);
  else await showOptionsStart(ctx, post);
}

// ---------- /costs ----------

async function showCosts(ctx: Ctx) {
  const costs = await costSummary(ctx.user.id);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const average = costs.donePosts ? usd(costs.totalUsd / costs.donePosts) : "n/a";
  await sendMessage(
    ctx.chatId,
    [
      "Approximate costs",
      "",
      `This month: ${usd(costs.monthUsd)} · ${costs.monthDonePosts} posts`,
      `All time: ${usd(costs.totalUsd)} · ${costs.donePosts} posts`,
      `Average per finished post: ${average}`,
      "",
      "Includes transcription, writing, visuals and edits, including unfinished posts.",
    ].join("\n"),
  );
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
    await editMessage(ctx.chatId, message.message_id, data === "mk" ? "Creating post…" : "Okay.");
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
    if (what === "banner") {
      await startBanner(ctx, message.message_id);
      return;
    }
    if (what === "done") {
      await editMessage(ctx.chatId, message.message_id, "Settings saved.");
      return;
    }
    const prompts: Record<string, [Session["step"], string]> = {
      photo: ["awaiting_photo", "Send a headshot. A clear, well-lit photo works best."],
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
      await editMessage(ctx.chatId, message.message_id, "Photo saved. It will appear on your carousels and quote cards.");
    } else {
      await editMessage(ctx.chatId, message.message_id, "Photo not used.");
    }
    return;
  }

  // "Skip" during the first-time setup.
  if (data === "ob:skip") {
    await answerCallback(query.id);
    // Cosmetic only: mark the question as skipped. Never let it block the setup.
    await editMessage(
      ctx.chatId,
      message.message_id,
      `${message.text ?? ""}\n\n(Skipped. You can add it later in /settings.)`,
    ).catch(() => {});
    if (ctx.session.step === "awaiting_headline") await askOnboardingPhoto(ctx);
    else await finishOnboarding(ctx);
    return;
  }

  if (data.startsWith("st:")) {
    await answerCallback(query.id);
    await styleButton(ctx, data.slice(3), message.message_id);
    return;
  }

  if (data.startsWith("dr:")) {
    await answerCallback(query.id);
    await draftButton(ctx, data.slice(3), message.message_id);
    return;
  }

  if (data === "ideas") {
    await answerCallback(query.id);
    await showIdeas(ctx, message.message_id);
    return;
  }

  if (data.startsWith("bn:")) {
    await answerCallback(query.id);
    const tagline = ctx.session.data.bannerOptions?.[Number(data.slice(3))];
    if (ctx.session.step !== "awaiting_banner" || !tagline) return;
    await editMessage(ctx.chatId, message.message_id, `Creating banner: "${tagline}"…`);
    await makeBanner(ctx, tagline);
    return;
  }

  if (data.startsWith("hi:")) {
    await answerCallback(query.id);
    const post = await getPost(data.slice(3));
    if (!post || post.telegram_id !== ctx.user.id) return;
    await sendSavedPost(ctx.chatId, post, "Saved post:");
    return;
  }

  // "Another image" lives under a finished post, not on the panel.
  if (data.startsWith("img:")) {
    await answerCallback(query.id, "Generating…");
    await anotherImage(ctx, data.slice(4));
    return;
  }

  // Every other button belongs to the post panel. Ignore taps on old panels.
  const postId = ctx.session.data.postId;
  const post = postId ? await getPost(postId) : null;
  if (!post || message.message_id !== ctx.session.data.panelMessageId) {
    await answerCallback(query.id, "This session has ended. Send a new voice note to start again.");
    return;
  }
  await answerCallback(query.id);

  if (data === "ok") {
    await followUpOrContinue(ctx, post);
  } else if (data === "fu:skip" && ctx.session.step === "awaiting_followup") {
    await skipQuestion(ctx, post);
  } else if (data === "fu:done" && ctx.session.step === "awaiting_followup") {
    await endInterview(ctx, post);
  } else if (data === "fix") {
    ctx.session.step = "awaiting_correction";
    await saveSession(ctx.user.id, ctx.session);
    await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Send the corrected transcript as text. The current version is below.");
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
    await chooseVisual(ctx, post, hook ? applyHook(variant.text, hook) : variant.text);
  } else if (data.startsWith("vis:") || data.startsWith("im:")) {
    await visualButton(ctx, post, data);
  } else if (data.startsWith("a:") && ctx.session.step === "adjusting") {
    const action = data.slice(2);
    if (action === "visual") {
      ctx.session.data.changingVisual = true;
      await saveSession(ctx.user.id, ctx.session);
      await showVisualMenu(ctx, post);
    } else if (action === "done") {
      await editMessage(ctx.chatId, message.message_id, "Saved. Send a voice note whenever you have the next story.");
      await resetSession(ctx);
    } else if (action === "remind") {
      await updatePost(post.id, { meta: { ...post.meta, remindOn: tomorrowInRomania(), remindedAt: undefined } });
      await editMessage(
        ctx.chatId,
        message.message_id,
        `Reminder set for tomorrow morning.\n\n${ADJUST_TEXT}`,
        adjustKeyboard,
      );
    } else if (action === "hook") {
      await otherHook(ctx, post);
    } else if (ADJUST_INSTRUCTIONS[action]) {
      await adjust(ctx, ADJUST_INSTRUCTIONS[action]);
    }
  } else if (data === "retry") {
    const retry = ctx.session.data.retry;
    if (retry === "transcribe") {
      await editMessage(ctx.chatId, ctx.session.data.panelMessageId!, "Retrying…");
      await transcribe(ctx, post);
    } else if (retry === "generate") {
      await generate(ctx, post);
    } else if (retry === "finish" && ctx.session.data.chosenText) {
      await finish(ctx, post, ctx.session.data.chosenText, ctx.session.step === "adjusting");
    }
  }
}
