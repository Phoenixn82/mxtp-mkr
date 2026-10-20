import { normalizeTrackTitle } from "../library/appleMusic";
import { getDimension } from "../print/dimensions";
import { type BookletPdfPage, renderBookletPdf } from "../print/bookletPdf";
import { deriveBookletDesign, type BookletDesign, type BookletDesignInput, visualForPage } from "./design";
import { type PaginatedPage, paginate } from "./pagination";

export const PRINTABLE_BOOKLET_PAGE_COUNTS = [8, 12, 16, 20, 24] as const;

export interface BuildBookletInput {
  /** Disc Makers booklet component id, e.g. "CD1600R". */
  componentId: string;
  /** Full-bleed front-cover artwork (PNG or JPEG bytes). */
  coverImage?: Uint8Array;
  tracks: { title: string }[];
  lyricsByTrack?: { title: string; lyrics: string }[];
  credits?: string;
  design?: BookletDesignInput;
}

export interface ComposedBooklet {
  componentId: string;
  pageCount: number;
  pages: BookletPdfPage[];
  design: BookletDesign;
  /** Number of reader pages required before padding to the selected component. */
  contentPageCount: number;
  /** Page safety box (inches) — the coordinate space of every text block. */
  safety: { wIn: number; hIn: number };
}

/**
 * Pure mapping from album data to reader-order booklet pages.
 *
 * Composes cover -> tracklist -> per-track lyrics -> credits -> back, pads to
 * the component's page count (a multiple of 4), and maps each reader page to a
 * {@link BookletPdfPage} (image for art pages, text blocks for text pages).
 * Shared by the PDF render path and the in-app booklet preview.
 */
export function composeBookletPages(input: BuildBookletInput): ComposedBooklet {
  const component = getDimension(input.componentId);
  if (!component?.machineReadable || component.kind !== "saddle-booklet") {
    throw new Error(`${input.componentId} is not a machine-readable saddle booklet.`);
  }

  const trackTitles = input.tracks.map((track) => track.title);
  const lyricMap = matchLyricsToTracks(trackTitles, input.lyricsByTrack ?? [], input.design?.artist);

  // Reuse pagination's lyric wrapping/chunking: paginate the full album, then
  // pull out the per-track lyric pages (already wrapped + fitted to safety).
  const paginated = paginate(
    trackTitles,
    Object.fromEntries(trackTitles.map((title) => [title, lyricMap.get(title) ?? ""])),
    undefined,
    input.componentId
  );
  const design = deriveBookletDesign(input.design);
  const wash = input.coverImage && input.coverImage.length ? input.coverImage : undefined;
  const sourcePages = paginated.pages.map((page) => mapPage(page, input, wash, design));

  const pageCount = component.pages ?? padToFour(sourcePages.length);
  const contentPageCount = sourcePages.length;
  if (contentPageCount > pageCount) {
    // Name the pages the content really fills; spare padding pages are not a need.
    const needed = sourcePages.filter((page) => page.kind !== "blank").length;
    const recommended = recommendedBookletPageCount(contentPageCount);
    // Keep "Choose N pages." verbatim: the studio turns it into a one-click fix.
    throw new Error(
      `Your lyrics need ${needed} pages; this booklet has ${pageCount}. ` +
        (recommended
          ? `Choose ${recommended} pages.`
          : "That is more than a 24-page booklet holds. Remove some lyrics or split the release into two booklets.")
    );
  }

  const back = sourcePages.pop() ?? { pageNumber: 0, title: "Back cover", kind: "back" as const };
  const pages = sourcePages;
  // Reserve the last slot for the back cover; add intentional art pages before
  // blank pages so a larger selected booklet still has visual rhythm.
  while (pages.length < pageCount - 1) {
    const remaining = pageCount - 1 - pages.length;
    pages.push({
      pageNumber: 0,
      title: remaining <= 2 ? "Art plate" : "",
      kind: remaining <= 2 ? "art" : "blank",
      // Art plates carry the cover wash, matching mapPage and the preview.
      backgroundImageBytes: remaining <= 2 ? wash : undefined
    });
  }
  pages.push(back);

  // Assign final sequential page numbers (reader order).
  pages.forEach((page, index) => {
    page.pageNumber = index + 1;
    page.visual = visualForPage(design, page.kind ?? "blank", page.pageNumber, page.trackIndex ?? 0);
  });

  const pageSafety = component.pageSafety ?? component.safety;
  return {
    componentId: component.id,
    pageCount,
    pages,
    design,
    contentPageCount,
    safety: { wIn: pageSafety?.in.w ?? 4.5, hIn: pageSafety?.in.h ?? 4.5 }
  };
}

/** Album data -> imposed booklet PDF bytes (compose, then render). */
export async function buildBookletPdf(input: BuildBookletInput): Promise<Uint8Array> {
  const composed = composeBookletPages(input);
  const result = await renderBookletPdf({
    componentId: composed.componentId,
    pageCount: composed.pageCount,
    pages: composed.pages
  });
  return result.bytes;
}

/**
 * Lyrics are researched under MusicBrainz titles, while the booklet lists the
 * audio's own titles ("Artist - Song (Official Audio)", "Song - Remastered").
 * Match on a normalized key on both sides, and fall back to album position when
 * the counts agree but no name matches at all.
 */
export function matchLyricsToTracks(
  trackTitles: string[],
  lyricsByTrack: { title: string; lyrics: string }[],
  artist?: string
): Map<string, string> {
  const byKey = new Map(lyricsByTrack.map((entry) => [lyricKey(entry.title, artist), entry.lyrics]));
  const matched = new Map<string, string>();
  for (const title of trackTitles) {
    const lyrics = byKey.get(lyricKey(title, artist));
    if (lyrics !== undefined) matched.set(title, lyrics);
  }
  if (matched.size === 0 && trackTitles.length > 0 && trackTitles.length === lyricsByTrack.length) {
    trackTitles.forEach((title, index) => matched.set(title, lyricsByTrack[index].lyrics));
  }
  return matched;
}

function lyricKey(title: string, artist?: string): string {
  let value = title.trim();
  const name = artist?.trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`^${escaped}\\s*[-\u2013\u2014]\\s*`, "i"), "");
  }
  value = value.replace(/\s*[([]official\b[^)\]]*\b(?:video|audio)[)\]]\s*$/i, "");
  // normalizeTrackTitle can reduce a title in a script it does not index to "": keep it distinct.
  return normalizeTrackTitle(value) || value.toLowerCase();
}

export function recommendedBookletPageCount(requiredPages: number): number | undefined {
  return PRINTABLE_BOOKLET_PAGE_COUNTS.find((count) => count >= requiredPages);
}

function padToFour(n: number): number {
  return n % 4 === 0 ? n : n + (4 - (n % 4));
}

function mapPage(
  page: PaginatedPage,
  input: BuildBookletInput,
  wash: Uint8Array | undefined,
  design: BookletDesign
): BookletPdfPage {
  const isCover = page.kind === "cover";
  const isBack = page.kind === "back";
  const isText = page.blocks.length > 0;
  const blocks =
    page.kind === "credits" && page.blocks.length
      ? [{ ...page.blocks[0], text: input.credits ?? `${design.artist} / ${design.album}` }]
      : page.blocks;
  return {
    pageNumber: 0,
    title: isCover || isBack ? design.album : page.title,
    subtitle: isCover || isBack ? design.artist : undefined,
    kind: page.kind,
    trackIndex: page.trackIndex,
    part: page.part,
    partCount: page.partCount,
    imageBytes: isCover ? input.coverImage : undefined,
    backgroundImageBytes: !isCover && (isText || page.kind === "art") ? wash : undefined,
    blocks
  };
}
