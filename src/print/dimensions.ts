// Public API for the CSV-sourced print dimension registry (Phase A).
//
// The heavy lifting happens at build time in scripts/gen-dimensions.mjs, which
// parses the Disc Makers layout guide map and emits dimensions.generated.ts.
// This module only exposes types + typed accessors over that committed data —
// no CSV parsing ever reaches the browser bundle.
//
// Conversions reuse the load-bearing src/geometry/units.ts helpers; we do not
// duplicate them here.

import { inToMm } from "../geometry/units";
import { REGISTRY } from "./dimensions.generated";

/** A single rectangle expressed in inches, millimetres, and 300-DPI pixels. */
export interface BoxDims {
  in: { w: number; h: number };
  mm: { w: number; h: number };
  px300: { w: number; h: number };
  /** Distance from each sheet edge to this box, in inches, when the source PDF exposed it. */
  insets?: {
    left: number | null;
    right: number | null;
    top: number | null;
    bottom: number | null;
  };
}

/** How a component is imposed / what physical form it takes. */
export type ComponentKind =
  | "single"
  | "saddle-booklet"
  | "folded-panel"
  | "disc";

/** One resolved component in the registry. */
export interface ComponentDim {
  /** The Disc Makers component code, e.g. "CD100_in", "CDT100_out", "CD1600R". */
  id: string;
  /** Product family the geometry was sourced from, e.g. "jewel", "digipak", "dvd". */
  formatId: string;
  kind: ComponentKind;
  /** Page count for booklets / multi-panel folders; omitted otherwise. */
  pages?: number;
  /** Human-readable Disc Makers template name. */
  template: string;
  /** Full page / sheet media box. */
  media: BoxDims | null;
  bleed: BoxDims | null;
  trim: BoxDims | null;
  safety: BoxDims | null;
  /** Fold-guide positions along the sheet width (inches from the left edge). */
  foldLines: number[];
  /** How many finished pages sit on one printed face (2 for saddle booklets). */
  upCount: number;
  /** Derived single-page boxes for saddle booklets (spread width halved). */
  pageTrim?: BoxDims;
  pageBleed?: BoxDims;
  pageSafety?: BoxDims;
  /** Disc centre-hole diameter in inches (disc kind only). */
  hole?: number;
  /** True only when the row exposed real bleed/trim/safety geometry. */
  machineReadable: boolean;
  /** Present when geometry was partial/derived or the source was header-only. */
  caveat?: string;
  /** Provenance. */
  representative: string;
  analysisMethod: string;
  notes: string;
}

/** The full registry keyed by component id. */
export type DimensionRegistry = Record<string, ComponentDim>;

/** Strip the inside/outside print-face suffix for alias resolution. */
function baseId(id: string): string {
  return id.replace(/_(in|out)$/i, "");
}

/**
 * Look up a component by id. Falls back to the `_in` / `_out` print-face
 * variants and finally to a base-code match, so callers can ask for "CD100"
 * even though the registry stores "CD100_in" / "CD100_out".
 */
export function getDimension(componentId: string): ComponentDim | undefined {
  if (REGISTRY[componentId]) return REGISTRY[componentId];
  if (REGISTRY[`${componentId}_in`]) return REGISTRY[`${componentId}_in`];
  if (REGISTRY[`${componentId}_out`]) return REGISTRY[`${componentId}_out`];
  const base = baseId(componentId);
  for (const id of Object.keys(REGISTRY)) {
    if (baseId(id) === base) return REGISTRY[id];
  }
  return undefined;
}

/** Every component whose geometry was sourced from the given format family. */
export function listByFormat(formatId: string): ComponentDim[] {
  return Object.values(REGISTRY).filter((c) => c.formatId === formatId);
}

/** All components, sorted by id. */
export function allComponents(): ComponentDim[] {
  return Object.values(REGISTRY).sort((a, b) => a.id.localeCompare(b.id));
}

/** Convert inches to 300-DPI device pixels (matches the generator's rounding). */
export function px300(inches: number): number {
  return Math.round(inches * 300);
}

/** Convert inches to millimetres (thin wrapper over the geometry units helper). */
export function inchesToMm(inches: number): number {
  return inToMm(inches);
}

export { REGISTRY };
