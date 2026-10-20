import { describe, expect, it } from "vitest";
import { paginate, textBlocksFitSafety } from "./pagination";

describe("lyrics pagination", () => {
  it("keeps album order, pads to a multiple of four, and fits every text block in safety", () => {
    const tracklist = ["Alpha", "Beta", "Gamma"];
    const lyrics = {
      Alpha: Array.from({ length: 80 }, (_, index) => `alpha line ${index + 1}`).join("\n"),
      Beta: "beta first line\nbeta second line",
      Gamma: "gamma first line\ngamma second line"
    };

    const booklet = paginate(tracklist, lyrics, { fontSizePt: 8, leadingPt: 10, marginIn: 0.08 });

    expect(booklet.pages.length % 4).toBe(0);
    expect(booklet.pages[0]).toMatchObject({ pageNumber: 1, kind: "cover" });
    expect(booklet.pages[1]).toMatchObject({ pageNumber: 2, kind: "tracklist" });
    expect(booklet.pages.at(-1)).toMatchObject({ kind: "back" });
    const lyricPages = booklet.pages.filter((page) => page.kind === "lyrics");
    const firstBeta = lyricPages.findIndex((page) => page.trackTitle === "Beta");
    const firstGamma = lyricPages.findIndex((page) => page.trackTitle === "Gamma");
    expect(lyricPages.slice(0, firstBeta).every((page) => page.trackTitle === "Alpha")).toBe(true);
    expect(firstBeta).toBeGreaterThan(0);
    expect(firstGamma).toBeGreaterThan(firstBeta);
    expect(lyricPages.filter((page) => page.trackTitle === "Alpha").map((page) => page.part)).toEqual(
      Array.from({ length: firstBeta }, (_, index) => index + 1)
    );
    expect(lyricPages.filter((page) => page.trackTitle === "Alpha").every((page) => page.partCount === firstBeta)).toBe(
      true
    );
    expect(lyricPages.flatMap((page) => page.blocks).map((block) => block.text).join("\n")).toContain("alpha line 80");
    expect(booklet.pages.every(textBlocksFitSafety)).toBe(true);
  });

  it("fits a twelve-song album at one lyric page per song", () => {
    const tracklist = Array.from({ length: 12 }, (_, index) => `Track ${index + 1}`);
    const lyrics = Object.fromEntries(
      tracklist.map((title) => [
        title,
        Array.from({ length: 70 }, (_, index) => `${title} lyric line ${index + 1} keeps moving all night long`).join("\n")
      ])
    );

    const booklet = paginate(tracklist, lyrics);
    const lyricPages = booklet.pages.filter((page) => page.kind === "lyrics");

    expect(booklet.pages).toHaveLength(16);
    expect(lyricPages).toHaveLength(12);
    expect(lyricPages.map((page) => page.trackTitle)).toEqual(tracklist);
    expect(lyricPages.every((page) => page.part === 1 && page.partCount === 1)).toBe(true);
    expect(lyricPages.every((page) => page.blocks[0]?.columns === 2)).toBe(true);
    expect(lyricPages.every((page) => (page.blocks[0]?.fontSizePt ?? 0) >= 5.5)).toBe(true);
    expect(lyricPages.at(-1)?.blocks[0].text.replace(/\s+/g, " ")).toContain("Track 12 lyric line 70");
    expect(booklet.pages.every(textBlocksFitSafety)).toBe(true);
  });

  it("splits unbroken words without losing characters and reserves the editorial header", () => {
    const unbroken = "SUPERCALIFRAGILISTIC".repeat(18);
    const booklet = paginate(["Signal"], { Signal: unbroken });
    const lyricPages = booklet.pages.filter((page) => page.kind === "lyrics");
    const recovered = lyricPages.flatMap((page) => page.blocks).map((block) => block.text.replace(/\s/g, "")).join("");

    expect(recovered).toBe(unbroken);
    expect(lyricPages.every((page) => page.blocks.every((block) => block.yIn >= 0.62))).toBe(true);
    expect(lyricPages.every(textBlocksFitSafety)).toBe(true);
  });

  it("rejects components without trustworthy booklet safety geometry", () => {
    expect(() => paginate([], {}, undefined, "missing-template")).toThrow("No page safety geometry");
  });

  it("gives tracks without lyrics no page of their own: 22 tracks fit in an 8-page booklet", () => {
    const tracklist = Array.from({ length: 22 }, (_, index) => `Track ${index + 1}`);
    const booklet = paginate(tracklist, {}, undefined, "CD800R");

    expect(booklet.pages.filter((page) => page.kind === "lyrics")).toHaveLength(0);
    // Cover, tracklist, credits, back: the export pads this to the chosen 8 pages.
    expect(booklet.pages).toHaveLength(4);
    const listed = booklet.pages.find((page) => page.kind === "tracklist")!.blocks[0].text;
    expect(listed).toContain("1. Track 1");
    expect(listed).toContain("22. Track 22");
  });

  it("pads with untitled spare pages", () => {
    const booklet = paginate(["Only"], { Only: "one line" });
    const spare = booklet.pages.filter((page) => page.kind === "blank");
    expect(spare.length).toBeGreaterThan(0);
    expect(spare.every((page) => page.title === "")).toBe(true);
  });
});
