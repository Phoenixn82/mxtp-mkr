import { boxes, type InsertSpec } from "../geometry";
import type { CSSProperties } from "react";
import { impose, type ImposedSpread } from "../geometry/imposition";
import { getDimension, type BoxDims, type ComponentDim } from "./dimensions";

export const SADDLE_PAGE_COUNTS = [4, 8, 12, 16, 20, 24] as const;

const SADDLE_COMPONENTS: Record<number, string> = {
  8: "CD800R",
  12: "CD1200R",
  16: "CD1600R",
  20: "CD2000R",
  24: "CD2400R"
};

const INSERT_COMPONENTS: Record<string, string> = {
  front: "CD100",
  bifold: "CD400",
  trifold: "CD600",
  "folder-8": "CD800P",
  tray: "CDT100",
  disc: "UD100"
};

export interface PrintGuideBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function componentIdForInsertSpec(spec: InsertSpec): string | undefined {
  if (spec.binding === "saddle") {
    return SADDLE_COMPONENTS[spec.pages];
  }
  return INSERT_COMPONENTS[spec.id];
}

export function componentForInsertSpec(spec: InsertSpec): ComponentDim | undefined {
  const componentId = componentIdForInsertSpec(spec);
  return componentId ? getDimension(componentId) : undefined;
}

export function guideBoxOnMedia(media: BoxDims, box: BoxDims): PrintGuideBox {
  const left = box.insets?.left;
  const top = box.insets?.top;
  return {
    x: left ?? (media.in.w - box.in.w) / 2,
    y: top ?? (media.in.h - box.in.h) / 2,
    w: box.in.w,
    h: box.in.h
  };
}

export function guideStyle(media: BoxDims, box: PrintGuideBox): CSSProperties {
  return {
    left: `${(box.x / media.in.w) * 100}%`,
    top: `${(box.y / media.in.h) * 100}%`,
    width: `${(box.w / media.in.w) * 100}%`,
    height: `${(box.h / media.in.h) * 100}%`
  };
}

export function suggestBookletPageCount(lyricText: string, fallbackPages = 16): number {
  const lines = lyricText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (lines === 0) {
    return nearestSaddlePageCount(fallbackPages);
  }
  const lyricPages = Math.max(1, Math.ceil(lines / 28));
  return nearestSaddlePageCount(4 + lyricPages);
}

export function nearestSaddlePageCount(pages: number): number {
  const rounded = Math.max(4, Math.ceil(pages / 4) * 4);
  return SADDLE_PAGE_COUNTS.reduce((best, candidate) =>
    Math.abs(candidate - rounded) < Math.abs(best - rounded) ? candidate : best
  );
}

export function bookletPageOptions(currentPages: number): number[] {
  return Array.from(new Set([...SADDLE_PAGE_COUNTS, currentPages])).sort((a, b) => a - b);
}

export function impositionPreviewRows(pageCount: number): ImposedSpread[] {
  return impose(pageCount);
}

export interface PrintTarget {
  /** Finished size, in inches. */
  trimIn: { w: number; h: number };
  /** Size with bleed: what the artwork must cover, in inches. */
  bleedIn: { w: number; h: number };
  /** Smallest image that covers the bleed at 300 dpi. */
  px: { w: number; h: number };
}

/**
 * What a piece's artwork must cover. The Disc Makers template is the source
 * of truth when it has trim and bleed; otherwise the app geometry is used.
 * Readouts and the too-small warning both read from here, so they never disagree.
 */
export function printTarget(spec: InsertSpec): PrintTarget {
  const component = componentForInsertSpec(spec);
  const set = boxes(spec.sheetFlat);
  const inches = (mm: number) => mm / 25.4;
  // The epsilon keeps an exact fit (127 mm = 1500 px) from rounding up a pixel.
  const pixels = (mm: number) => Math.ceil((mm / 25.4) * 300 - 1e-6);
  // GO enforces 300 DPI on the app bleed box, so never ask for less than that.
  const app = { w: pixels(set.bleed.w), h: pixels(set.bleed.h) };
  if (component?.machineReadable && component.trim && component.bleed) {
    const px = component.bleed.px300;
    return { trimIn: component.trim.in, bleedIn: component.bleed.in, px: { w: Math.max(px.w, app.w), h: Math.max(px.h, app.h) } };
  }
  return {
    trimIn: { w: inches(set.trim.w), h: inches(set.trim.h) },
    bleedIn: { w: inches(set.bleed.w), h: inches(set.bleed.h) },
    px: app
  };
}

/** "Print size 4.72 × 4.72 in · with bleed 4.97 × 4.97 in": no mm, no template codes. */
export function printSizeText(target: PrintTarget): string {
  const size = (box: { w: number; h: number }) => `${trimNumber(box.w)} × ${trimNumber(box.h)} in`;
  return `Print size ${size(target.trimIn)} · with bleed ${size(target.bleedIn)}`;
}

export function formatIn(value: number): string {
  return `${trimNumber(value)} in`;
}

export function formatMm(value: number): string {
  return `${trimNumber(value)} mm`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
