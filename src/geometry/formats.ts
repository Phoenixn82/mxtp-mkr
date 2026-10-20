import type { Box, Mm } from "./boxes";

export interface Annulus {
  cx: Mm;
  cy: Mm;
  outerD: Mm;
  innerD: Mm;
  holeD: Mm;
}

export type SlotKind = "rect" | "annulus";

export interface Slot {
  id: string;
  label: string;
  kind: SlotKind;
  trim: Box | Annulus;
  pages?: number;
  binding?: "none" | "fold" | "saddle";
}

export interface InsertSpec {
  id: string;
  label: string;
  pages: number;
  binding: "none" | "fold" | "saddle";
  sheetFlat: Box;
}

export const PAGE_MM = 120;
export const TRAY_W_MM = 150;
export const TRAY_H_MM = 118;
export const TRAY_SPINE_MM = 6.5;

export function visibleTrayBackMm(): number {
  return TRAY_W_MM - TRAY_SPINE_MM * 2;
}

export function jewelSlots(): Slot[] {
  return [
    {
      id: "front",
      label: "Front cover",
      kind: "rect",
      trim: { x: 0, y: 0, w: PAGE_MM, h: PAGE_MM },
      pages: 2,
      binding: "none"
    },
    {
      id: "tray",
      label: "Tray card with spines",
      kind: "rect",
      trim: { x: 0, y: 0, w: TRAY_W_MM, h: TRAY_H_MM },
      pages: 1,
      binding: "fold"
    },
    {
      id: "disc",
      label: "Disc face",
      kind: "annulus",
      trim: { cx: 60, cy: 60, outerD: 118, innerD: 22, holeD: 15 },
      pages: 1,
      binding: "none"
    }
  ];
}

export function insertSpecs(): InsertSpec[] {
  const folder = (id: string, label: string, pages: number): InsertSpec => ({
    id,
    label,
    pages,
    binding: pages === 2 ? "none" : "fold",
    sheetFlat: { x: 0, y: 0, w: (pages / 2) * PAGE_MM, h: PAGE_MM }
  });

  return [
    folder("front", "Front insert", 2),
    folder("bifold", "Bi-fold insert", 4),
    folder("trifold", "Tri-fold insert", 6),
    folder("folder-8", "8-page folder", 8),
    ...validBookletPageCounts("saddle").map((pages) => ({
      id: `saddle-${pages}`,
      label: `${pages}-page saddle booklet`,
      pages,
      binding: "saddle" as const,
      sheetFlat: { x: 0, y: 0, w: PAGE_MM * 2, h: PAGE_MM }
    })),
    {
      id: "tray",
      label: "Tray card",
      pages: 1,
      binding: "fold",
      sheetFlat: { x: 0, y: 0, w: TRAY_W_MM, h: TRAY_H_MM }
    },
    {
      id: "disc",
      label: "Disc face",
      pages: 1,
      binding: "none",
      sheetFlat: { x: 0, y: 0, w: 120, h: 120 }
    }
  ];
}

export function validBookletPageCounts(binding: "fold" | "saddle"): number[] {
  return binding === "saddle" ? [4, 8, 12, 16, 20, 24, 28] : [2, 4, 6, 8];
}

export function isValidBookletPageCount(binding: "fold" | "saddle", pages: number): boolean {
  return validBookletPageCounts(binding).includes(pages);
}
