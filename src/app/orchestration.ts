import { ask } from "@tauri-apps/plugin-dialog";
import type { Track } from "../audio/audio";
import type { SlotArt } from "../art/editor";
import { BLEED_SAFE_MM, boxes, insertSpecs, TRAY_SPINE_MM, visibleTrayBackMm } from "../geometry";
import { albumKey, normalizeTrackTitle, type AppleMusicAlbum } from "../library/appleMusic";
import { createCdProject, projectCover, type CdBurnItem, type CdProject } from "../project/catalog";
import { composeTracklist, type AlbumInfo, type GeneratedCover, type TrackLyrics } from "../research/research";
import { invokeCommand } from "../tauriClient";

/**
 * Confirm before an irreversible physical CD burn. Writing a CD-R cannot be
 * undone and a misclick wastes a disc, so every real-burn path must pass through
 * here first. Uses the native OS dialog inside the packaged app; in a plain
 * browser / test runtime (no Tauri) it proceeds without prompting so unit tests
 * and dev preview are unaffected. If the dialog itself fails, it fails CLOSED
 * (returns false) so we never burn on an error.
 */
export async function confirmRealBurn(driveName: string, trackCount: number, discTitle: string): Promise<boolean> {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!inTauri) return true;
  const label = discTitle?.trim() ? `“${discTitle.trim()}”` : "this CD";
  try {
    return await ask(
      `Burn ${label} — ${trackCount} track${trackCount === 1 ? "" : "s"} — to the disc in ${driveName || "the selected drive"}?\n\nThis writes a physical CD and cannot be undone.`,
      { title: "Burn CD?", kind: "warning", okLabel: "Burn disc", cancelLabel: "Cancel" }
    );
  } catch {
    return false;
  }
}

export interface GoProject {
  /** Names the export folder: exports/<projectId>/<timestamp>. */
  projectId?: string;
  tracks: Track[];
  art: SlotArt[];
}

/** Reports what a long burn or export is doing right now ("Converting audio…"). */
export type StageReporter = (stage: string) => void;

export const VALIDATION_MESSAGES = {
  audio: "Add audio first (step 2, Audio).",
  art: "Add front, tray and disc art (step 3, Artwork)."
} as const;

const PIECE_LABELS: Record<string, string> = {
  front: "Front cover",
  tray: "Tray card",
  disc: "Disc face"
};

export function pieceLabel(pieceId: string): string {
  return PIECE_LABELS[pieceId] ?? insertSpecs().find((spec) => spec.id === pieceId)?.label ?? pieceId;
}

export interface GoResult {
  ok: boolean;
  exports: string[];
  burnProgress: number;
  errors: string[];
}

interface PcmTrack {
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

interface CdaImage {
  tracks: Array<{ number: number; path: string; sectors: number; pregapSectors: number; startSector: number }>;
  leadinSectors: number;
  leadoutSectors: number;
  totalSectors: number;
}

interface BurnResult {
  progress: number[];
  finalPercent: number;
  message: string;
}

interface CdText {
  albumTitle: string;
  albumArtist: string;
  tracks: Array<{ title: string; artist: string }>;
}

interface PdfInfo {
  path: string;
}

interface ImagePlacement {
  path: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  scale: number;
  rotationDeg: number;
}

interface TextPlacement {
  content: {
    title: string;
    lines: string[];
  };
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  fontSizePt: number;
}

export function validateProject(project: GoProject): string[] {
  const errors: string[] = [];
  if (project.tracks.length === 0) {
    errors.push(VALIDATION_MESSAGES.audio);
  }
  errors.push(...missingPathErrors(project.tracks));
  if (!project.art.some(hasArtContent)) {
    errors.push(VALIDATION_MESSAGES.art);
  }
  return errors;
}

/**
 * A track without a native file path can never be decoded (a browser File
 * import only knows the bare name), so name it instead of failing in ffmpeg.
 */
export function missingPathErrors(tracks: Track[]): string[] {
  return tracks
    .filter((track) => !track.path?.trim())
    .map((track) => `Re-add ${track.title || "this track"} with Add audio files…`);
}

function hasArtContent(item: SlotArt): boolean {
  return Boolean(item.imageRef || item.previewRef || item.textContent);
}

export function composeResearchArt(
  album: AlbumInfo,
  cover: GeneratedCover | undefined,
  lyricsByTrack: TrackLyrics[],
  bookletPages = 16
): SlotArt[] {
  // One booklet text box: a numbered section per track that has lyrics,
  // numbered by the track's position in the album tracklist.
  const lyricLines = lyricsByTrack
    .filter((entry) => entry.lyrics.trim().length > 0)
    .flatMap((entry, index) => {
      const position = album.tracks.indexOf(entry.title);
      const header = `${position >= 0 ? position + 1 : index + 1}. ${entry.title}`;
      const lines = entry.lyrics
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return index === 0 ? [header, ...lines] : ["", header, ...lines];
    });
  const slots: SlotArt[] = [];
  // Cover is optional: when generation failed, still compose the text pieces
  // (tray tracklist + booklet lyrics) so the album research is never lost.
  if (cover) {
    slots.push({
      slotId: "front",
      imageRef: cover.imagePath,
      previewRef: cover.previewUrl,
      imageSource: "research",
      transform: { x: 0, y: 0, scale: 1, rotation: 0 }
    });
  }
  slots.push(
    {
      slotId: "tray",
      textContent: {
        title: `${album.artist} - ${album.album}`,
        lines: composeTracklist(album).split("\n")
      },
      textSource: "research",
      transform: { x: 0, y: 0, scale: 1, rotation: 0 }
    },
    {
      slotId: `saddle-${bookletPages}`,
      textContent: {
        title: `${album.album} lyrics`,
        lines: lyricLines
      },
      textSource: "research",
      transform: { x: 0, y: 0, scale: 1, rotation: 0 }
    }
  );
  return slots;
}

/**
 * Upsert by physical slot so every preview/export reads one canonical value.
 * A slot left with no image and no text (e.g. after "Remove art") is dropped,
 * so GO never sends an empty piece to compose_pdf.
 */
export function mergeSlotArt(current: SlotArt[], updates: SlotArt[]): SlotArt[] {
  const order: string[] = [];
  const bySlot = new Map<string, SlotArt>();
  for (const item of [...current, ...updates]) {
    if (!bySlot.has(item.slotId)) order.push(item.slotId);
    bySlot.set(item.slotId, { ...bySlot.get(item.slotId), ...item });
  }
  return order.map((slotId) => bySlot.get(slotId)!).filter(hasArtContent);
}

/** The front the person chose (library artwork, a picked file, a playlist cover). */
function chosenFront(art: SlotArt[]): SlotArt | undefined {
  return art.find((item) => item.slotId === "front" && Boolean(item.imageRef || item.previewRef) && item.imageSource !== "research");
}

/**
 * Research art for a Lookup: a front the person already chose wins, so the
 * research "front" is dropped. "Use real album cover" replaces it on purpose
 * through a separate path.
 */
export function researchArtKeepingChosenFront(current: SlotArt[], researchArt: SlotArt[]): SlotArt[] {
  return chosenFront(current) ? researchArt.filter((item) => item.slotId !== "front") : researchArt;
}

/** A downloaded playlist cover may fill an empty front or replace an older playlist cover, never a chosen one. */
export function canUsePlaylistCover(art: SlotArt[]): boolean {
  const front = art.find((item) => item.slotId === "front" && Boolean(item.imageRef || item.previewRef));
  return !front || front.imageSource === "playlist";
}

export function playlistFront(coverPath: string): SlotArt {
  return {
    slotId: "front",
    imageRef: coverPath,
    previewRef: undefined,
    imageSource: "playlist",
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }
  };
}

// ---------------------------------------------------------------- burn list <-> studio tracks

/** The studio's playable list: the burn list's downloaded items, in burn order. */
export function playableTracks(queue: CdBurnItem[]): Track[] {
  return queue.flatMap((item) => (item.ready ? [item.ready] : []));
}

/** A burn-list item for a track that only exists in the studio (an import or a download). */
export function burnItemForTrack(track: Track, entry: { artist: string; album: string }): CdBurnItem {
  const artist = track.artist?.trim() || entry.artist;
  const album = track.album?.trim() || entry.album;
  return {
    id: track.id,
    albumKey: albumKey(entry.artist, entry.album),
    title: track.title,
    artist,
    album,
    durationSec: track.durationSec,
    ready: track
  };
}

/**
 * Write a studio track list back into the burn list: the ready slots take the
 * new order (matched by ready.id), titles follow edits, removed tracks drop
 * out, new tracks are appended, and items still waiting for audio keep their
 * place.
 */
export function writeTracksToQueue(
  queue: CdBurnItem[],
  tracks: Track[],
  entry: { artist: string; album: string }
): CdBurnItem[] {
  const byReadyId = new Map(queue.flatMap((item) => (item.ready ? [[item.ready.id, item] as const] : [])));
  const kept = tracks.filter((track) => byReadyId.has(track.id));
  const added = tracks.filter((track) => !byReadyId.has(track.id));
  let next = 0;
  const reordered = queue.flatMap((item) => {
    if (!item.ready) return [item];
    const track = kept[next];
    if (!track) return [];
    next += 1;
    const base = byReadyId.get(track.id)!;
    return [{ ...base, title: track.title, durationSec: track.durationSec || base.durationSec, ready: track }];
  });
  return [...reordered, ...added.map((track) => burnItemForTrack(track, entry))];
}

// ---------------------------------------------------------------- library album -> project

/**
 * The project a library album opens or prepares. An existing project keeps
 * its case format, and its updatedAt moves only when tracks or art change.
 */
export function libraryProjectFor(
  projects: CdProject[],
  album: AppleMusicAlbum,
  playlist?: PlaylistImport,
  now = new Date()
): CdProject {
  const existing = projects.find((project) => albumKey(project.entry.artist, project.entry.album) === album.key);
  const base = existing ?? createCdProject({ artist: album.artist, album: album.title, formatId: "jewelcase" }, now);
  const tracks = mergePreparedTracks(base.tracks, playlist?.tracks ?? []);
  // Once a person has chosen, downloaded, or researched a project cover it is
  // authoritative. Library artwork is only a fallback for a project that has
  // no usable front art of its own.
  const cover = album.artworkPath && !projectCover(base)
    ? [{ slotId: "front", imageRef: album.artworkPath, imageSource: "manual" as const, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }]
    : [];
  const art = cover.length > 0 ? mergeSlotArt(base.art, cover) : base.art;
  const changed = JSON.stringify(tracks) !== JSON.stringify(base.tracks) || JSON.stringify(art) !== JSON.stringify(base.art);
  return {
    ...base,
    entry: {
      artist: album.artist,
      album: album.title,
      formatId: base.entry.formatId || existing?.entry.formatId || "jewelcase"
    },
    tracks,
    art,
    research: base.research ?? {
      album: {
        artist: album.artist,
        album: album.title,
        year: album.year ?? 0,
        label: "MXTP combined music library",
        tracks: album.tracks.map((track) => track.title),
        coverArtUrls: [],
        tags: album.genre ? [album.genre] : []
      },
      lyricsByTrack: []
    },
    sourcePath: playlist?.tracks[0]?.path ? parentPath(playlist.tracks[0].path) : base.sourcePath,
    updatedAt: existing && !changed ? base.updatedAt : now.toISOString()
  };
}

export function mergePreparedTracks(current: Track[], updates: Track[]): Track[] {
  const merged = new Map(current.map((track) => [normalizeTrackTitle(track.title), track]));
  updates.forEach((track) => merged.set(normalizeTrackTitle(track.title), track));
  return [...merged.values()];
}

function parentPath(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

/** Replace album-owned art while preserving unrelated manual assignments such as disc print. */
export function replaceResearchArt(current: SlotArt[], researchArt: SlotArt[]): SlotArt[] {
  const preserved = current.flatMap((item) => {
    const stripped = stripResearchFields(item, true, true);
    return stripped ? [stripped] : [];
  });
  return mergeSlotArt(preserved, researchArt);
}

/** Move generated lyric text to another booklet size without deleting its manually assigned imagery. */
export function replaceResearchBookletArt(current: SlotArt[], researchArt: SlotArt[]): SlotArt[] {
  const preserved = current.flatMap((item) => {
    const stripped = item.slotId.startsWith("saddle-") ? stripResearchFields(item, false, true) : item;
    return stripped ? [stripped] : [];
  });
  return mergeSlotArt(preserved, researchArt);
}

function stripResearchFields(item: SlotArt, image: boolean, text: boolean): SlotArt | undefined {
  const next = { ...item };
  if (image && next.imageSource === "research") {
    delete next.imageRef;
    delete next.previewRef;
    delete next.imageSource;
  }
  if (text && next.textSource === "research") {
    delete next.textContent;
    delete next.textSource;
  }
  return next.imageRef || next.textContent ? next : undefined;
}

export interface DriveInfo {
  id: string;
  name: string;
}

export interface PlaylistImport {
  title: string;
  quality: string;
  coverPath?: string;
  tracks: Track[];
}

export interface YouTubeTrackMatch {
  url: string;
  title: string;
  artist: string;
  confidence: number;
  explanation: string;
}

export interface YouTubeAlbumMatch {
  url: string;
  title: string;
  artist: string;
  trackCount: number;
  safeTrackPositions: number[];
  confidence?: number;
  explanation?: string;
  trackPositions?: Array<{ title: string; position: number }>;
  tracks?: Array<{ title: string; durationSec: number; position: number }>;
}

export interface ExpectedAlbumTrack {
  title: string;
  durationSec: number;
}

export interface RealBurnResult {
  ok: boolean;
  message: string;
  finalPercent: number;
  errors: string[];
}

// Enumerate physical CD/DVD recorders via the Rust IMAPI2 probe (empty if none plugged in).
export async function detectBurners(): Promise<DriveInfo[]> {
  return invokeCommand<DriveInfo[]>("list_burners");
}

export async function downloadPlaylistBest(url: string, playlistItems?: number[]): Promise<PlaylistImport> {
  return invokeCommand<PlaylistImport>("download_playlist_best", {
    url,
    ...(playlistItems && playlistItems.length > 0 ? { playlistItems: playlistItems.join(",") } : {})
  });
}

export async function findYouTubeAlbumPlaylist(
  artist: string,
  album: string,
  expectedTracks: ExpectedAlbumTrack[] = []
): Promise<YouTubeAlbumMatch> {
  return invokeCommand<YouTubeAlbumMatch>("find_youtube_album_playlist", { artist, album, expectedTracks });
}

export async function findYouTubeTrack(artist: string, title: string, durationSec: number): Promise<YouTubeTrackMatch> {
  return invokeCommand<YouTubeTrackMatch>("find_youtube_track", { artist, title, durationSec });
}

// REAL Red Book CD-DA burn: decode audio -> CD-DA PCM -> build image -> raw write
// (simulate: false). Owner-gated by the UI to a detected drive + explicit Burn action.
// normalize is required so every caller states its loudness policy; the app
// burns albums as they are (false).
export async function burnReal(
  tracks: Track[],
  drive: string,
  normalize: boolean,
  discTitle?: string,
  onStage?: StageReporter
): Promise<RealBurnResult> {
  if (tracks.length === 0) {
    return { ok: false, message: "", finalPercent: 0, errors: ["add audio tracks before burning"] };
  }
  const missing = missingPathErrors(tracks);
  if (missing.length > 0) {
    return { ok: false, message: "", finalPercent: 0, errors: missing };
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    onStage?.("Converting audio…");
    const pcm = await invokeCommand<PcmTrack[]>("prepare_pcm", {
      paths: tracks.map((track) => track.path),
      gapSec: 0,
      normalize
    });
    onStage?.("Building CD image…");
    const image = await invokeCommand<CdaImage>("build_cda_image", {
      tracks: pcm,
      cdText: cdTextFromTracks(tracks, discTitle)
    });
    if (onStage) {
      const started = Date.now();
      const report = () => onStage(`Writing disc… ${elapsed(Date.now() - started)} elapsed`);
      report();
      timer = setInterval(report, 1000);
    }
    const burn = await invokeCommand<BurnResult>("burn_cda", { image, drive, simulate: false });
    return { ok: true, message: burn.message, finalPercent: burn.finalPercent, errors: [] };
  } catch (error) {
    return { ok: false, message: "", finalPercent: 0, errors: [errorText(error)] };
  } finally {
    if (timer) clearInterval(timer);
  }
}

function elapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cdTextFromTracks(tracks: Track[], discTitle?: string): CdText {
  const artists = distinctCdTextValues(tracks.map((track) => track.artist));
  const albums = distinctCdTextValues(tracks.map((track) => track.album));
  const albumArtist = artists.length === 0 ? "Unknown Artist" : artists.length === 1 ? artists[0] : "Various Artists";
  return {
    albumTitle: cdTextValue(discTitle) || (albums.length === 1 ? albums[0] : "MXTP Mix"),
    albumArtist,
    tracks: tracks.map((track, index) => ({
      title: cdTextValue(track.title) || `Track ${index + 1}`,
      artist: cdTextValue(track.artist) || (artists.length === 1 ? artists[0] : "Unknown Artist")
    }))
  };
}

function distinctCdTextValues(values: Array<string | undefined>): string[] {
  const distinct = new Map<string, string>();
  values.forEach((value) => {
    const cleaned = cdTextValue(value);
    if (cleaned) distinct.set(cleaned.toLocaleLowerCase(), cleaned);
  });
  return [...distinct.values()];
}

function cdTextValue(value?: string): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Where GO writes: relative, so the backend resolves it under the app's local data. */
export function exportDir(projectId: string | undefined, now = new Date()): string {
  const safeId = (projectId ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "project";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `exports/${safeId}/${stamp}`;
}

/**
 * GO: prepare the audio, write one print PDF per piece, then check the CD
 * image with a simulated burn. Pieces compose independently: one failing
 * piece is named ("Tray card: …") and the others are still written. Booklet
 * pages (saddle-*) come only from the Booklet panel's export, never from here.
 */
export async function runGo(project: GoProject, onStage?: StageReporter, now = new Date()): Promise<GoResult> {
  const errors = validateProject(project);
  if (errors.length > 0) {
    return { ok: false, exports: [], burnProgress: 0, errors };
  }
  const art = project.art.filter(hasArtContent);
  const pieces = Array.from(new Set(art.map((item) => item.slotId))).filter((slotId) => !slotId.startsWith("saddle-"));
  const outputDir = exportDir(project.projectId, now);
  const failures: string[] = [];

  let pcm: PcmTrack[] | undefined;
  try {
    onStage?.("Preparing audio…");
    pcm = await invokeCommand<PcmTrack[]>("prepare_pcm", {
      paths: project.tracks.map((track) => track.path),
      gapSec: 0,
      normalize: false
    });
  } catch (error) {
    failures.push(`Preparing audio: ${errorText(error)}`);
  }

  onStage?.("Writing print PDFs…");
  const composed = await Promise.allSettled(
    pieces.map((pieceId) =>
      invokeCommand<PdfInfo>("compose_pdf", {
        piece: {
          pieceId,
          outputDir,
          images: imagesForPiece(pieceId, art),
          texts: textsForPiece(pieceId, art)
        }
      })
    )
  );
  const exports: string[] = [];
  composed.forEach((result, index) => {
    if (result.status === "fulfilled") exports.push(result.value.path);
    else failures.push(`${pieceLabel(pieces[index])}: ${errorText(result.reason)}`);
  });

  let burnProgress = 0;
  if (pcm) {
    try {
      onStage?.("Checking the CD image…");
      const image = await invokeCommand<CdaImage>("build_cda_image", { tracks: pcm });
      const burn = await invokeCommand<BurnResult>("burn_cda", { image, drive: "simulate", simulate: true });
      burnProgress = burn.finalPercent;
    } catch (error) {
      failures.push(`Test burn: ${errorText(error)}`);
    }
  }
  return { ok: failures.length === 0, exports, burnProgress, errors: failures };
}

/**
 * Art is placed on the full bleed box (trim plus bleed on every side); the
 * backend cover-fits and clips it, so a cut sheet never shows a white edge.
 */
function imagesForPiece(pieceId: string, art: SlotArt[]): ImagePlacement[] {
  const spec = insertSpecs().find((item) => item.id === pieceId);
  if (!spec) {
    return [];
  }
  const bleed = boxes(spec.sheetFlat).bleed;
  return art.flatMap((item) => {
    if (item.slotId !== pieceId || !isImagePath(item.imageRef)) {
      return [];
    }
    return [{
      path: item.imageRef,
      xMm: 0,
      yMm: 0,
      wMm: bleed.w,
      hMm: bleed.h,
      scale: item.transform.scale,
      rotationDeg: item.transform.rotation
    }];
  });
}

function textsForPiece(pieceId: string, art: SlotArt[]): TextPlacement[] {
  const spec = insertSpecs().find((item) => item.id === pieceId);
  if (!spec) {
    return [];
  }
  const box = textBoxForPiece(pieceId, spec.sheetFlat);
  return art.flatMap((item) => {
    if (item.slotId !== pieceId || !hasText(item)) {
      return [];
    }
    return [{
      content: item.textContent,
      ...box,
      fontSizePt: pieceId === "tray" ? 8.5 : 9
    }];
  });
}

function textBoxForPiece(pieceId: string, sheetFlat: { x: number; y: number; w: number; h: number }) {
  const safe = boxes(sheetFlat).safe;
  if (pieceId === "tray") {
    return {
      xMm: TRAY_SPINE_MM + BLEED_SAFE_MM,
      yMm: safe.y,
      wMm: visibleTrayBackMm() - BLEED_SAFE_MM * 2,
      hMm: safe.h
    };
  }
  return { xMm: safe.x, yMm: safe.y, wMm: safe.w, hMm: safe.h };
}

function hasText(item: SlotArt): item is SlotArt & { textContent: { title: string; lines: string[] } } {
  return Boolean(item.textContent && (item.textContent.title || item.textContent.lines.length > 0));
}

function isImagePath(value: string | undefined): value is string {
  return Boolean(value && /\.(png|jpe?g)$/i.test(value));
}
