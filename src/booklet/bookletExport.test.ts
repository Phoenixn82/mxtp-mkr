import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDimension } from "../print/dimensions";
import {
  buildBookletPdf,
  composeBookletPages,
  matchLyricsToTracks,
  PRINTABLE_BOOKLET_PAGE_COUNTS,
  recommendedBookletPageCount
} from "./bookletExport";

/** A minimal valid 1x1 opaque PNG (RGBA), enough for pdf.embedPng. */
function tinyPng(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
}

describe("buildBookletPdf", () => {
  it("maps album data into a CD1600R booklet PDF with the cover art embedded", async () => {
    const bytes = await buildBookletPdf({
      componentId: "CD1600R",
      coverImage: tinyPng(),
      tracks: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }],
      lyricsByTrack: [
        { title: "Alpha", lyrics: "alpha line one\nalpha line two" },
        { title: "Beta", lyrics: "beta line one" },
        { title: "Gamma", lyrics: "gamma line one\ngamma line two" }
      ],
      credits: "Produced by MXTP"
    });

    const component = getDimension("CD1600R")!;
    const pages = component.pages!; // 16

    const pdf = await PDFDocument.load(bytes);
    // One PDF page per printed face = pages / 2 (2-up saddle stitch).
    expect(pdf.getPageCount()).toBe(pages / 2);

    // The cover (reader page 1) rides face 0; it must carry an image XObject.
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain("/Subtype /Image");
  });

  it("pads to the component page count even with no lyrics or cover", async () => {
    const bytes = await buildBookletPdf({
      componentId: "CD1600R",
      tracks: [{ title: "Only Track" }]
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(getDimension("CD1600R")!.pages! / 2);
  });
});

describe("composeBookletPages", () => {
  it("exposes the reader pages the preview renders: per-track lyric pages with real geometry", () => {
    const composed = composeBookletPages({
      componentId: "CD1600R",
      tracks: [{ title: "Alpha" }, { title: "Beta" }],
      lyricsByTrack: [
        { title: "Alpha", lyrics: "alpha line one\nalpha line two" },
        { title: "Beta", lyrics: "beta line one" }
      ],
      credits: "Produced by MXTP",
      design: { artist: "Test Artist", album: "Test Album", tags: ["alternative"] }
    });

    expect(composed.pageCount).toBe(16);
    expect(composed.pages).toHaveLength(16);
    expect(composed.pages[0]).toMatchObject({ title: "Test Album", subtitle: "Test Artist", kind: "cover" });
    expect(composed.pages[1].title).toBe("Tracklist");
    expect(composed.pages.map((page) => page.title)).toEqual(
      expect.arrayContaining(["Alpha", "Beta", "Credits & thanks", "Test Album"])
    );
    expect(composed.pages[composed.pages.length - 1]).toMatchObject({
      title: "Test Album",
      subtitle: "Test Artist",
      kind: "back"
    });
    // Text blocks carry pagination geometry inside the safety box.
    const alpha = composed.pages.find((page) => page.title === "Alpha")!;
    expect(alpha.blocks![0].text).toContain("alpha line one");
    expect(alpha.blocks![0].wIn).toBeGreaterThan(0);
    expect(composed.safety.wIn).toBeCloseTo(4.5, 1);
    expect(composed.pages.every((page) => page.visual?.designId === "signal-collage")).toBe(true);
  });

  it("renders a dense twelve-track album in sixteen pages without dropping the last lyric", async () => {
    const tracks = Array.from({ length: 12 }, (_, index) => ({ title: `Song ${index + 1}` }));
    const lyricsByTrack = tracks.map(({ title }) => ({
      title,
      lyrics: Array.from({ length: 70 }, (_, index) =>
        index === 69 ? `${title} FINAL-LYRIC-MARKER` : `${title} lyric line ${index + 1} keeps moving`
      ).join("\n")
    }));
    const composed = composeBookletPages({ componentId: "CD1600R", tracks, lyricsByTrack });

    expect(composed.contentPageCount).toBe(16);
    expect(composed.pages.filter((page) => page.kind === "lyrics")).toHaveLength(12);

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    await buildBookletPdf({ componentId: "CD1600R", tracks, lyricsByTrack });
    expect(drawTextSpy.mock.calls.map((call) => String(call[0])).join(" ")).toContain("FINAL-LYRIC-MARKER");
  });

  it.each([
    ["CD800R", 8],
    ["CD1200R", 12],
    ["CD1600R", 16],
    ["CD2000R", 20],
    ["CD2400R", 24]
  ])("honors the real %s Disc Makers page count", (componentId, pageCount) => {
    const composed = composeBookletPages({ componentId, tracks: [] });
    expect(composed.pageCount).toBe(pageCount);
    expect(composed.pages).toHaveLength(pageCount);
    expect(composed.pages.at(-1)?.kind).toBe("back");
  });

  it("fails loudly when lyrics overflow instead of silently dropping pages", () => {
    const lyrics = Array.from({ length: 2000 }, (_, index) => `lyric line ${index + 1}`).join("\n");
    expect(() =>
      composeBookletPages({
        componentId: "CD800R",
        tracks: [{ title: "Long Song" }],
        lyricsByTrack: [{ title: "Long Song", lyrics }]
      })
    ).toThrow(/^Your lyrics need \d+ pages; this booklet has 8\. Choose (12|16|20|24) pages\.$/);
  });

  it("counts only the pages the content fills, not spare padding, when it does not fit", () => {
    // Cover, tracklist, five one-page lyrics, credits and back: 9 pages, padded to 12.
    const titles = ["One", "Two", "Three", "Four", "Five"];
    expect(() =>
      composeBookletPages({
        componentId: "CD800R",
        tracks: titles.map((title) => ({ title })),
        lyricsByTrack: titles.map((title) => ({ title, lyrics: `${title} line` }))
      })
    ).toThrow(/^Your lyrics need 9 pages; this booklet has 8\. Choose 12 pages\.$/);
  });

  it("keeps lyrics for decorated audio titles ('Artist - Song (Official Audio)')", () => {
    const composed = composeBookletPages({
      componentId: "CD1600R",
      tracks: [
        { title: "Signal Theory - Opening Hum (Official Audio)" },
        { title: "Signal Theory - Paper Moon Drive (Official Music Video)" },
        { title: "Quiet Index" }
      ],
      lyricsByTrack: [
        { title: "Opening Hum", lyrics: "First line of the hum" },
        { title: "Paper Moon Drive", lyrics: "Paper moon over the drive" }
      ],
      design: { artist: "Signal Theory", album: "Paper Tones" }
    });
    const lyricPages = composed.pages.filter((page) => page.kind === "lyrics");
    expect(lyricPages.map((page) => page.title)).toEqual([
      "Signal Theory - Opening Hum (Official Audio)",
      "Signal Theory - Paper Moon Drive (Official Music Video)"
    ]);
    expect(lyricPages[0].blocks![0].text).toContain("First line of the hum");
    expect(lyricPages[1].blocks![0].text).toContain("Paper moon over the drive");
  });

  it("matches lyrics by album position when no title matches and the counts agree", () => {
    const lyrics = matchLyricsToTracks(
      ["Track 01", "Track 02"],
      [
        { title: "Ichi", lyrics: "first" },
        { title: "Ni", lyrics: "second" }
      ]
    );
    expect([...lyrics.entries()]).toEqual([
      ["Track 01", "first"],
      ["Track 02", "second"]
    ]);
    expect(matchLyricsToTracks(["Track 01"], [{ title: "Ichi", lyrics: "x" }, { title: "Ni", lyrics: "y" }]).size).toBe(0);
  });

  it("washes every padded art plate with the cover, as the preview shows it", () => {
    const cover = tinyPng();
    const composed = composeBookletPages({
      componentId: "CD1600R",
      coverImage: cover,
      tracks: [{ title: "Only Track" }],
      lyricsByTrack: [{ title: "Only Track", lyrics: "one line" }]
    });
    const artPlates = composed.pages.filter((page) => page.kind === "art");
    expect(artPlates.length).toBeGreaterThan(0);
    for (const plate of artPlates) expect(plate.backgroundImageBytes).toBe(cover);
    // Spare pages stay plain paper.
    for (const spare of composed.pages.filter((page) => page.kind === "blank")) {
      expect(spare.backgroundImageBytes).toBeUndefined();
    }
  });

  it("recommends only printable saddle-stitch counts", () => {
    expect(PRINTABLE_BOOKLET_PAGE_COUNTS).toEqual([8, 12, 16, 20, 24]);
    expect(recommendedBookletPageCount(7)).toBe(8);
    expect(recommendedBookletPageCount(17)).toBe(20);
    expect(recommendedBookletPageCount(25)).toBeUndefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
