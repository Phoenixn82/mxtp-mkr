import type { SlotArt } from "../art/editor";
import type { Track } from "../audio/audio";
import { PRINTABLE_BOOKLET_PAGE_COUNTS } from "../booklet/bookletExport";
import type { LandingEntry } from "../landing/LandingScreen";
import { albumKey, type TrackSourceStats } from "../library/appleMusic";
import type { AlbumInfo, CoverTheme, GeneratedCover, TrackLyrics } from "../research/research";
import { invokeCommand } from "../tauriClient";

export interface SavedResearch {
  album: AlbumInfo;
  cover?: GeneratedCover;
  lyricsByTrack: TrackLyrics[];
  theme?: CoverTheme;
}

export type ProjectKind = "artist" | "custom";

export interface CuratorMemory {
  dislikedArtists: string[];
  preferredGenres: string[];
  notes: string;
  lastProjectName?: string;
  lastPrompt?: string;
}

export interface CuratorMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  choices?: Array<{ trackId: string; title: string; artist: string; explanation: string }>;
  citations?: string[];
  proposal?: { id: string; trackCount: number };
}

export interface CuratorProposal {
  id: string;
  title: string;
  items: CdBurnItem[];
  replaceExisting: boolean;
  createdAt: string;
}

export interface CuratorState {
  memory: CuratorMemory;
  messages: CuratorMessage[];
  revision: number;
  pendingProposal?: CuratorProposal;
}

export interface CdBurnItem {
  id: string;
  albumKey: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  trackNumber?: number;
  ready?: Track;
  sourceStats?: TrackSourceStats[];
}

export interface CdProject {
  id: string;
  name: string;
  kind: ProjectKind;
  saved: boolean;
  entry: LandingEntry;
  burnQueue: CdBurnItem[];
  tracks: Track[];
  art: SlotArt[];
  researchApplied: string[];
  research: SavedResearch | null;
  bookletPages: number;
  exports: string[];
  burnProgress: number;
  playlistUrl: string;
  createdAt: string;
  updatedAt: string;
  lastBurnedAt?: string;
  sourcePath?: string;
  curator?: CuratorState;
}

export interface CachedPlaylist {
  sourcePath: string;
  title: string;
  quality: string;
  coverPath?: string;
  tracks: Track[];
  updatedAtMs: number;
}

export function createCdProject(entry: LandingEntry, now = new Date(), suffix?: string): CdProject {
  const timestamp = now.toISOString();
  const token = suffix ?? Math.random().toString(36).slice(2, 8);
  return {
    id: `${slug(entry.artist || "mix")}-${slug(entry.album || "untitled")}-${now.getTime()}-${token}`,
    name: entry.album || "Untitled CD",
    kind: entry.artist && entry.album ? "artist" : "custom",
    saved: false,
    entry,
    burnQueue: [],
    tracks: [],
    art: [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function emptyCuratorState(): CuratorState {
  return {
    memory: { dislikedArtists: [], preferredGenres: [], notes: "" },
    messages: [],
    revision: 0
  };
}

export function mergeCachedPlaylists(projects: CdProject[], cached: CachedPlaylist[]): CdProject[] {
  const knownSources = new Set(projects.flatMap((project) => (project.sourcePath ? [project.sourcePath] : [])));
  const recovered = cached
    .filter((playlist) => !knownSources.has(playlist.sourcePath))
    .map((playlist) => recoverCachedPlaylist(playlist));
  return sortCdProjects([...projects, ...recovered]);
}

export function upsertCdProject(projects: CdProject[], project: CdProject): CdProject[] {
  return sortCdProjects([...projects.filter((candidate) => candidate.id !== project.id), project]);
}

export function sortCdProjects(projects: CdProject[]): CdProject[] {
  return [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function projectCover(project: CdProject): SlotArt | undefined {
  const assigned = project.art.find((item) => item.slotId === "front" && Boolean(item.imageRef || item.previewRef));
  if (assigned) return assigned;

  const generated = project.research?.cover;
  if (generated?.imagePath || generated?.previewUrl) {
    return {
      slotId: "front",
      imageRef: generated.imagePath,
      previewRef: generated.previewUrl,
      imageSource: "research",
      transform: { x: 0, y: 0, scale: 1, rotation: 0 }
    };
  }

  const themePreview = project.research?.theme?.previewUrl;
  if (!themePreview) return undefined;
  return {
    slotId: "front",
    previewRef: themePreview,
    imageSource: "research",
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }
  };
}

/**
 * One malformed project file must not hide the others: each stored item is
 * checked and normalized on its own, and the skipped ones are counted.
 */
export async function loadCdProjects(): Promise<CdProject[]> {
  const loaded = await invokeCommand<unknown>("load_cd_projects");
  if (!Array.isArray(loaded)) throw new Error("Saved projects could not be read.");
  const projects: CdProject[] = [];
  let skipped = 0;
  for (const raw of loaded) {
    try {
      if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || !isRecord(raw.entry)) throw new Error("not a project");
      projects.push(normalizeCdProject(raw as Partial<CdProject> & Pick<CdProject, "id" | "entry">));
    } catch {
      skipped += 1;
    }
  }
  if (skipped) console.warn(`Skipped ${skipped} saved project file(s) that could not be read.`);
  return sortCdProjects(projects);
}

export async function saveCdProject(project: CdProject): Promise<void> {
  await invokeCommand("save_cd_project", { project });
}

export async function deleteCdProject(projectId: string): Promise<void> {
  await invokeCommand("delete_cd_project", { projectId });
}

export async function listCachedPlaylists(): Promise<CachedPlaylist[]> {
  return invokeCommand<CachedPlaylist[]>("list_cached_playlists");
}

function recoverCachedPlaylist(playlist: CachedPlaylist): CdProject {
  const updatedAt = new Date(playlist.updatedAtMs).toISOString();
  const id = `recovered-${slug(playlist.title)}-${stableToken(playlist.sourcePath)}`;
  return {
    id,
    name: playlist.title || "Downloaded album",
    kind: "artist",
    saved: false,
    entry: { artist: "", album: playlist.title, formatId: "jewelcase" },
    burnQueue: playlist.tracks.map((track, index) => ({
      id: track.id,
      albumKey: albumIdentity("", playlist.title),
      title: track.title,
      artist: "",
      album: playlist.title,
      durationSec: track.durationSec,
      trackNumber: index + 1,
      ready: track
    })),
    tracks: playlist.tracks,
    art: playlist.coverPath
      ? [{
          slotId: "front",
          imageRef: playlist.coverPath,
          imageSource: "playlist",
          transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        }]
      : [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: updatedAt,
    updatedAt,
    sourcePath: playlist.sourcePath
  };
}

export function normalizeCdProject(raw: Partial<CdProject> & Pick<CdProject, "id" | "entry">): CdProject {
  const entry: LandingEntry = {
    ...raw.entry,
    artist: text(raw.entry.artist),
    album: text(raw.entry.album),
    formatId: text(raw.entry.formatId) || "jewelcase"
  };
  const tracks = records<Track>(raw.tracks);
  const art = records<SlotArt>(raw.art);
  const research = normalizeResearch(raw.research, entry);
  const name = text(raw.name).trim();
  const meaningful = Boolean(
    raw.lastBurnedAt
    || tracks.length
    || art.length
    || research
    || entry.artist.trim()
    || entry.album.trim()
  );
  const saved = typeof raw.saved === "boolean"
    ? raw.saved
    : meaningful && !raw.id.startsWith("recovered-");
  const kind: ProjectKind = raw.kind === "artist" || raw.kind === "custom"
    ? raw.kind
    : entry.artist.trim() && entry.album.trim() ? "artist" : "custom";
  // Only a legacy project with no burnQueue key is rebuilt from its tracks. An
  // empty list is a choice (Clear, or removing the last track), and tracks keeps
  // every downloaded file, so rebuilding from it would bring old tracks back.
  const burnQueue: CdBurnItem[] = Array.isArray(raw.burnQueue)
    ? records<CdBurnItem>(raw.burnQueue)
    : tracks.map((track, index) => ({
        id: track.id,
        albumKey: albumIdentity(entry.artist, entry.album),
        title: track.title,
        artist: entry.artist,
        album: entry.album || name || "Untitled CD",
        durationSec: track.durationSec,
        trackNumber: index + 1,
        ready: track.path || track.url ? track : undefined
      }));
  const createdAt = text(raw.createdAt) || new Date(0).toISOString();
  return {
    id: raw.id,
    name: name || entry.album.trim() || "Untitled CD",
    kind,
    saved: saved || Boolean(raw.lastBurnedAt),
    entry,
    burnQueue,
    tracks,
    art,
    researchApplied: Array.isArray(raw.researchApplied) ? raw.researchApplied : [],
    research,
    bookletPages: printableBookletPages(raw.bookletPages),
    exports: Array.isArray(raw.exports) ? raw.exports : [],
    // Older library burns persisted lastBurnedAt without copying the final
    // progress value. Treat a recorded physical burn as complete when loading
    // those projects so the UI does not reopen a successfully burned disc at 0%.
    burnProgress: raw.lastBurnedAt ? 100 : typeof raw.burnProgress === "number" ? raw.burnProgress : 0,
    playlistUrl: text(raw.playlistUrl),
    createdAt,
    updatedAt: text(raw.updatedAt) || createdAt,
    lastBurnedAt: raw.lastBurnedAt,
    sourcePath: raw.sourcePath,
    curator: isRecord(raw.curator) ? {
      memory: {
        dislikedArtists: Array.isArray(raw.curator.memory?.dislikedArtists) ? raw.curator.memory.dislikedArtists : [],
        preferredGenres: Array.isArray(raw.curator.memory?.preferredGenres) ? raw.curator.memory.preferredGenres : [],
        notes: raw.curator.memory?.notes ?? "",
        lastProjectName: raw.curator.memory?.lastProjectName,
        lastPrompt: raw.curator.memory?.lastPrompt
      },
      messages: records<CuratorMessage>(raw.curator.messages),
      revision: raw.curator.revision ?? 0
    } : undefined
  };
}

/** Saved research can be partial (older builds, interrupted lookups); fill every list the UI reads. */
function normalizeResearch(raw: unknown, entry: LandingEntry): SavedResearch | null {
  if (!isRecord(raw)) return null;
  const album = isRecord(raw.album) ? raw.album : {};
  const cover = isRecord(raw.cover) ? raw.cover : undefined;
  const theme = isRecord(raw.theme) ? raw.theme : undefined;
  return {
    ...raw,
    album: {
      ...album,
      artist: text(album.artist) || entry.artist,
      album: text(album.album) || entry.album,
      year: typeof album.year === "number" ? album.year : 0,
      label: text(album.label),
      tracks: strings(album.tracks),
      coverArtUrls: strings(album.coverArtUrls),
      tags: strings(album.tags)
    },
    cover: cover ? { ...cover, palette: strings(cover.palette) } as unknown as GeneratedCover : undefined,
    lyricsByTrack: records<TrackLyrics>(raw.lyricsByTrack),
    theme: theme ? { ...theme, palette: strings(theme.palette) } as unknown as CoverTheme : undefined
  };
}

/** Booklets print only at PRINTABLE_BOOKLET_PAGE_COUNTS; snap anything else to the nearest, ties up. */
function printableBookletPages(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 16;
  return PRINTABLE_BOOKLET_PAGE_COUNTS.reduce<number>((best, count) =>
    Math.abs(count - value) <= Math.abs(best - value) ? count : best, PRINTABLE_BOOKLET_PAGE_COUNTS[0]);
}

export function savedProjects(projects: CdProject[]): CdProject[] {
  return projects.filter((project) => project.saved || Boolean(project.lastBurnedAt));
}

export function projectFromBurnQueue(
  queue: CdBurnItem[],
  name: string,
  existing?: CdProject,
  now = new Date()
): CdProject {
  if (queue.length === 0 && existing) {
    // An emptied list keeps the project's artist, album and kind.
    return {
      ...existing,
      name: name.trim() || existing.name,
      burnQueue: [],
      tracks: [],
      updatedAt: now.toISOString()
    };
  }
  const first = queue[0];
  const sameAlbum = Boolean(first) && queue.every((item) => item.albumKey === first.albumKey);
  const entry: LandingEntry = sameAlbum
    ? { artist: first.artist, album: first.album, formatId: existing?.entry.formatId ?? "jewelcase" }
    : { artist: "", album: name.trim() || "Custom CD", formatId: existing?.entry.formatId ?? "jewelcase" };
  const base = existing ?? createCdProject(entry, now);
  return {
    ...base,
    name: name.trim() || (sameAlbum ? first.album : "Custom CD"),
    kind: sameAlbum ? "artist" : "custom",
    entry,
    burnQueue: queue,
    tracks: queue.flatMap((item) => item.ready ? [item.ready] : []),
    updatedAt: now.toISOString()
  };
}

/** ASCII slug for ids; text with no ASCII letters (e.g. Japanese, Cyrillic) gets a stable hash instead of a shared "cd". */
function slug(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii) return ascii;
  return albumKey("", value).length > 2 ? stableToken(value) : "cd";
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (const character of value.toLowerCase()) {
    // Whole code points: the same value as charCodeAt for the BMP, so existing ids do not change.
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Same key as the library's albumKey, so projects and library albums match. */
function albumIdentity(artist: string, album: string): string {
  return albumKey(artist, album);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The object entries of a stored list; anything else (null, strings) is dropped. */
function records<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as T[] : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
