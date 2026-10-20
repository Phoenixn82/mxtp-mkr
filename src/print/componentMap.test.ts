import { describe, expect, it } from "vitest";
import { insertSpecs } from "../geometry";
import type { BoxDims } from "./dimensions";
import {
  bookletPageOptions,
  componentForInsertSpec,
  componentIdForInsertSpec,
  formatIn,
  formatMm,
  guideBoxOnMedia,
  guideStyle,
  impositionPreviewRows,
  nearestSaddlePageCount,
  printSizeText,
  printTarget,
  suggestBookletPageCount
} from "./componentMap";

const box = (w: number, h: number, left?: number, top?: number): BoxDims => ({
  in: { w, h },
  mm: { w: w * 25.4, h: h * 25.4 },
  px300: { w: Math.round(w * 300), h: Math.round(h * 300) },
  ...(left === undefined || top === undefined
    ? {}
    : { insets: { left, top, right: null, bottom: null } })
});

describe("print component mapping", () => {
  it("maps every supported jewel insert and leaves unavailable templates honest", () => {
    const ids = Object.fromEntries(insertSpecs().map((spec) => [spec.id, componentIdForInsertSpec(spec)]));
    expect(ids).toEqual({
      front: "CD100",
      bifold: "CD400",
      trifold: "CD600",
      "folder-8": "CD800P",
      "saddle-4": undefined,
      "saddle-8": "CD800R",
      "saddle-12": "CD1200R",
      "saddle-16": "CD1600R",
      "saddle-20": "CD2000R",
      "saddle-24": "CD2400R",
      "saddle-28": undefined,
      tray: "CDT100",
      disc: "UD100"
    });

    expect(componentForInsertSpec(insertSpecs().find((spec) => spec.id === "front")!)?.id).toBe("CD100_in");
    expect(componentForInsertSpec(insertSpecs().find((spec) => spec.id === "saddle-4")!)).toBeUndefined();
  });

  it("positions guides from source insets or centers them when insets are absent", () => {
    const media = box(10, 8);
    expect(guideBoxOnMedia(media, box(4, 2, 1.25, 2.5))).toEqual({ x: 1.25, y: 2.5, w: 4, h: 2 });
    expect(guideBoxOnMedia(media, box(4, 2))).toEqual({ x: 3, y: 3, w: 4, h: 2 });
    expect(guideStyle(media, { x: 1, y: 2, w: 5, h: 4 })).toEqual({
      left: "10%",
      top: "25%",
      width: "50%",
      height: "50%"
    });
  });

  it("selects bounded saddle page counts from lyric density and fallbacks", () => {
    expect(suggestBookletPageCount("", 10)).toBe(12);
    expect(suggestBookletPageCount("one lyric line")).toBe(8);
    expect(suggestBookletPageCount(Array.from({ length: 113 }, (_, index) => `line ${index}`).join("\n"))).toBe(12);
    expect(suggestBookletPageCount(Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n"))).toBe(24);
    expect(nearestSaddlePageCount(-4)).toBe(4);
    expect(nearestSaddlePageCount(25)).toBe(24);
    expect(bookletPageOptions(10)).toEqual([4, 8, 10, 12, 16, 20, 24]);
    expect(bookletPageOptions(16)).toEqual([4, 8, 12, 16, 20, 24]);
  });

  it("delegates valid imposition and preserves invalid-page errors", () => {
    expect(impositionPreviewRows(4)).toEqual([
      { sheet: 0, face: "outer", left: 4, right: 1 },
      { sheet: 0, face: "inner", left: 2, right: 3 }
    ]);
    expect(() => impositionPreviewRows(6)).toThrow("Saddle-stitch page counts must be a multiple of 4.");
  });

  it("formats print measurements without redundant trailing zeros", () => {
    expect(formatIn(4)).toBe("4 in");
    expect(formatIn(4.5)).toBe("4.5 in");
    expect(formatMm(120.006)).toBe("120.01 mm");
  });

  it("gives one print target per piece: template size first, app geometry when there is none", () => {
    const spec = (id: string) => insertSpecs().find((item) => item.id === id)!;
    const tray = printTarget(spec("tray"));
    const template = componentForInsertSpec(spec("tray"))!.bleed!.px300;
    expect(tray.px.w).toBeGreaterThanOrEqual(template.w);
    expect(tray.px.w).toBeGreaterThan(1600);
    // Never below what GO enforces on the app bleed box (126.35 mm = 1493 px).
    expect(tray.px.h).toBeGreaterThanOrEqual(1469);
    const disc = printTarget(spec("disc")).px;
    expect(disc.w).toBeGreaterThanOrEqual(1493);
    expect(disc.h).toBeGreaterThanOrEqual(1493);

    // saddle-28 has no template: fall back to the 240 x 120 mm spread plus 3.175 mm bleed.
    const fallback = printTarget(spec("saddle-28"));
    expect(fallback.px).toEqual({ w: Math.ceil((246.35 / 25.4) * 300), h: Math.ceil((126.35 / 25.4) * 300) });
    expect(printSizeText(fallback)).toBe("Print size 9.45 × 4.72 in · with bleed 9.7 × 4.97 in");
    expect(printSizeText(printTarget(spec("front")))).not.toMatch(/mm|CD\d/);
  });
});
