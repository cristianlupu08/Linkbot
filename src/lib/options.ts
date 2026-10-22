import type { Button, ReplyMarkup } from "./telegram";

// The option screens. Each question is one row of buttons; its name lives in the message text.
// Codes are short because callback_data is limited to 64 bytes.
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
  // Screen 2: the visual. LinkedIn allows a PDF or an image on a post, not both.
  {
    key: "visual",
    code: "v",
    screen: 1,
    label: "Visual",
    choices: [
      { code: "c", label: "Carousel" },
      { code: "q", label: "Quote card" },
      { code: "i", label: "Image" },
      { code: "n", label: "None" },
    ],
  },
  {
    key: "slides",
    code: "k",
    screen: 1,
    label: "Number of slides",
    choices: [
      { code: "5", label: "5 slides" },
      { code: "8", label: "8 slides" },
    ],
  },
  {
    key: "style",
    code: "s",
    screen: 1,
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
    screen: 1,
    label: "Carousel structure",
    choices: [
      { code: "s", label: "Story" },
      { code: "t", label: "Tips" },
      { code: "b", label: "Before/After" },
    ],
  },
  // Screen 3: finishing touches
  {
    key: "emoji",
    code: "e",
    screen: 2,
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
    screen: 2,
    label: "Ending",
    choices: [
      { code: "q", label: "Question" },
      { code: "f", label: "Follow me" },
      { code: "n", label: "None" },
    ],
  },
] as const;

type Question = (typeof QUESTIONS)[number];
export type PostOptions = { [Q in Question as Q["key"]]: Q["choices"][number]["label"] };

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

const SCREEN_TITLES = ["The text", "The visual", "Finishing touches"];
export const SCREEN_COUNT = SCREEN_TITLES.length;

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
  const lines = [
    `Step ${screen + 1}/${SCREEN_COUNT} · ${SCREEN_TITLES[screen]}`,
    "",
    ...screenQuestions(screen, options).map((q, i) => `${i + 1}. ${q.label}`),
  ];
  if (screen === 1) {
    lines.push("", "Tip: a carousel (PDF) usually gets the most attention on LinkedIn. A quote card is quick and personal.");
  }
  lines.push("", "Tap to change.");
  return lines.join("\n");
}

export function screenKeyboard(screen: number, options: PostOptions): ReplyMarkup {
  const rows: Button[][] = screenQuestions(screen, options).map((question) =>
    question.choices.map((choice) => ({
      text: options[question.key] === choice.label ? `✓ ${choice.label}` : choice.label,
      callback_data: `o:${question.code}:${choice.code}`,
    })),
  );

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

export function describeVisual(options: PostOptions) {
  if (isCarousel(options)) return `Carousel, ${options.slides} · ${options.style} · ${options.structure}`;
  if (options.visual === "Quote card") return `Quote card · ${options.style}`;
  return options.visual === "Image" ? "AI image" : "None";
}

export function summaryText(options: PostOptions, fromLastTime: boolean) {
  return [
    fromLastTime ? "Same as last time? Here's the plan:" : "Here's the plan:",
    "",
    `Tone: ${options.tone}`,
    `Length: ${options.length}`,
    `For: ${options.audience}`,
    `Visual: ${describeVisual(options)}`,
    `Emoji: ${options.emoji}`,
    `Ending: ${options.ending}`,
  ].join("\n");
}

export const summaryKeyboard: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: "Write it ✍️", callback_data: "gen" },
      { text: "Change something", callback_data: "sc:0" },
    ],
  ],
};
