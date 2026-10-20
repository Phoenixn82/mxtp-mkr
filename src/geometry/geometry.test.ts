import { describe, expect, it } from "vitest";
import { boxes } from "./boxes";
import { insertSpecs, isValidBookletPageCount, jewelSlots, validBookletPageCounts, visibleTrayBackMm } from "./formats";
import { impose } from "./imposition";

describe("geometry", () => {
  it("derives bleed and safe boxes from front-cover trim", () => {
    const set = boxes({ x: 0, y: 0, w: 120, h: 120 });
    expect(set.bleed.w).toBeCloseTo(126.35, 2);
    expect(set.bleed.h).toBeCloseTo(126.35, 2);
    expect(set.safe.w).toBeCloseTo(113.65, 2);
    expect(set.safe.h).toBeCloseTo(113.65, 2);
  });

  it("returns jewel slots for front, tray, and disc geometry", () => {
    const slots = jewelSlots();
    expect(slots.find((slot) => slot.id === "front")?.trim).toMatchObject({ w: 120, h: 120 });
    expect(slots.find((slot) => slot.id === "tray")?.trim).toMatchObject({ w: 150, h: 118 });
    expect(visibleTrayBackMm()).toBe(137);
    expect(slots.find((slot) => slot.id === "disc")?.trim).toMatchObject({ outerD: 118, innerD: 22, holeD: 15 });
  });

  it("enforces folder and saddle-stitch page counts", () => {
    expect(validBookletPageCounts("saddle")).toEqual([4, 8, 12, 16, 20, 24, 28]);
    expect(validBookletPageCounts("fold")).toContain(6);
    expect(isValidBookletPageCount("saddle", 10)).toBe(false);
  });

  it("imposes saddle booklets exactly", () => {
    expect(impose(12)).toEqual([
      { sheet: 0, face: "outer", left: 12, right: 1 },
      { sheet: 0, face: "inner", left: 2, right: 11 },
      { sheet: 1, face: "outer", left: 10, right: 3 },
      { sheet: 1, face: "inner", left: 4, right: 9 },
      { sheet: 2, face: "outer", left: 8, right: 5 },
      { sheet: 2, face: "inner", left: 6, right: 7 }
    ]);
    expect(impose(8)).toEqual([
      { sheet: 0, face: "outer", left: 8, right: 1 },
      { sheet: 0, face: "inner", left: 2, right: 7 },
      { sheet: 1, face: "outer", left: 6, right: 3 },
      { sheet: 1, face: "inner", left: 4, right: 5 }
    ]);
    expect(impose(4)).toEqual([
      { sheet: 0, face: "outer", left: 4, right: 1 },
      { sheet: 0, face: "inner", left: 2, right: 3 }
    ]);
  });

  it("lists every jewel-compatible insert used by the final suite", () => {
    expect(insertSpecs().map((spec) => spec.id)).toEqual([
      "front",
      "bifold",
      "trifold",
      "folder-8",
      "saddle-4",
      "saddle-8",
      "saddle-12",
      "saddle-16",
      "saddle-20",
      "saddle-24",
      "saddle-28",
      "tray",
      "disc"
    ]);
  });
});
