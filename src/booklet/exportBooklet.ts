import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { getDimension } from "../print/dimensions";
import { type BookletDesignInput } from "./design";
import { buildBookletPdf } from "./bookletExport";

export interface ExportBookletOptions {
  /** Selected saddle-booklet page count (reader pages, multiple of 4). */
  pages: number;
  /** Pre-resolved cover bytes (tests inject these; UI resolves from refs). */
  coverBytes?: Uint8Array;
  /** Local file path to the front-cover image (Tauri fs read). */
  coverImageRef?: string;
  /** Fetchable preview URL for the front cover (browser fallback). */
  coverPreviewRef?: string;
  tracks: { title: string }[];
  lyricsByTrack?: { title: string; lyrics: string }[];
  credits?: string;
  design?: BookletDesignInput;
}

export interface ExportBookletResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** The user closed the save dialog: nothing was written and nothing went wrong. */
  cancelled?: boolean;
}

/**
 * Map a saddle page count to its Disc Makers booklet component (16 -> CD1600R).
 * Returns undefined when the registry has no machine-readable saddle booklet
 * for that count (e.g. 4 or 28 pages).
 */
export function bookletComponentId(pages: number): string | undefined {
  const id = `CD${pages * 100}R`;
  const dim = getDimension(id);
  return dim?.machineReadable && dim.kind === "saddle-booklet" ? id : undefined;
}

/**
 * UI glue: gather album state -> buildBookletPdf -> native save dialog -> write
 * the PDF bytes to disk. Never throws; every failure comes back as
 * `{ ok: false, error }` so the panel can surface it inline, and a closed save
 * dialog as `{ ok: false, cancelled: true }`.
 */
export async function exportBooklet(options: ExportBookletOptions): Promise<ExportBookletResult> {
  try {
    const componentId = bookletComponentId(options.pages);
    if (!componentId) {
      return { ok: false, error: `No print template for ${options.pages} pages. Choose 8 to 24 pages.` };
    }
    const coverImage = await resolveCoverBytes(options);
    const bytes = await buildBookletPdf({
      componentId,
      coverImage,
      tracks: options.tracks,
      lyricsByTrack: options.lyricsByTrack,
      credits: options.credits,
      design: options.design
    });
    const target = await save({
      defaultPath: `booklet-${componentId}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (!target) {
      return { ok: false, cancelled: true };
    }
    await writeFile(target, bytes);
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveCoverBytes(options: ExportBookletOptions): Promise<Uint8Array | undefined> {
  if (options.coverBytes && options.coverBytes.length > 0) {
    return options.coverBytes;
  }
  if (options.coverImageRef) {
    try {
      const bytes = await readFile(options.coverImageRef);
      if (bytes.length > 0) {
        return bytes;
      }
    } catch {
      // Not running under Tauri (or path unreadable) — fall through to the URL.
    }
  }
  if (options.coverPreviewRef) {
    try {
      const response = await fetch(options.coverPreviewRef);
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      // Cover art is optional; export a text-only cover page instead.
    }
  }
  return undefined;
}
