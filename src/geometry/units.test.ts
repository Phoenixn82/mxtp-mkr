import { describe, expect, it } from "vitest";
import { inToMm, mmToIn, mmToPt, mmToPx, ptToMm, pxToMm } from "./units";

describe("unit conversion", () => {
  it("converts 25.4mm to 300px at 300dpi", () => {
    expect(mmToPx(25.4, 300)).toBe(300);
  });

  it.each([300, 600])("round-trips through inches, points, and pixels at %idpi", (dpi) => {
    const mm = 126.35;
    expect(inToMm(mmToIn(mm))).toBeCloseTo(mm, 6);
    expect(ptToMm(mmToPt(mm))).toBeCloseTo(mm, 6);
    expect(pxToMm(mmToPx(mm, dpi), dpi)).toBeCloseTo(mm, 6);
  });
});
