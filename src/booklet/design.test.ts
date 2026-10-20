import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  deriveBookletDesign,
  hexToRgb01,
  isHexColor,
  mixHex,
  visualForPage
} from "./design";

describe("booklet design direction", () => {
  it.each([
    ["french house", "liquid-chrome"],
    ["alternative rock", "signal-collage"],
    ["neo soul", "velvet-liner"],
    ["ambient experimental", "quiet-field"],
    ["spoken word", "studio-grid"]
  ] as const)("maps %s to a distinct editorial family", (tag, expected) => {
    expect(deriveBookletDesign({ tags: [tag] }).id).toBe(expected);
  });

  it("uses real cover colors as roles while maintaining readable ink contrast", () => {
    const design = deriveBookletDesign({
      artist: "Radiohead",
      album: "In Rainbows",
      year: 2007,
      tags: ["alternative rock"],
      palette: ["#1b0c0a", "#ef5b31", "#f3d33b"],
      luminance: 0.12
    });

    expect(design).toMatchObject({
      id: "signal-collage",
      artist: "Radiohead",
      album: "In Rainbows",
      era: "2007 / 2000S",
      motif: "signal"
    });
    expect(contrastRatio(design.colors.ink, design.colors.paper)).toBeGreaterThanOrEqual(4.5);
    expect(design.colors.accent).not.toBe(design.colors.paper);
  });

  it("rejects invalid palette values and falls back to a complete deterministic palette", () => {
    const first = deriveBookletDesign({ palette: ["red", "#xyz"], profile: "house" });
    const second = deriveBookletDesign({ palette: ["red", "#xyz"], profile: "house" });
    expect(first).toEqual(second);
    expect(Object.values(first.colors).every(isHexColor)).toBe(true);
  });

  it("assigns semantic page layouts and rotates lyric layouts by track", () => {
    const design = deriveBookletDesign({ tags: ["house"] });
    expect(visualForPage(design, "cover", 1).layout).toBe("cover");
    expect(visualForPage(design, "tracklist", 2).layout).toBe("index");
    expect(visualForPage(design, "credits", 15).layout).toBe("colophon");
    expect(visualForPage(design, "back", 16).layout).toBe("back");
    expect(visualForPage(design, "blank", 14).layout).toBe("art");
    expect(visualForPage(design, "lyrics", 3, 0)).toMatchObject({
      layout: "number-rail",
      folio: "03",
      eyebrow: "TRACK 01"
    });
    expect(visualForPage(design, "lyrics", 4, 1).layout).toBe("split");
    expect(visualForPage(design, "lyrics", 5, 2).layout).toBe("quiet");
  });

  it("handles color conversion, shorthand hex, mixing, and contrast boundaries", () => {
    expect(hexToRgb01("#fff")).toEqual([1, 1, 1]);
    expect(hexToRgb01("invalid")).toEqual([0, 0, 0]);
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000", "#fff", -4)).toBe("#000000");
    expect(mixHex("#000", "#fff", 4)).toBe("#ffffff");
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 4);
    expect(isHexColor("#12aBcD")).toBe(true);
    expect(isHexColor("12abcd")).toBe(false);
  });
});
