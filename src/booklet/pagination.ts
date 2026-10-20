import { getDimension, type BoxDims } from "../print/dimensions";

export interface TypeScale {
  fontSizePt: number;
  leadingPt: number;
  marginIn?: number;
  /** Space reserved for the editorial track title / folio treatment. */
  headerIn?: number;
}

export interface TrackLyrics {
  title: string;
  lyrics: string;
}

export type BookletPageKind = "cover" | "tracklist" | "lyrics" | "credits" | "art" | "thanks" | "back" | "blank";

export interface TextBlock {
  text: string;
  xIn: number;
  yIn: number;
  wIn: number;
  hIn: number;
  fontSizePt?: number;
  leadingPt?: number;
  columns?: 1 | 2;
}

export interface PaginatedPage {
  pageNumber: number;
  kind: BookletPageKind;
  title: string;
  trackTitle?: string;
  trackIndex?: number;
  part?: number;
  partCount?: number;
  blocks: TextBlock[];
  safetyBox: { wIn: number; hIn: number };
}

export interface PaginatedBooklet {
  componentId: string;
  pages: PaginatedPage[];
  safety: BoxDims;
}

export const DEFAULT_TYPE_SCALE: TypeScale = {
  fontSizePt: 8.25,
  leadingPt: 10.5,
  marginIn: 0.12,
  headerIn: 0.62
};

export function paginate(
  tracklist: string[],
  lyrics: Record<string, string> | TrackLyrics[],
  typeScale: TypeScale = DEFAULT_TYPE_SCALE,
  componentId = "CD1600R"
): PaginatedBooklet {
  const component = getDimension(componentId);
  const safety = component?.pageSafety ?? component?.safety;
  if (!component?.machineReadable || !safety) {
    throw new Error(`No page safety geometry for ${componentId}.`);
  }

  const lyricMap = Array.isArray(lyrics)
    ? new Map(lyrics.map((track) => [track.title, track.lyrics]))
    : new Map(Object.entries(lyrics));
  const pages: PaginatedPage[] = [];

  appendPage(pages, "cover", "Front cover", safety, [], typeScale);
  appendPage(pages, "tracklist", "Tracklist", safety, [tracklist.map((track, index) => `${index + 1}. ${track}`).join("\n")], typeScale);

  for (const [trackIndex, title] of tracklist.entries()) {
    const text = lyricMap.get(title) ?? "";
    // A track without lyrics gets no page of its own: the tracklist page already lists it.
    if (!text.trim()) continue;
    const lyricPages = fitLyricsToPages(text, safety, typeScale);
    for (const [part, blocks] of lyricPages.entries()) {
      pages.push({
        pageNumber: pages.length + 1,
        kind: "lyrics",
        title,
        trackTitle: title,
        trackIndex,
        part: part + 1,
        partCount: lyricPages.length,
        blocks,
        safetyBox: { wIn: safety.in.w, hIn: safety.in.h }
      });
    }
  }

  appendPage(pages, "credits", "Credits & thanks", safety, ["Album credits\n\nThanks and notes"], typeScale);
  const back = makePage(pages.length + 1, "back", "Back cover", safety, [], typeScale);
  while ((pages.length + 1) % 4 !== 0) {
    // Padding pages print as plain paper: no heading, no word on them.
    appendPage(pages, "blank", "", safety, [], typeScale);
  }
  back.pageNumber = pages.length + 1;
  pages.push(back);

  return { componentId: component.id, pages, safety };
}

export function textBlocksFitSafety(page: PaginatedPage): boolean {
  return page.blocks.every(
    (block) =>
      block.xIn >= 0 &&
      block.yIn >= 0 &&
      block.wIn <= page.safetyBox.wIn &&
      block.hIn <= page.safetyBox.hIn &&
      block.xIn + block.wIn <= page.safetyBox.wIn &&
      block.yIn + block.hIn <= page.safetyBox.hIn
  );
}

function appendPage(
  pages: PaginatedPage[],
  kind: BookletPageKind,
  title: string,
  safety: BoxDims,
  texts: string[],
  scale: TypeScale,
  trackTitle?: string,
  trackIndex?: number,
  part?: number,
  partCount?: number
) {
  pages.push(makePage(pages.length + 1, kind, title, safety, texts, scale, trackTitle, trackIndex, part, partCount));
}

function makePage(
  pageNumber: number,
  kind: BookletPageKind,
  title: string,
  safety: BoxDims,
  texts: string[],
  scale: TypeScale,
  trackTitle?: string,
  trackIndex?: number,
  part?: number,
  partCount?: number
): PaginatedPage {
  const margin = scale.marginIn ?? 0;
  const header = hasEditorialHeader(kind) ? (scale.headerIn ?? 0) : 0;
  const lineHeight = scale.leadingPt / 72;
  const blocks = texts.filter(Boolean).map((text) => {
    const lines = text.split(/\r?\n/);
    return {
      text,
      xIn: margin,
      yIn: margin + header,
      wIn: safety.in.w - margin * 2,
      hIn: Math.min(safety.in.h - margin * 2 - header, lines.length * lineHeight)
    };
  });

  return {
    pageNumber,
    kind,
    title,
    trackTitle,
    trackIndex,
    part,
    partCount,
    blocks,
    safetyBox: { wIn: safety.in.w, hIn: safety.in.h }
  };
}

function fitLyricsToPages(text: string, safety: BoxDims, preferred: TypeScale): TextBlock[][] {
  if (!text.trim()) return [[]];

  const preferredSingle = fitLyrics(text, safety, preferred, 1);
  if (preferredSingle) return [[preferredSingle]];

  const sizes = Array.from(
    new Set([preferred.fontSizePt, 7.75, 7.25, 6.75, 6.25, 5.75, 5.5].filter((size) => size <= preferred.fontSizePt))
  );
  for (const fontSizePt of sizes) {
    const scale = scaleAtSize(preferred, fontSizePt);
    const fitted = fitLyrics(text, safety, scale, 2);
    if (fitted) return [[fitted]];
  }

  // Rap and spoken-word providers commonly return one performed bar per hard
  // line. Printed booklets compact those bars into stanza paragraphs. Preserve
  // stanza boundaries and every word, but let the type flow naturally.
  const reflowed = reflowStanzas(text);
  for (const fontSizePt of sizes.filter((size) => size <= 6.75)) {
    const scale = compactScaleAtSize(preferred, fontSizePt);
    const fitted = fitLyrics(reflowed, safety, scale, 2);
    if (fitted) return [[fitted]];
  }

  // Exceptional spoken-word or transcript-length tracks may genuinely need a
  // continuation. Normal songs stay at exactly one page; no lyric text is lost.
  const scale = compactScaleAtSize(preferred, sizes.at(-1) ?? 5.5);
  const columns = 2 as const;
  const lines = wrapText(reflowed, safety, scale, columns);
  const chunks = chunkLines(lines, maxLinesPerPage(safety, scale, true) * columns);
  return chunks.map((chunk) => [lyricBlock(chunk, safety, scale, columns)]);
}

function fitLyrics(text: string, safety: BoxDims, scale: TypeScale, columns: 1 | 2): TextBlock | undefined {
  const lines = wrapText(text, safety, scale, columns);
  if (lines.length > maxLinesPerPage(safety, scale, true) * columns) return undefined;
  return lyricBlock(lines, safety, scale, columns);
}

function lyricBlock(lines: string[], safety: BoxDims, scale: TypeScale, columns: 1 | 2): TextBlock {
  const margin = scale.marginIn ?? 0;
  const header = scale.headerIn ?? 0;
  return {
    text: lines.join("\n"),
    xIn: margin,
    yIn: margin + header,
    wIn: safety.in.w - margin * 2,
    hIn: safety.in.h - margin * 2 - header,
    fontSizePt: scale.fontSizePt,
    leadingPt: scale.leadingPt,
    columns
  };
}

function scaleAtSize(preferred: TypeScale, fontSizePt: number): TypeScale {
  const leadingRatio = preferred.leadingPt / preferred.fontSizePt;
  return { ...preferred, fontSizePt, leadingPt: fontSizePt * leadingRatio };
}

function compactScaleAtSize(preferred: TypeScale, fontSizePt: number): TypeScale {
  return {
    ...preferred,
    fontSizePt,
    leadingPt: fontSizePt * 1.2,
    marginIn: Math.min(preferred.marginIn ?? 0.08, 0.08),
    headerIn: Math.min(preferred.headerIn ?? 0.52, 0.52)
  };
}

function reflowStanzas(text: string): string {
  return text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((stanza) => stanza.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

function wrapText(text: string, safety: BoxDims, scale: TypeScale, columns: 1 | 2 = 1): string[] {
  const margin = scale.marginIn ?? 0;
  const gutter = columns === 2 ? 0.16 : 0;
  const usableWidth = Math.max(0.5, (safety.in.w - margin * 2 - gutter) / columns);
  // Conservative Helvetica-like average. The PDF renderer verifies with real
  // font metrics and can tighten slightly without dropping the final line.
  const charWidth = (scale.fontSizePt / 72) * 0.58;
  const charsPerLine = Math.max(8, Math.floor(usableWidth / charWidth));
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words.flatMap((value) => splitLongWord(value, charsPerLine))) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > charsPerLine && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

function maxLinesPerPage(safety: BoxDims, scale: TypeScale, withHeader = false): number {
  const margin = scale.marginIn ?? 0;
  const header = withHeader ? (scale.headerIn ?? 0) : 0;
  return Math.max(1, Math.floor((safety.in.h - margin * 2 - header) / (scale.leadingPt / 72)));
}

function chunkLines(lines: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += size) {
    chunks.push(lines.slice(index, index + size));
  }
  return chunks.length ? chunks : [[]];
}

function splitLongWord(word: string, limit: number): string[] {
  if (word.length <= limit) return [word];
  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += limit) {
    chunks.push(word.slice(index, index + limit));
  }
  return chunks;
}

function hasEditorialHeader(kind: BookletPageKind): boolean {
  return kind === "tracklist" || kind === "lyrics" || kind === "credits" || kind === "thanks";
}
