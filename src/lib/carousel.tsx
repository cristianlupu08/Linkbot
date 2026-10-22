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

// Who the visuals belong to. The photo is a data: URI (Satori can't fetch files itself).
export type Profile = { name: string; headline?: string; photo?: string };

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Avatar({ profile, size, p }: { profile: Profile; size: number; p: Palette }) {
  if (profile.photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={profile.photo}
        width={size}
        height={size}
        alt=""
        style={{ borderRadius: size / 2, objectFit: "cover", border: `${Math.round(size / 22)}px solid ${p.accent}` }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: p.text,
        color: p.bg,
        fontSize: Math.round(size * 0.4),
        fontWeight: 800,
      }}
    >
      {initialsOf(profile.name)}
    </div>
  );
}

function AuthorLine({ profile, p, size }: { profile: Profile; p: Palette; size: "small" | "large" }) {
  const large = size === "large";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: large ? 28 : 18 }}>
      <Avatar profile={profile} size={large ? 120 : 64} p={p} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontWeight: 600, color: p.text, fontSize: large ? 38 : 30 }}>
          {profile.name}
        </div>
        {profile.headline ? (
          <div style={{ display: "flex", color: p.muted, fontSize: large ? 28 : 22, marginTop: 4 }}>
            {profile.headline}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Title({ text, size, theme }: { text: string; size: number; theme: Theme }) {
  const serif = theme.titleFont === "Serif";
  return (
    <div
      style={{
        display: "flex",
        fontFamily: theme.titleFont,
        fontWeight: theme.titleWeight,
        fontSize: size,
        lineHeight: serif ? 1.08 : 1.12,
        letterSpacing: serif ? -0.5 : -size * 0.022,
      }}
    >
      {text}
    </div>
  );
}

type SlideProps = {
  slide: Slide;
  index: number;
  total: number;
  profile: Profile;
  theme: Theme;
};

function SlideView({ slide, index, total, profile, theme }: SlideProps) {
  const p = theme.palettes[index % theme.palettes.length];
  const isCover = index === 0;
  const isLast = index === total - 1;
  // With a photo, the cover and the closing slide show the person big: people follow people.
  const showBigAuthor = isLast && Boolean(profile.photo);

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
      {/* Top: photo on the cover, slide number on the others */}
      <div style={{ display: "flex", alignItems: "center" }}>
        {isCover && profile.photo ? (
          <Avatar profile={profile} size={200} p={p} />
        ) : isCover || isLast ? (
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
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
        <Title text={slide.title} size={titleSize(slide.title, isCover)} theme={theme} />
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
        {showBigAuthor ? (
          <div style={{ display: "flex", marginTop: 72 }}>
            <AuthorLine profile={profile} p={p} size="large" />
          </div>
        ) : null}
      </div>

      {/* Bottom: author, page number, swipe arrow */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: p.muted }}>
        {showBigAuthor ? <div style={{ display: "flex" }} /> : <AuthorLine profile={profile} p={p} size="small" />}
        <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 30 }}>
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

async function toPng(element: React.ReactElement): Promise<Buffer> {
  const image = new ImageResponse(element, {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    fonts: await loadFonts(),
  });
  return Buffer.from(await image.arrayBuffer());
}

export function renderSlidePng(slides: Slide[], index: number, style: CarouselStyle, profile: Profile) {
  return toPng(
    <SlideView slide={slides[index]} index={index} total={slides.length} profile={profile} theme={THEMES[style]} />,
  );
}

// Renders every slide and stitches them into one PDF. Returns the PDF and the cover PNG (for the preview).
export async function buildCarousel(
  slides: Slide[],
  style: CarouselStyle,
  profile: Profile,
  title: string,
): Promise<{ pdf: Uint8Array; cover: Buffer }> {
  const pngs = await Promise.all(slides.map((_, i) => renderSlidePng(slides, i, style, profile)));

  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor(profile.name);
  for (const png of pngs) {
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([SLIDE_WIDTH, SLIDE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  }
  return { pdf: await pdf.save(), cover: pngs[0] };
}

// ---------- Quote card: one image with the post's most quotable line ----------

function quoteSize(text: string) {
  const n = text.length;
  return n <= 50 ? 92 : n <= 90 ? 78 : n <= 140 ? 64 : 54;
}

function QuoteView({ quote, profile, theme }: { quote: string; profile: Profile; theme: Theme }) {
  const p = theme.palettes[0];
  return (
    <div
      style={{
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        display: "flex",
        flexDirection: "column",
        backgroundColor: p.bg,
        color: p.text,
        padding: "110px 92px 96px",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", fontFamily: "Serif", fontSize: 260, lineHeight: 0.8, color: p.accent }}>“</div>
      <div style={{ display: "flex", flexGrow: 1, alignItems: "center" }}>
        <Title text={quote} size={quoteSize(quote)} theme={theme} />
      </div>
      <div style={{ display: "flex", width: 120, height: 10, backgroundColor: p.accent, borderRadius: 5, marginBottom: 48 }} />
      <AuthorLine profile={profile} p={p} size="large" />
    </div>
  );
}

export function renderQuoteCard(quote: string, style: CarouselStyle, profile: Profile) {
  return toPng(<QuoteView quote={quote} profile={profile} theme={THEMES[style]} />);
}
