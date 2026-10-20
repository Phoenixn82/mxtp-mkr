import { invokeCommand } from "../tauriClient";

export interface AlbumInfo {
  artist: string;
  album: string;
  year: number;
  label: string;
  tracks: string[];
  coverArtUrls: string[];
  tags: string[];
}

export interface GeneratedCover {
  imagePath: string;
  previewUrl?: string;
  prompt: string;
  palette: string[];
  /** Which backend produced this: "real" | "pollinations" | "cloudflare" | "codex" | "mock". */
  adapter?: string;
}

export interface TrackLyrics {
  title: string;
  lyrics: string;
}

/** What the app has learned about the album's aesthetic from its REAL cover. */
export interface CoverTheme {
  sourceUrl: string;
  previewUrl: string;
  palette: string[];
  luminance: number;
}

export interface StyleDna {
  palette: string[];
  mood: string[];
  era: string;
  sourceTags: string[];
  profile: string;
}

export type CoverDirectionId = "archival" | "era-adjacent" | "unexpected-hybrid";

export interface CoverDirection {
  id: CoverDirectionId;
  label: string;
  description: string;
  composition: string;
  material: string;
  lighting: string;
  titleZone: string;
}

export const COVER_DIRECTIONS: readonly CoverDirection[] = [
  {
    id: "archival",
    label: "Archival / referential",
    description: "Preserve the source era's restraint and visual grammar without recreating its imagery.",
    composition: "a centered, catalogued focal object with measured margins, quiet hierarchy, and archival precision",
    material: "scanned paper fibers, restrained offset ink, subtle halftone, and believable age without fake damage",
    lighting: "flat copy-stand light with one soft dimensional shadow",
    titleZone: "a calm low-detail band across the upper third"
  },
  {
    id: "era-adjacent",
    label: "Era-adjacent",
    description: "Create a plausible sister release from the same period using an entirely new central motif.",
    composition: "period-correct asymmetry, one dominant image, a supporting micro-detail, and intentional open space",
    material: "era-appropriate photography, collage, ink trapping, paper grain, and print texture rather than a digital filter",
    lighting: "directional studio light with controlled contrast and tactile surface detail",
    titleZone: "one uninterrupted low-detail area occupying at least 20% of the upper or lower third"
  },
  {
    id: "unexpected-hybrid",
    label: "Unexpected hybrid",
    description: "Fuse the album's established visual DNA with one surprising but coherent contrasting medium.",
    composition: "a bold off-axis focal form where organic texture intersects precise technical geometry, with strong depth",
    material: "a tactile hybrid of photographed matter, translucent print layers, foil-like highlights, and imperfect analog registration",
    lighting: "sculptural rim light plus a soft environmental glow, avoiding generic neon haze",
    titleZone: "a deliberate quiet pocket beside the focal form, large enough for artist and album typography"
  }
];

export const DEFAULT_COVER_DIRECTION: CoverDirectionId = "era-adjacent";

export async function lookupAlbum(artist: string, album: string): Promise<AlbumInfo> {
  return invokeCommand<AlbumInfo>("lookup_album", { artist, album });
}

export async function fetchLyrics(artist: string, title: string): Promise<string> {
  return invokeCommand<string>("fetch_lyrics", { artist, title });
}

export async function generateCover(prompt: string, styleRefs: string[] = []): Promise<GeneratedCover> {
  return invokeCommand<GeneratedCover>("generate_cover", { prompt, styleRefs });
}

/** Transform the downloaded real cover itself, rather than generating a related image from text. */
export async function editCoverFromOriginal(sourceImagePath: string, instruction: string): Promise<GeneratedCover> {
  return invokeCommand<GeneratedCover>("edit_cover_from_original", { sourceImagePath, instruction });
}

/** True when Cloudflare Workers AI credentials are set, so Cover chat edits can run. Never returns the values. */
export async function coverEditAvailable(): Promise<boolean> {
  return invokeCommand<boolean>("cover_edit_available");
}

export async function fetchCoverTheme(coverArtUrls: string[]): Promise<CoverTheme> {
  return invokeCommand<CoverTheme>("fetch_cover_theme", { coverArtUrls });
}

/** The REAL album cover downloaded as a full-res local file, shaped like GeneratedCover. */
export interface RealCover {
  imagePath: string;
  previewUrl: string;
  palette: string[];
}

/** Download the actual album cover full-res so it can be applied to the front slot in one click. */
export async function fetchRealCoverFile(coverArtUrls: string[]): Promise<RealCover> {
  return invokeCommand<RealCover>("fetch_real_cover_file", { coverArtUrls });
}

/** A few contemporaneous cover-image URLs (the artist's studio albums near `year`). */
export async function fetchEraCovers(artist: string, year: number, limit = 5): Promise<string[]> {
  return invokeCommand<string[]>("fetch_era_covers", { artist, year, limit });
}

/** Vision art-direction: read the real cover + era refs into a grounded generation prompt. */
export async function artDirectFromReferences(
  albumLabel: string,
  coverArtUrls: string[],
  eraRefUrls: string[]
): Promise<string> {
  return invokeCommand<string>("art_direct_from_references", { albumLabel, coverArtUrls, eraRefUrls });
}

export function coverDirectionFor(id: CoverDirectionId): CoverDirection {
  return COVER_DIRECTIONS.find((direction) => direction.id === id) ?? COVER_DIRECTIONS[1];
}

export function visionAlbumLabelForDirection(album: AlbumInfo, directionId: CoverDirectionId): string {
  const direction = coverDirectionFor(directionId);
  return `${album.artist} - ${album.album}. Selected art direction: ${direction.label}. ${direction.description}`;
}

export function coverAdapterLabel(adapter?: string): string {
  switch (adapter) {
    case "real":
      return "Real album artwork · Cover Art Archive";
    case "pollinations":
      return "AI artwork · Pollinations (legacy provider label)";
    case "pollinations-klein":
      return "AI artwork · Pollinations Klein · reference-conditioned";
    case "pollinations-gptimage":
      return "AI artwork · Pollinations GPT Image · reference-conditioned";
    case "pollinations-gptimage-large":
      return "AI artwork · Pollinations GPT Image 1.5 · vision-grounded";
    case "pollinations-nova-canvas":
      return "AI artwork · Pollinations Nova Canvas · vision-grounded";
    case "pollinations-flux":
      return "AI artwork · Pollinations FLUX · prompt-only";
    case "cloudflare-flux2-pro-preview-edit":
      return "Original-cover edit / Cloudflare FLUX.2 Pro";
    case "cloudflare-flux2-max-edit":
      return "Original-cover edit / Cloudflare FLUX.2 Max";
    case "cloudflare":
      return "AI artwork · Cloudflare Workers AI / FLUX";
    case "codex":
      return "AI artwork · Codex image generation";
    case "mock":
      return "Placeholder artwork · mock adapter (not AI-generated)";
    default:
      return adapter ? `Generated artwork · ${adapter}` : "Generated artwork · provider not reported";
  }
}

export function composeTracklist(album: AlbumInfo): string {
  return album.tracks.map((track, index) => `${index + 1}. ${track}`).join("\n");
}

export function styleDnaFromAlbum(album: AlbumInfo): StyleDna {
  const tags = normalizeTags(album.tags);
  const profile = chooseStyleProfile(tags);

  return {
    palette: profile.palette,
    mood: profile.mood,
    era: eraToken(album.year),
    sourceTags: tags.slice(0, 8),
    profile: profile.name
  };
}

export function coverPromptForAlbum(
  album: AlbumInfo,
  styleDna = styleDnaFromAlbum(album),
  theme?: CoverTheme,
  directionId: CoverDirectionId = DEFAULT_COVER_DIRECTION
): string {
  const direction = coverDirectionFor(directionId);
  const profile = profileByName(styleDna.profile);
  const palette = theme?.palette.length ? theme.palette.join(", ") : styleDna.palette.join(", ");
  const tonalRange = theme
    ? theme.luminance < 0.35
      ? "predominantly dark with protected light accents"
      : theme.luminance > 0.65
        ? "predominantly light with disciplined dark anchors"
        : "mid-tone with a clear light-dark hierarchy"
    : "balanced for legibility at CD-booklet scale";
  const parts = [
    "Create one original, print-ready artwork image for a physical CD booklet cover",
    "Format: exact 1:1 square composition, edge-to-edge artwork, no border",
    `Music context only, never render these words: ${album.artist} - ${album.album}; ${album.year || "unknown year"}; ${album.label}`,
    `Direction: ${direction.label} - ${direction.description}`,
    `Style-DNA provenance: profile=${styleDna.profile}; palette=${styleDna.palette.join(", ")}; mood=${styleDna.mood.join(", ")}; era=${styleDna.era}; MusicBrainz tags: ${styleDna.sourceTags.join(", ") || "none"}`,
    `Concept: ${profile.concept}; express ${styleDna.mood.join(", ")} as one specific visual metaphor rather than a generic genre scene`,
    `Composition: ${direction.composition}`,
    `Material: ${profile.material}; combine with ${direction.material}`,
    `Lighting: ${profile.lighting}; ${direction.lighting}`,
    `Palette: prioritize ${palette}; ${tonalRange}; avoid unrelated rainbow color`,
    `Era cues: ${styleDna.era}; use period-correct image-making and print language informed by ${styleDna.sourceTags.join(", ") || "the release context"}, not costume nostalgia`,
    `Title-safe negative space: reserve ${direction.titleZone} for typography that will be added later; keep that zone uncluttered`,
    "Originality: interpret the reference artwork's visual grammar without reproducing its subject, layout, symbols, or recognizable composition",
    "Exclude: all text, letters, numbers, logos, watermarks, signatures, barcodes, borders, jewel cases, CDs, packaging mockups, frames, hands, and product photography"
  ];
  if (theme && theme.palette.length > 0) {
    parts.push(
      `Reference discipline: the real artwork is ${tonalRange} with dominant colors ${theme.palette.join(", ")}; Match this album's original visual mood and color relationships while making a genuinely new image`
    );
  }
  return `${parts.join(". ")}.`;
}

export function coverPromptFromArtDirection(
  album: AlbumInfo,
  artDirection: string,
  styleDna = styleDnaFromAlbum(album),
  theme?: CoverTheme,
  directionId: CoverDirectionId = DEFAULT_COVER_DIRECTION
): string {
  const visualGrammar = compactVisualGrammar(artDirection);
  if (!visualGrammar) {
    return coverPromptForAlbum(album, styleDna, theme, directionId);
  }
  const direction = coverDirectionFor(directionId);
  const sampledPalette = theme?.palette.length
    ? `Pixel-grounded palette from the real cover (mandatory): ${theme.palette.join(", ")}; overall luminance ${theme.luminance.toFixed(2)}; preserve these color proportions and do not substitute an unrelated palette`
    : "Color discipline: use only the color relationships named in the extracted visual grammar";
  const compositionGuard = /\basymmetr/i.test(visualGrammar)
    ? "Composition enforcement: asymmetric means no centered focal point; distribute three to five unequal visual events across a diagonal and into the edges"
    : /\bsymmetr|\bcentered/i.test(visualGrammar)
      ? "Composition enforcement: preserve the centered or symmetric structure named in the visual grammar"
      : "Composition enforcement: follow the focal hierarchy named in the visual grammar without defaulting to a centered icon";
  return [
    "RAW FULL-BLEED ARTWORK ONLY - generate the square image itself, never a photograph, print, poster, card, canvas, sleeve, frame, package, or presentation of artwork",
    `Highest priority - visual grammar extracted from the real cover: ${visualGrammar}`,
    sampledPalette,
    compositionGuard,
    `Creative distance: ${direction.label} - ${direction.description}`,
    "Reference handling: the real cover has already been distilled into the visual grammar and sampled palette above; preserve those invariants while inventing a completely new motif",
    `Era context: ${styleDna.era}; do not introduce genre colors, stock imagery, or visual cliches that conflict with the extracted grammar`,
    "Anti-cliche gate: no centered glowing orb, portal, cosmic nebula, mandala, flower-like radial bloom, isolated fluid blob, generic smoke swirl, ornamental frame, or fake microtype",
    "Typography handoff: when typography is primary or structural in the reference, translate its placement, repetition, scale, and rhythm into integrated low-detail or translucent bands so exact type can be added later",
    "Format: exact 1:1 square; the visual field must reach every edge with no surrounding surface, mat, inner rectangle, border, frame, bevel, drop shadow, or mockup",
    "Originality: do not copy the source subject, symbols, letterforms, logo, or recognizable arrangement",
    "No readable text, fake text, pseudo-letters, microtype, numbers, signatures, watermarks, barcodes, logos, jewel cases, CDs, hands, or product photography"
  ].join(". ") + ".";
}

export function coverStyleReferences(_album: AlbumInfo, _eraRefs: string[]): string[] {
  // Real pixels already shape the vision brief and sampled palette. Supplying a
  // typography-heavy cover again at render time makes image models copy it as
  // fake glyphs instead of generating a clean, original base artwork.
  return [];
}

function compactVisualGrammar(brief: string): string {
  const trimmed = brief.trim();
  if (!trimmed.includes("\n")) {
    return trimmed;
  }
  const wanted = new Set([
    "PRIMARY ENERGY",
    "COMPOSITION",
    "COLOR LOGIC",
    "SURFACE / MEDIUM",
    "TYPOGRAPHY ROLE",
    "NEW MOTIF",
    "FORBIDDEN CLICHES"
  ]);
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => wanted.has(line.split(":", 1)[0].toUpperCase()))
    .map((line) => (line.length > 240 ? `${line.slice(0, 237)}...` : line));
  return lines.length ? lines.join(". ") : trimmed;
}

interface StyleProfile {
  name: string;
  tags: string[];
  palette: string[];
  mood: string[];
  concept: string;
  material: string;
  lighting: string;
}

const STYLE_PROFILES: StyleProfile[] = [
  {
    name: "electronic-house",
    tags: ["big beat", "club/dance", "dance", "disco", "electro", "electronic", "electronica", "french house", "house", "techno"],
    palette: ["electric cyan", "hot magenta", "mirror black"],
    mood: ["kinetic", "chrome-lit", "dancefloor"],
    concept: "a machine-human pulse expressed through a single transformed everyday object and measured signal geometry",
    material: "gloss photography, screen-printed gradients, crisp diagram lines, and selective chrome reflection",
    lighting: "hard-edged studio highlights against deep controlled shadow"
  },
  {
    name: "alternative-art-rock",
    tags: ["alternative rock", "art rock", "britpop", "experimental rock", "indie rock", "post-britpop", "rock"],
    palette: ["oxidized green", "cold white", "signal red"],
    mood: ["anxious", "wide-screen", "machine-age"],
    concept: "a fragmented map or familiar structure made uncanny by one precise visual interruption",
    material: "documentary photography, distressed offset ink, photocopy grain, and sparse technical annotation shapes",
    lighting: "cold overcast illumination interrupted by one sharp signal-colored flare"
  },
  {
    name: "hip-hop-soul",
    tags: ["hip hop", "neo soul", "r&b", "rap", "soul"],
    palette: ["burnished gold", "ink black", "deep burgundy"],
    mood: ["sampled", "warm", "street-lit"],
    concept: "a monumental cropped still life built from objects that imply memory, place, and personal mythology",
    material: "rich photographic grain, uncoated stock, deep ink, restrained foil, and embossed-looking tonal relief",
    lighting: "warm direct flash balanced by dense velvety shadow"
  },
  {
    name: "ambient-experimental",
    tags: ["ambient", "avant-garde", "drone", "experimental", "minimal", "post-rock"],
    palette: ["mist gray", "bone white", "ultramarine"],
    mood: ["abstract", "spacious", "textural"],
    concept: "an impossible quiet landscape or mineral form that makes scale and atmosphere ambiguous",
    material: "translucent vellum, fine photographic grain, diffused pigment, and delicate layered fibers",
    lighting: "soft shadowless daylight with subtle volumetric depth"
  }
];

const FALLBACK_PROFILE: StyleProfile = {
  name: "tag-neutral",
  tags: [],
  palette: ["deep black", "paper white", "chrome silver"],
  mood: ["cinematic", "textured", "album-forward"],
  concept: "a singular symbolic still life with one memorable transformation and no stock-music imagery",
  material: "believable analog photography or collage with visible paper and ink character",
  lighting: "sculptural directional light with a controlled falloff"
};

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function chooseStyleProfile(tags: string[]): StyleProfile {
  const scored = STYLE_PROFILES.map((profile) => ({
    profile,
    score: profile.tags.reduce((total, tag) => total + (tags.includes(tag) ? 1 : 0), 0)
  })).sort((left, right) => right.score - left.score);
  return scored[0]?.score ? scored[0].profile : FALLBACK_PROFILE;
}

function profileByName(name: string): StyleProfile {
  return STYLE_PROFILES.find((profile) => profile.name === name) ?? FALLBACK_PROFILE;
}

function eraToken(year: number): string {
  if (!year) {
    return "unknown-era";
  }
  const decade = Math.floor(year / 10) * 10;
  const position = year % 10;
  const phase = position <= 3 ? "early" : position <= 6 ? "mid" : "late";
  return `${phase}-${decade}s`;
}
