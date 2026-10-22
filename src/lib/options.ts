import type { Button, ReplyMarkup } from "./telegram";

// Options screen 1 ("The text"). Codes are short because callback_data is limited to 64 bytes.
export const QUESTIONS = [
  {
    key: "tone",
    code: "t",
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
    label: "For",
    choices: [
      { code: "r", label: "Recruiters" },
      { code: "c", label: "Colleagues" },
      { code: "k", label: "Clients" },
    ],
  },
] as const;

export type PostOptions = {
  tone: "Serious" | "Funny" | "Inspiring";
  length: "Short" | "Medium" | "Long";
  audience: "Recruiters" | "Colleagues" | "Clients";
};

export const DEFAULT_OPTIONS: PostOptions = {
  tone: "Serious",
  length: "Medium",
  audience: "Colleagues",
};

// Applies a tap like "o:t:f" (tone = Funny). Returns null if the code is unknown.
export function applyOptionTap(options: PostOptions, data: string): PostOptions | null {
  const [, questionCode, choiceCode] = data.split(":");
  const question = QUESTIONS.find((q) => q.code === questionCode);
  const choice = question?.choices.find((c) => c.code === choiceCode);
  if (!question || !choice) return null;
  return { ...options, [question.key]: choice.label };
}

export function optionsText() {
  return [
    "Nice. A few quick choices before I write:",
    "",
    "1. Tone",
    "2. Length",
    "3. Who it's for",
    "",
    "Tap to change, then hit Write it.",
  ].join("\n");
}

export function optionsKeyboard(options: PostOptions): ReplyMarkup {
  const rows: Button[][] = QUESTIONS.map((question) =>
    question.choices.map((choice) => ({
      text: options[question.key] === choice.label ? `✓ ${choice.label}` : choice.label,
      callback_data: `o:${question.code}:${choice.code}`,
    })),
  );
  rows.push([{ text: "Write it ✍️", callback_data: "gen" }]);
  return { inline_keyboard: rows };
}
