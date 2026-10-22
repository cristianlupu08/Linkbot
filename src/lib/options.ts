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
      { code: "5", label: "5 slides" },
      { code: "8", label: "8 slides" },
      { code: "i", label: "Image" },
      { code: "n", label: "None" },
    ],
  },
  {
    key: "style",
    code: "s",
    screen: 1,
    label: "Carousel style",
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
  visual: "5 slides",
  style: "Minimal",
  structure: "Story",
  emoji: "A few",
  ending: "Question",
};

const SCREEN_TITLES = ["The text", "The visual", "Finishing touches"];
export const SCREEN_COUNT = SCREEN_TITLES.length;

export function isCarousel(options: PostOptions) {
  return options.visual === "5 slides" || options.visual === "8 slides";
}

export function slideCount(options: PostOptions) {
  return options.visual === "8 slides" ? 8 : 5;
}

// Questions shown on a screen. Style and structure only matter for a carousel.
function screenQuestions(screen: number, options: PostOptions) {
  return QUESTIONS.filter(
    (q) => q.screen === screen && (isCarousel(options) || (q.key !== "style" && q.key !== "structure")),
  );
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
  if (screen === 1 && !isCarousel(options)) {
    lines.push("", "Tip: a carousel (PDF) usually gets the most attention on LinkedIn.");
  }
  lines.push("", "Tap to change.");
  return lines.join("\n");
}

export function screenKeyboard(screen: number, options: PostOptions, canRepeatLast: boolean): ReplyMarkup {
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
  if (screen === 0 && canRepeatLast) {
    rows.push([{ text: "⚡ Same as last time", callback_data: "fast" }]);
  }
  return { inline_keyboard: rows };
}

export function describeVisual(options: PostOptions) {
  if (isCarousel(options)) return `Carousel, ${options.visual} · ${options.style} · ${options.structure}`;
  return options.visual === "Image" ? "AI image" : "None";
}

export function summaryText(options: PostOptions) {
  return [
    "Here's the plan:",
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
