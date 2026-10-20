import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { getDimension } from "../print/dimensions";
import { buildInRainbowsProof, expectedInRainbowsImpositionTable, IN_RAINBOWS_TRACKS } from "./inRainbows";

const originalMode = process.env.MXTP_MKR_IMAGEGEN;
describe("In Rainbows CD1600R proof", () => {
  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.MXTP_MKR_IMAGEGEN;
    } else {
      process.env.MXTP_MKR_IMAGEGEN = originalMode;
    }
  });

  it("paginates, imposes, folds, and exports the 16pp proof", async () => {
    process.env.MXTP_MKR_IMAGEGEN = "mock";
    const proof = await buildInRainbowsProof();
    const pageBleed = getDimension("CD1600R")!.pageBleed!.px300;
    const pdf = await PDFDocument.load(proof.pdf.bytes);
    const size = pdf.getPage(0).getSize();

    expect(proof.booklet.pages).toHaveLength(16);
    expect(proof.booklet.pages.filter((page) => page.kind === "lyrics").map((page) => page.trackTitle)).toEqual(
      IN_RAINBOWS_TRACKS
    );
    expect(proof.coverArt).toMatchObject({ mock: true, widthPx: pageBleed.w, heightPx: pageBleed.h });
    expect(proof.lyricsSpreadArt).toMatchObject({ mock: true, widthPx: pageBleed.w, heightPx: pageBleed.h });
    expect(proof.impositionTable).toEqual(expectedInRainbowsImpositionTable());
    expect(proof.readingOrder).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    expect(pdf.getPageCount()).toBe(8);
    expect(size.width).toBeCloseTo(792, 4);
    expect(size.height).toBeCloseTo(450, 4);

    expect(proof.pdf.bytes.length).toBeGreaterThan(0);
  });
});
