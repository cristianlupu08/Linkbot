import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { PDFDocument } from "pdf-lib";

// LinkedIn carousel: portrait 4:5. AI writes only the text; the design is all code,
// because image models still misspell words.
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

export type Slide = { title: string; body?: string };
export type CarouselStyle = "Minimal" | "Colorful" | "Dark";

type Palette = { bg: string; text: string; muted: string; accent: string; accentText: string };

type Theme = {
  titleFont: "Serif" | "Inter";
  titleWeight: 400 | 800;
  // One palette per slide, cycling, so Colorful can alternate backgrounds.
  palettes: Palette[];
};

const THEMES: Record<CarouselStyle, Theme> = {
  Minimal: {
    titleFont: "Serif",
    titleWeight: 400,
    palettes: [{ bg: "#F6F3EC", text: "#17171B", muted: "#6E6B66", accent: "#D9472B", accentText: "#FFFFFF" }],
  },
  Colorful: {
    titleFont: "Inter",
    titleWeight: 800,
    palettes: [
      { bg: "#3D5AFE", text: "#FFFFFF", muted: "#D6DCFF", accent: "#FFD23F", accentText: "#1A1A1A" },
      { bg: "#FFD23F", text: "#1A1A1A", muted: "#5C4C12", accent: "#3D5AFE", accentText: "#FFFFFF" },
      { bg: "#FF6B57", text: "#FFFFFF", muted: "#FFE1DC", accent: "#1A1A1A", accentText: "#FFFFFF" },
    ],
  },
  Dark: {
    titleFont: "Inter",
    titleWeight: 800,
    palettes: [{ bg: "#0F1013", text: "#F5F5F4", muted: "#9A9AA0", accent: "#D7FF3E", accentText: "#0F1013" }],
  },
};

type Fonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;
let fontsPromise: Promise<Fonts> | undefined;

function loadFonts() {
  const dir = path.join(process.cwd(), "assets", "fonts");
  const font = (file: string) => readFile(path.join(dir, file));
  fontsPromise ??= Promise.all([
    font("Inter-Regular.ttf"),
    font("Inter-SemiBold.ttf"),
    font("Inter-ExtraBold.ttf"),
    font("DMSerifDisplay-Regular.ttf"),
  ]).then(([regular, semibold, extrabold, serif]) => [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: semibold, weight: 600 as const, style: "normal" as const },
    { name: "Inter", data: extrabold, weight: 800 as const, style: "normal" as const },
    { name: "Serif", data: serif, weight: 400 as const, style: "normal" as const },
  ]);
  return fontsPromise;
}

// Shorter text gets bigger type, so every slide stays readable and nothing overflows.
function titleSize(text: string, isCover: boolean) {
  const n = text.length;
  if (isCover) return n <= 30 ? 118 : n <= 55 ? 100 : n <= 85 ? 84 : 70;
  return n <= 25 ? 92 : n <= 50 ? 78 : n <= 80 ? 66 : 56;
}

function bodySize(text: string) {
  const n = text.length;
  return n <= 110 ? 46 : n <= 180 ? 42 : n <= 260 ? 37 : 33;
}

type SlideProps = {
  slide: Slide;
  index: number;
  total: number;
  author: string;
  theme: Theme;
};

function SlideView({ slide, index, total, author, theme }: SlideProps) {
  const p = theme.palettes[index % theme.palettes.length];
  const isCover = index === 0;
  const isLast = index === total - 1;
  const titleFamily = theme.titleFont;
  const tSize = titleSize(slide.title, isCover);
  const initials = author
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      style={{
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: p.bg,
        color: p.text,
        padding: "96px 92px 84px",
        fontFamily: "Inter",
      }}
    >
      {/* Top: accent mark */}
      <div style={{ display: "flex", alignItems: "center" }}>
        {isCover || isLast ? (
          <div style={{ width: 120, height: 14, backgroundColor: p.accent, borderRadius: 7 }} />
        ) : (
          <div
            style={{
              display: "flex",
              fontSize: 34,
              fontWeight: 800,
              color: p.accentText,
              backgroundColor: p.accent,
              padding: "10px 24px",
              borderRadius: 999,
            }}
          >
            {String(index).padStart(2, "0")}
          </div>
        )}
      </div>

      {/* Middle: the words */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: titleFamily,
            fontWeight: theme.titleWeight,
            fontSize: tSize,
            lineHeight: titleFamily === "Serif" ? 1.08 : 1.12,
            letterSpacing: titleFamily === "Serif" ? -0.5 : -tSize * 0.022,
          }}
        >
          {slide.title}
        </div>
        {slide.body ? (
          <div
            style={{
              display: "flex",
              marginTop: 44,
              fontSize: bodySize(slide.body),
              lineHeight: 1.4,
              color: isCover ? p.muted : p.text,
              opacity: isCover ? 1 : 0.88,
            }}
          >
            {slide.body}
          </div>
        ) : null}
      </div>

      {/* Bottom: author, page number, swipe arrow */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 30,
          color: p.muted,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: p.text,
              color: p.bg,
              fontSize: 26,
              fontWeight: 800,
            }}
          >
            {initials}
          </div>
          <div style={{ display: "flex", fontWeight: 600, color: p.text }}>{author}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div style={{ display: "flex" }}>
            {index + 1}/{total}
          </div>
          {!isLast ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: p.accent,
                color: p.accentText,
                fontSize: 40,
                fontWeight: 800,
              }}
            >
              →
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export async function renderSlidePng(
  slides: Slide[],
  index: number,
  style: CarouselStyle,
  author: string,
): Promise<Buffer> {
  const image = new ImageResponse(
    (
      <SlideView
        slide={slides[index]}
        index={index}
        total={slides.length}
        author={author}
        theme={THEMES[style]}
      />
    ),
    { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fonts: await loadFonts() },
  );
  return Buffer.from(await image.arrayBuffer());
}

// Renders every slide and stitches them into one PDF. Returns the PDF and the cover PNG (for the preview).
export async function buildCarousel(
  slides: Slide[],
  style: CarouselStyle,
  author: string,
  title: string,
): Promise<{ pdf: Uint8Array; cover: Buffer }> {
  const pngs = await Promise.all(slides.map((_, i) => renderSlidePng(slides, i, style, author)));

  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor(author);
  for (const png of pngs) {
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([SLIDE_WIDTH, SLIDE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  }
  return { pdf: await pdf.save(), cover: pngs[0] };
}
