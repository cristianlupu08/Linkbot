import type { Button, ReplyMarkup } from "./telegram";

// The option screens. Each question is one row of buttons; its name lives in the message text.
// Codes are short because callback_data is limited to 64 bytes.
// Screens 0 and 1 are about the text and come before writing. Screen 2 is about the visual
// and comes after the user has picked a version, so they choose it knowing the post.
export const QUESTIONS = [
  // Screen 1: the text
  {
    key: "tone",
    code: "t",
    screen: 0,
    label: "Tone",
    choices: [
      { code: "s", label: "Serious" },
      { code: "f", label: "Funny" },
      { code: "i", label: "Inspiring" },
    ],
  },
  {
    key: "length",
    code: "l",
    screen: 0,
    label: "Length",
    choices: [
      { code: "s", label: "Short" },
      { code: "m", label: "Medium" },
      { code: "l", label: "Long" },
    ],
  },
  {
    key: "audience",
    code: "a",
    screen: 0,
    label: "Who it's for",
    choices: [
      { code: "r", label: "Recruiters" },
      { code: "c", label: "Colleagues" },
      { code: "k", label: "Clients" },
    ],
  },
  // Screen 2: finishing touches
  {
    key: "emoji",
    code: "e",
    screen: 1,
    label: "Emoji",
    choices: [
      { code: "n", label: "None" },
      { code: "f", label: "A few" },
      { code: "l", label: "Lots" },
    ],
  },
  {
    key: "ending",
    code: "n",
    screen: 1,
    label: "Ending",
    choices: [
      { code: "q", label: "Question" },
      { code: "f", label: "Follow me" },
      { code: "n", label: "None" },
    ],
  },
  // Visual details, shown after a version is picked
  {
    key: "slides",
    code: "k",
    screen: 2,
    label: "Number of slides",
    choices: [
      { code: "5", label: "5 slides" },
      { code: "8", label: "8 slides" },
    ],
  },
  {
    key: "style",
    code: "s",
    screen: 2,
    label: "Style",
    choices: [
      { code: "m", label: "Minimal" },
      { code: "c", label: "Colorful" },
      { code: "d", label: "Dark" },
    ],
  },
  {
    key: "structure",
    code: "r",
    screen: 2,
    label: "Carousel structure",
    choices: [
      { code: "s", label: "Story" },
      { code: "t", label: "Tips" },
      { code: "b", label: "Before/After" },
    ],
  },
] as const;

// LinkedIn allows a PDF or an image on a post, not both. Picked from its own menu, not a row.
export const VISUALS = [
  { code: "c", label: "Carousel", button: "Carousel (PDF)" },
  { code: "i", label: "Image", button: "Image" },
  { code: "q", label: "Quote card", button: "Quote card" },
  { code: "n", label: "None", button: "No visual" },
] as const;

type Question = (typeof QUESTIONS)[number];
export type PostOptions = { [Q in Question as Q["key"]]: Q["choices"][number]["label"] } & {
  visual: (typeof VISUALS)[number]["label"];
};

export const DEFAULT_OPTIONS: PostOptions = {
  tone: "Serious",
  length: "Medium",
  audience: "Colleagues",
  visual: "Carousel",
  slides: "5 slides",
  style: "Minimal",
  structure: "Story",
  emoji: "A few",
  ending: "Question",
};

const SCREEN_TITLES = ["The text", "Finishing touches"];
// Screens before writing; the visual screen comes later.
export const SCREEN_COUNT = SCREEN_TITLES.length;
export const VISUAL_SCREEN = 2;

export function isCarousel(options: PostOptions) {
  return options.visual === "Carousel";
}

export function slideCount(options: PostOptions) {
  return options.slides === "8 slides" ? 8 : 5;
}

// Fills in defaults and upgrades options saved by older versions of the bot.
export function normalizeOptions(saved: Record<string, unknown> | null | undefined): PostOptions {
  const options = { ...DEFAULT_OPTIONS, ...saved } as PostOptions;
  const legacyVisual = saved?.visual;
  if (legacyVisual === "5 slides" || legacyVisual === "8 slides") {
    return { ...options, slides: legacyVisual, visual: "Carousel" };
  }
  return options;
}

// Questions shown on a screen. Slides and structure only matter for a carousel; style also for a quote card.
function screenQuestions(screen: number, options: PostOptions) {
  return QUESTIONS.filter((q) => {
    if (q.screen !== screen) return false;
    if (q.key === "slides" || q.key === "structure") return isCarousel(options);
    if (q.key === "style") return isCarousel(options) || options.visual === "Quote card";
    return true;
  });
}

// Applies a tap like "o:t:f" (tone = Funny). Returns the new options and the screen to redraw.
export function applyOptionTap(
  options: PostOptions,
  data: string,
): { options: PostOptions; screen: number } | null {
  const [, questionCode, choiceCode] = data.split(":");
  const question = QUESTIONS.find((q) => q.code === questionCode);
  const choice = question?.choices.find((c) => c.code === choiceCode);
  if (!question || !choice) return null;
  return { options: { ...options, [question.key]: choice.label }, screen: question.screen };
}

export function screenText(screen: number, options: PostOptions) {
  if (screen === VISUAL_SCREEN) {
    const title = isCarousel(options) ? "Carousel (PDF)" : "Quote card";
    return [
      title,
      "",
      ...screenQuestions(screen, options).map((q, i) => `${i + 1}. ${q.label}`),
      "",
      "Tap to change, then Create.",
    ].join("\n");
  }
  return [
    `Step ${screen + 1}/${SCREEN_COUNT} · ${SCREEN_TITLES[screen]}`,
    "",
    ...screenQuestions(screen, options).map((q, i) => `${i + 1}. ${q.label}`),
    "",
    "Tap to change.",
  ].join("\n");
}

export function screenKeyboard(screen: number, options: PostOptions): ReplyMarkup {
  const rows: Button[][] = screenQuestions(screen, options).map((question) =>
    question.choices.map((choice) => ({
      text: options[question.key] === choice.label ? `✓ ${choice.label}` : choice.label,
      callback_data: `o:${question.code}:${choice.code}`,
    })),
  );

  if (screen === VISUAL_SCREEN) {
    rows.push([
      { text: "◀ Back", callback_data: "vis:menu" },
      { text: "Create ▶", callback_data: "vis:go" },
    ]);
    return { inline_keyboard: rows };
  }

  const nav: Button[] = [];
  if (screen > 0) nav.push({ text: "◀ Back", callback_data: `sc:${screen - 1}` });
  nav.push(
    screen < SCREEN_COUNT - 1
      ? { text: "Next ▶", callback_data: `sc:${screen + 1}` }
      : { text: "Next ▶", callback_data: "sum" },
  );
  rows.push(nav);
  return { inline_keyboard: rows };
}

export function summaryText(options: PostOptions, fromLastTime: boolean) {
  return [
    fromLastTime ? "Using your last settings:" : "Summary:",
    "",
    `Tone: ${options.tone}`,
    `Length: ${options.length}`,
    `For: ${options.audience}`,
    `Emoji: ${options.emoji}`,
    `Ending: ${options.ending}`,
    "",
    "You'll choose the visual after picking a version.",
  ].join("\n");
}

export const summaryKeyboard: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "Generate", callback_data: "gen" },
      { text: "Edit settings", callback_data: "sc:0" },
    ],
  ],
};

// The visual menu after a version is picked. The last choice gets a check mark.
export function visualMenuKeyboard(options: PostOptions): ReplyMarkup {
  const button = (v: (typeof VISUALS)[number]) => ({
    text: options.visual === v.label ? `✓ ${v.button}` : v.button,
    callback_data: `vis:${v.code}`,
  });
  return { inline_keyboard: [[button(VISUALS[0]), button(VISUALS[1])], [button(VISUALS[2]), button(VISUALS[3])]] };
}

export function visualFromCode(code: string) {
  return VISUALS.find((v) => v.code === code)?.label;
}
