import type { BookletPageKind } from "./pagination";

export type BookletDesignId =
  | "liquid-chrome"
  | "signal-collage"
  | "velvet-liner"
  | "quiet-field"
  | "studio-grid";

export type BookletPageLayout =
  | "cover"
  | "index"
  | "split"
  | "number-rail"
  | "quiet"
  | "colophon"
  | "art"
  | "back";

export type BookletMotif = "orb" | "signal" | "frame" | "field" | "grid";

export interface BookletDesignInput {
  artist?: string;
  album?: string;
  year?: number;
  tags?: string[];
  profile?: string;
  palette?: string[];
  luminance?: number;
}

export interface BookletDesign {
  id: BookletDesignId;
  label: string;
  artist: string;
  album: string;
  era: string;
  motif: BookletMotif;
  colors: {
    paper: string;
    ink: string;
    accent: string;
    highlight: string;
    muted: string;
  };
  washOpacity: number;
  lyricLayouts: BookletPageLayout[];
  displayFace: "sans" | "serif" | "mono";
}

export interface BookletPageVisual {
  designId: BookletDesignId;
  designLabel: string;
  layout: BookletPageLayout;
  motif: BookletMotif;
  colors: BookletDesign["colors"];
  washOpacity: number;
  displayFace: BookletDesign["displayFace"];
  folio: string;
  eyebrow: string;
}

interface DesignPreset {
  id: BookletDesignId;
  label: string;
  motif: BookletMotif;
  defaults: string[];
  washOpacity: number;
  lyricLayouts: BookletPageLayout[];
  displayFace: BookletDesign["displayFace"];
}

const PRESETS: Record<BookletDesignId, DesignPreset> = {
  "liquid-chrome": {
    id: "liquid-chrome",
    label: "Liquid chrome",
    motif: "orb",
    defaults: ["#071b31", "#38d9ff", "#b8ff63", "#f6fbff"],
    washOpacity: 0.12,
    lyricLayouts: ["number-rail", "split", "quiet"],
    displayFace: "sans"
  },
  "signal-collage": {
    id: "signal-collage",
    label: "Signal collage",
    motif: "signal",
    defaults: ["#16191a", "#ff4b36", "#d8ff3e", "#f2eee5"],
    washOpacity: 0.09,
    lyricLayouts: ["split", "number-rail", "quiet"],
    displayFace: "sans"
  },
  "velvet-liner": {
    id: "velvet-liner",
    label: "Velvet liner",
    motif: "frame",
    defaults: ["#231318", "#d5a85b", "#8c2844", "#f4eadc"],
    washOpacity: 0.1,
    lyricLayouts: ["quiet", "split", "number-rail"],
    displayFace: "serif"
  },
  "quiet-field": {
    id: "quiet-field",
    label: "Quiet field",
    motif: "field",
    defaults: ["#e7e5df", "#315b89", "#9199a2", "#101820"],
    washOpacity: 0.075,
    lyricLayouts: ["quiet", "split", "quiet"],
    displayFace: "mono"
  },
  "studio-grid": {
    id: "studio-grid",
    label: "Studio grid",
    motif: "grid",
    defaults: ["#f0eee8", "#146c94", "#ef8354", "#15191f"],
    washOpacity: 0.085,
    lyricLayouts: ["split", "quiet", "number-rail"],
    displayFace: "sans"
  }
};

export function deriveBookletDesign(input: BookletDesignInput = {}): BookletDesign {
  const preset = PRESETS[selectPreset(input)];
  const palette = resolvePalette(input.palette, preset.defaults);
  const baseLuminance = clamp01(input.luminance ?? relativeLuminance(palette[0]));
  const paper =
    baseLuminance < 0.48 ? mixHex(palette[0], "#050a10", 0.34) : mixHex(palette[0], "#fbfaf5", 0.76);
  const ink = relativeLuminance(paper) < 0.45 ? "#f7fbff" : "#111820";
  const accent = firstContrasting(palette.slice(1), paper, 2.1) ?? complementHex(paper);
  const highlight = firstContrasting(palette.slice(2), paper, 1.45) ?? mixHex(accent, ink, 0.38);
  const muted = mixHex(ink, paper, 0.58);

  return {
    id: preset.id,
    label: preset.label,
    artist: input.artist?.trim() || "Unknown artist",
    album: input.album?.trim() || "Untitled album",
    era: eraLabel(input.year),
    motif: preset.motif,
    colors: { paper, ink, accent, highlight, muted },
    washOpacity: preset.washOpacity,
    lyricLayouts: [...preset.lyricLayouts],
    displayFace: preset.displayFace
  };
}

export function visualForPage(
  design: BookletDesign,
  kind: BookletPageKind,
  pageNumber: number,
  trackIndex = 0
): BookletPageVisual {
  let layout: BookletPageLayout;
  switch (kind) {
    case "cover":
      layout = "cover";
      break;
    case "tracklist":
      layout = "index";
      break;
    case "credits":
    case "thanks":
      layout = "colophon";
      break;
    case "back":
      layout = "back";
      break;
    case "art":
    case "blank":
      layout = "art";
      break;
    default:
      layout = design.lyricLayouts[Math.abs(trackIndex) % design.lyricLayouts.length];
  }

  return {
    designId: design.id,
    designLabel: design.label,
    layout,
    motif: design.motif,
    colors: design.colors,
    washOpacity: design.washOpacity,
    displayFace: design.displayFace,
    folio: String(pageNumber).padStart(2, "0"),
    eyebrow: kind === "lyrics" ? `TRACK ${String(trackIndex + 1).padStart(2, "0")}` : kind.toUpperCase()
  };
}

export function hexToRgb01(hex: string): [number, number, number] {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return [r / 255, g / 255, b / 255];
}

export function mixHex(left: string, right: string, rightWeight: number): string {
  const a = parseHex(left) ?? [0, 0, 0];
  const b = parseHex(right) ?? [0, 0, 0];
  const weight = clamp01(rightWeight);
  return toHex(a.map((channel, index) => channel * (1 - weight) + b[index] * weight) as [number, number, number]);
}

export function contrastRatio(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function isHexColor(value: string): boolean {
  return parseHex(value) !== undefined;
}

function selectPreset(input: BookletDesignInput): BookletDesignId {
  const tokens = [input.profile ?? "", ...(input.tags ?? [])]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (/electronic|house|dance|disco|techno|synth|club/.test(tokens)) return "liquid-chrome";
  if (/alternative|rock|punk|metal|industrial|grunge/.test(tokens)) return "signal-collage";
  if (/hip.?hop|rap|soul|r&b|rhythm and blues|funk/.test(tokens)) return "velvet-liner";
  if (/ambient|experimental|drone|classical|jazz|minimal|post-rock/.test(tokens)) return "quiet-field";
  return "studio-grid";
}

function resolvePalette(palette: string[] | undefined, defaults: string[]): string[] {
  const valid = (palette ?? []).filter(isHexColor);
  return [...valid, ...defaults].slice(0, 4);
}

function firstContrasting(colors: string[], background: string, minimum: number): string | undefined {
  return colors.find((color) => isHexColor(color) && contrastRatio(color, background) >= minimum);
}

function complementHex(hex: string): string {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return toHex([255 - r, 255 - g, 255 - b]);
}

function eraLabel(year?: number): string {
  if (!year || year < 1900 || year > 2200) return "ERA / UNKNOWN";
  const decade = Math.floor(year / 10) * 10;
  return `${year} / ${decade}S`;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((value) => value / 255);
  const linear = [r, g, b].map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function parseHex(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const raw = match[1].length === 3 ? match[1].split("").map((char) => char + char).join("") : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16)) as [number, number, number];
}

function toHex(channels: [number, number, number]): string {
  return `#${channels
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
