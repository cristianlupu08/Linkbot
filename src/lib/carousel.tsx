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

// Shows how far into the carousel you are; nicer than "3/8".
function ProgressBar({ index, total, p }: { index: number; total: number; p: Palette }) {
  const width = 180;
  return (
    <div style={{ display: "flex", width, height: 10, borderRadius: 5, backgroundColor: p.muted, opacity: 0.9 }}>
      <div
        style={{
          display: "flex",
          width: Math.round((width * (index + 1)) / total),
          height: 10,
          borderRadius: 5,
          backgroundColor: p.accent === p.bg ? p.text : p.accent,
        }}
      />
    </div>
  );
}

type SlideProps = {
  slide: Slide;
  index: number;
  total: number;
  profile: Profile;
  theme: Theme;
  // Tips carousels get a huge number on each tip slide.
  numbered: boolean;
  // A photo for this slide (data: URI), shown above the words.
  photo?: string;
};

const CONTENT_WIDTH = SLIDE_WIDTH - 92 * 2;

function SlidePhoto({ src, height }: { src: string; height: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={CONTENT_WIDTH} height={height} alt="" style={{ borderRadius: 28, objectFit: "cover" }} />
  );
}

function SlideView({ slide, index, total, profile, theme, numbered, photo }: SlideProps) {
  const p = theme.palettes[index % theme.palettes.length];
  const isCover = index === 0;
  const isLast = index === total - 1;
  // A slide photo takes the space the huge tip number would use.
  const bigNumber = numbered && !isCover && !isLast && !photo;
  // With a profile photo, the closing slide shows the person big: people follow people.
  const showBigAuthor = isLast && Boolean(profile.photo) && !photo;
  const titleSz = photo ? Math.min(titleSize(slide.title, isCover), isCover ? 80 : 64) : titleSize(slide.title, isCover);

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
        {isCover && profile.photo && !photo ? (
          <Avatar profile={profile} size={200} p={p} />
        ) : isCover || isLast || bigNumber ? (
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

      {photo ? (
        <div style={{ display: "flex", marginTop: 40 }}>
          <SlidePhoto src={photo} height={600} />
        </div>
      ) : null}

      {/* Middle: the words */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: photo ? "flex-start" : "center",
          marginTop: photo ? 44 : 0,
        }}
      >
        {bigNumber ? (
          <div
            style={{
              display: "flex",
              fontSize: 220,
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: -8,
              color: p.accent,
              marginBottom: 36,
            }}
          >
            {String(index).padStart(2, "0")}
          </div>
        ) : null}
        <Title text={slide.title} size={titleSz} theme={theme} />
        {slide.body ? (
          <div
            style={{
              display: "flex",
              marginTop: photo ? 24 : 44,
              fontSize: photo ? Math.min(bodySize(slide.body), 34) : bodySize(slide.body),
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
        <div style={{ display: "flex", alignItems: "center", gap: 26, fontSize: 30 }}>
          <ProgressBar index={index} total={total} p={p} />
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

export function renderSlidePng(
  slides: Slide[],
  index: number,
  style: CarouselStyle,
  profile: Profile,
  numbered = false,
  photo?: string,
) {
  return toPng(
    <SlideView
      slide={slides[index]}
      index={index}
      total={slides.length}
      profile={profile}
      theme={THEMES[style]}
      numbered={numbered}
      photo={photo}
    />,
  );
}

// Which slides get the photos: the first on the cover, the rest spread over the middle slides.
export function photoSlots(slideCount: number, photoCount: number): number[] {
  if (photoCount <= 0) return [];
  const middle = Array.from({ length: Math.max(0, slideCount - 2) }, (_, i) => i + 1);
  const rest = photoCount - 1;
  const picked = Array.from({ length: Math.min(rest, middle.length) }, (_, i) =>
    middle[Math.floor(((i + 0.5) * middle.length) / Math.min(rest, middle.length))],
  );
  return [0, ...picked];
}

// Renders every slide and stitches them into one PDF. Returns the PDF and the cover PNG (for the preview).
export async function buildCarousel(
  slides: Slide[],
  style: CarouselStyle,
  profile: Profile,
  title: string,
  numbered = false,
  // Photos as data: URIs, placed on the cover and spread over the middle slides.
  photos: string[] = [],
): Promise<{ pdf: Uint8Array; cover: Buffer }> {
  const slots = photoSlots(slides.length, photos.length);
  const photoFor = (i: number) => {
    const at = slots.indexOf(i);
    return at === -1 ? undefined : photos[at];
  };
  const pngs = await Promise.all(
    slides.map((_, i) => renderSlidePng(slides, i, style, profile, numbered, photoFor(i))),
  );

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

// ---------- LinkedIn profile banner (1584 × 396) ----------

export const BANNER_WIDTH = 1584;
export const BANNER_HEIGHT = 396;

function bannerSize(text: string) {
  const n = text.length;
  return n <= 30 ? 76 : n <= 55 ? 64 : n <= 80 ? 54 : 46;
}

function BannerView({ tagline, profile, theme }: { tagline: string; profile: Profile; theme: Theme }) {
  const p = theme.palettes[0];
  const size = bannerSize(tagline);
  return (
    <div
      style={{
        width: BANNER_WIDTH,
        height: BANNER_HEIGHT,
        display: "flex",
        backgroundColor: p.bg,
        color: p.text,
        fontFamily: "Inter",
        position: "relative",
      }}
    >
      {/* Decoration in the corners; the bottom-left stays clear because the profile photo covers it. */}
      <div style={{ position: "absolute", right: 0, top: 0, width: 28, height: BANNER_HEIGHT, backgroundColor: p.accent }} />
      <div style={{ position: "absolute", left: 80, top: 70, width: 120, height: 12, borderRadius: 6, backgroundColor: p.accent }} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          marginLeft: 560,
          marginRight: 140,
          flexGrow: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: theme.titleFont,
            fontWeight: theme.titleWeight,
            fontSize: size,
            lineHeight: 1.1,
            letterSpacing: theme.titleFont === "Serif" ? -0.5 : -size * 0.02,
          }}
        >
          {tagline}
        </div>
        <div style={{ display: "flex", marginTop: 26, fontSize: 26, color: p.muted }}>
          {[profile.name, profile.headline].filter(Boolean).join("  ·  ")}
        </div>
      </div>
    </div>
  );
}

export async function renderBanner(tagline: string, style: CarouselStyle, profile: Profile): Promise<Buffer> {
  const image = new ImageResponse(<BannerView tagline={tagline} profile={profile} theme={THEMES[style]} />, {
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
    fonts: await loadFonts(),
  });
  return Buffer.from(await image.arrayBuffer());
}

// ---------- Feed preview: how the post will look on LinkedIn (mobile) ----------

const FEED_WIDTH = 1080;
const FEED_PAD = 40;
const FEED_FONT = 32;
// Roughly how many characters fit on one line of post text at this size, to cut where LinkedIn does.
const CHARS_PER_LINE = 56;
const VISIBLE_LINES = 3;

// The text LinkedIn shows before "…more": about 3 lines on mobile, counting blank lines.
export function feedVisibleText(text: string): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let rows = 0;
  for (const paragraph of text.split("\n")) {
    const need = Math.max(1, Math.ceil(paragraph.length / CHARS_PER_LINE));
    if (rows + need <= VISIBLE_LINES) {
      out.push(paragraph);
      rows += need;
      continue;
    }
    const room = (VISIBLE_LINES - rows) * CHARS_PER_LINE - 8;
    if (room > 10) {
      const cut = paragraph.slice(0, room);
      out.push(cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)));
    }
    return { lines: out, truncated: true };
  }
  return { lines: out, truncated: false };
}

export type FeedMedia = { src: string; width: number; height: number; documentTitle?: string; pages?: number };

function FeedPreviewView({ profile, text, media }: { profile: Profile; text: string; media?: FeedMedia }) {
  const { lines, truncated } = feedVisibleText(text);
  const gray = "#666666";
  const avatarSize = 100;
  const mediaHeight = media ? Math.round((FEED_WIDTH * media.height) / media.width) : 0;
  return (
    <div style={{ width: FEED_WIDTH, height: "100%", display: "flex", flexDirection: "column", backgroundColor: "#FFFFFF", fontFamily: "Inter", color: "#191919" }}>
      {/* Author */}
      <div style={{ display: "flex", alignItems: "center", padding: `${FEED_PAD}px ${FEED_PAD}px 24px`, gap: 22 }}>
        {profile.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={profile.photo} width={avatarSize} height={avatarSize} alt="" style={{ borderRadius: avatarSize / 2, objectFit: "cover" }} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2, backgroundColor: "#D9D9D9", fontSize: 38, fontWeight: 600, color: "#555" }}>
            {initialsOf(profile.name)}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 600 }}>{profile.name}</div>
          {profile.headline ? <div style={{ display: "flex", fontSize: 26, color: gray, marginTop: 2 }}>{profile.headline}</div> : null}
          <div style={{ display: "flex", fontSize: 24, color: gray, marginTop: 2 }}>Now</div>
        </div>
      </div>

      {/* Text, cut where LinkedIn cuts it */}
      <div style={{ display: "flex", flexDirection: "column", padding: `0 ${FEED_PAD}px 28px`, fontSize: FEED_FONT, lineHeight: 1.4 }}>
        {lines.map((line, i) => {
          const last = i === lines.length - 1;
          if (!line.trim()) return <div key={i} style={{ display: "flex", height: FEED_FONT * 1.4 }} />;
          return (
            <div key={i} style={{ display: "flex", flexWrap: "wrap" }}>
              {line.split(" ").map((word, j) => (
                <span key={j} style={{ marginRight: 9 }}>
                  {word}
                </span>
              ))}
              {last && truncated ? <span style={{ color: gray }}>…more</span> : null}
            </div>
          );
        })}
      </div>

      {/* Visual */}
      {media ? (
        <div style={{ display: "flex", position: "relative", width: FEED_WIDTH, height: mediaHeight }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.src} width={FEED_WIDTH} height={mediaHeight} alt="" style={{ objectFit: "cover" }} />
          {media.documentTitle ? (
            <div style={{ position: "absolute", top: 0, left: 0, width: FEED_WIDTH, display: "flex", padding: "18px 28px", backgroundColor: "rgba(0,0,0,0.6)", color: "#FFFFFF", fontSize: 26 }}>
              {`${media.documentTitle.slice(0, 60)} · ${media.pages ?? 1} pages`}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "space-around", borderTop: "2px solid #E8E8E8", margin: `${media ? 0 : 8}px ${FEED_PAD}px 0`, padding: "26px 0 30px", fontSize: 26, fontWeight: 600, color: gray }}>
        <div style={{ display: "flex" }}>Like</div>
        <div style={{ display: "flex" }}>Comment</div>
        <div style={{ display: "flex" }}>Repost</div>
        <div style={{ display: "flex" }}>Send</div>
      </div>
    </div>
  );
}

export async function renderFeedPreview(profile: Profile, text: string, media?: FeedMedia): Promise<Buffer> {
  const { lines } = feedVisibleText(text);
  const textRows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
  const mediaHeight = media ? Math.round((FEED_WIDTH * media.height) / media.width) : 0;
  // Header, text rows, visual and the action bar; any rounding slack stays white.
  const height = FEED_PAD + 100 + 24 + textRows * Math.round(FEED_FONT * 1.4) + 28 + mediaHeight + 100;
  const image = new ImageResponse(<FeedPreviewView profile={profile} text={text} media={media} />, {
    width: FEED_WIDTH,
    height,
    fonts: await loadFonts(),
  });
  return Buffer.from(await image.arrayBuffer());
}
