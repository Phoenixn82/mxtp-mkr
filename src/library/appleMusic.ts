import type { Track } from "../audio/audio";
import type { CdBurnItem, CdProject } from "../project/catalog";
import { invokeCommand } from "../tauriClient";

export type MusicSource = "apple" | "spotify" | "soundcloud" | "youtubeMusic";

export interface TrackSourceStats {
  source: MusicSource;
  sourceTrackId: string;
  sourceUrl?: string;
  playCount: number;
  totalPlayMs?: number;
  playsByYear?: Record<string, number>;
  firstPlayedUnixMs?: number;
  lastPlayedUnixMs?: number;
  liked?: boolean;
  /** True only when this record came from the person's Apple Music library. */
  inAppleLibrary?: boolean;
  limitations?: string[];
}

export interface MusicSourceSummary {
  source: MusicSource;
  label: string;
  imported: boolean;
  sourcePath: string;
  trackCount: number;
  albumCount: number;
  artistCount: number;
  playlistCount: number;
  totalPlays: number;
  limitations: string[];
  importedAt?: string;
}

export interface AppleMusicTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  discNumber?: number;
  trackNumber?: number;
  year?: number;
  durationSec: number;
  bitRate?: number;
  playCount: number;
  lastPlayedUnixMs?: number;
  dateAddedUnixMs?: number;
  rating?: number;
  likeStatus: number;
  /** The local Apple Music library contains this track (not merely a source favourite). */
  inAppleLibrary?: boolean;
  artworkPath?: string;
  sourceStats?: TrackSourceStats[];
}

export interface AppleMusicPlaylist {
  id: string;
  name: string;
  trackIds: string[];
}

export interface AppleMusicLibraryData {
  sourcePath: string;
  version: string;
  summary: {
    trackCount: number;
    albumCount: number;
    artistCount: number;
    playlistCount: number;
    totalPlays: number;
    artworkTrackCount: number;
  };
  tracks: AppleMusicTrack[];
  playlists: AppleMusicPlaylist[];
  sources?: MusicSourceSummary[];
}

export interface AppleMusicAlbum {
  key: string;
  title: string;
  artist: string;
  year?: number;
  genre: string;
  artworkPath?: string;
  tracks: AppleMusicTrack[];
  durationSec: number;
  playCount: number;
  lastPlayedUnixMs?: number;
  /** Imported tracks without release metadata, shown as a source collection rather than a fabricated album. */
  sourceCollection?: Exclude<MusicSource, "apple">;
  /** A single imported track with its own source-provided artwork and metadata. */
  sourceTrack?: boolean;
}

export type AlbumSort = "recent" | "plays" | "artist" | "album";

export async function loadAppleMusicLibrary(path?: string): Promise<AppleMusicLibraryData> {
  return invokeCommand<AppleMusicLibraryData>("import_apple_music_library", path ? { path } : {});
}

export function albumsFromLibrary(library: AppleMusicLibraryData, sort: AlbumSort = "recent"): AppleMusicAlbum[] {
  const grouped = new Map<string, AppleMusicTrack[]>();
  const sourceCollections = new Map<Exclude<MusicSource, "apple">, AppleMusicTrack[]>();
  for (const track of library.tracks) {
    if (!track.album.trim()) {
      const sourceStat = track.sourceStats?.find((stat) => stat.source !== "apple");
      const source = sourceStat && sourceStat.source !== "apple" ? sourceStat.source : undefined;
      if (source) sourceCollections.set(source, [...(sourceCollections.get(source) ?? []), track]);
      continue;
    }
    const key = albumKey(track.albumArtist || track.artist, track.album);
    grouped.set(key, [...(grouped.get(key) ?? []), track]);
  }
  const albums: AppleMusicAlbum[] = [...grouped.entries()].map(([key, tracks]) => {
    const ordered = [...tracks].sort((left, right) =>
      discOrdinal(left.discNumber) - discOrdinal(right.discNumber)
      || trackOrdinal(left.trackNumber) - trackOrdinal(right.trackNumber)
      || left.title.localeCompare(right.title)
    );
    const lead = ordered[0];
    return {
      key,
      title: lead.album,
      artist: lead.albumArtist || lead.artist,
      year: mode(ordered.flatMap((track) => track.year ? [track.year] : [])),
      genre: mode(ordered.map((track) => track.genre).filter(Boolean)) ?? "",
      artworkPath: ordered.find((track) => track.artworkPath)?.artworkPath,
      tracks: ordered,
      durationSec: ordered.reduce((total, track) => total + track.durationSec, 0),
      playCount: ordered.reduce((total, track) => total + track.playCount, 0),
      lastPlayedUnixMs: Math.max(...ordered.map((track) => track.lastPlayedUnixMs ?? 0)) || undefined
    } satisfies AppleMusicAlbum;
  });
  for (const [source, tracks] of sourceCollections) {
    const ordered = [...tracks].sort((left, right) =>
      (right.lastPlayedUnixMs ?? 0) - (left.lastPlayedUnixMs ?? 0)
      || right.playCount - left.playCount
      || left.title.localeCompare(right.title)
    );
    const label = sourceCollectionLabel(source);
    if (source === "soundcloud") {
      for (const track of ordered) {
        albums.push({
          key: `source-track:${source}:${track.id}`,
          title: track.title,
          artist: track.artist || label,
          year: track.year,
          genre: track.genre || "SoundCloud import",
          artworkPath: track.artworkPath,
          tracks: [track],
          durationSec: track.durationSec,
          playCount: track.playCount,
          lastPlayedUnixMs: track.lastPlayedUnixMs,
          sourceCollection: source,
          sourceTrack: true
        });
      }
      continue;
    }
    albums.push({
      key: `collection:${source}`,
      title: `${label} collection`,
      artist: label,
      genre: "Imported listening data",
      tracks: ordered,
      durationSec: ordered.reduce((total, track) => total + track.durationSec, 0),
      playCount: ordered.reduce((total, track) => total + track.playCount, 0),
      lastPlayedUnixMs: Math.max(...ordered.map((track) => track.lastPlayedUnixMs ?? 0)) || undefined,
      sourceCollection: source
    });
  }
  return albums.sort(albumComparator(sort));
}

function sourceCollectionLabel(source: Exclude<MusicSource, "apple">): string {
  return source === "spotify" ? "Spotify" : source === "soundcloud" ? "SoundCloud" : "YouTube Music";
}

export function albumKey(artist: string, album: string): string {
  return `${normalize(artist)}::${normalize(album)}`;
}

export function isLikedTrack(track: AppleMusicTrack): boolean {
  return track.likeStatus > 0 || Boolean(track.sourceStats?.some((source) => source.liked));
}

/**
 * The album "Liked songs" view is intentionally narrower than a favourite:
 * it represents the tracks actually present in the local Apple Music library.
 * A Spotify/SoundCloud like must never make a track appear in this scope.
 */
export function isAppleLibraryTrack(track: AppleMusicTrack): boolean {
  return track.inAppleLibrary === true
    || Boolean(track.sourceStats?.some((source) => source.source === "apple" && source.inAppleLibrary));
}

export function downloadedTracksForAlbum(projects: CdProject[], album: AppleMusicAlbum): CdBurnItem[] {
  const libraryByTitle = new Map(album.tracks.map((track) => [normalizeTrackTitle(track.title), track]));
  const downloaded: CdBurnItem[] = [];
  for (const project of projects.filter((candidate) => projectMatchesAlbum(candidate, album, libraryByTitle))) {
    const exactProject = albumKey(project.entry.artist, project.entry.album) === album.key;
    const recoveredProject = !project.entry.artist?.trim() && normalize(project.entry.album || project.name) === normalize(album.title);
    const queuedTrackIds = new Set<string>();
    const candidates: CdBurnItem[] = [];
    for (const item of project.burnQueue ?? []) {
      if (!item.ready?.path || !burnItemMatchesAlbum(item, album, exactProject, recoveredProject)) continue;
      queuedTrackIds.add(item.ready.id);
      candidates.push(item);
    }
    for (const track of project.tracks ?? []) {
      if (!track.path || queuedTrackIds.has(track.id) || !trackMatchesAlbum(track, album, exactProject, recoveredProject)) continue;
      candidates.push({
        id: track.id,
        albumKey: album.key,
        title: track.title,
        artist: track.artist || project.entry.artist || album.artist,
        album: track.album || project.entry.album || album.title,
        durationSec: track.durationSec,
        ready: track
      });
    }

    for (const candidate of candidates) {
      const sourceTitle = candidate.title || candidate.ready?.title || "";
      if (isVideoVariantTitle(sourceTitle)) continue;
      const title = cleanAlbumTrackTitle(sourceTitle, album.artist);
      const normalizedTitle = normalizeTrackTitle(title);
      if (!normalizedTitle || downloaded.some((item) => normalizeTrackTitle(item.title) === normalizedTitle)) continue;
      const libraryTrack = libraryByTitle.get(normalizedTitle);
      const canonicalTitle = libraryTrack?.title ?? title;
      const ready = candidate.ready!;
      downloaded.push({
        ...candidate,
        id: libraryTrack?.id ?? candidate.id,
        albumKey: album.key,
        title: canonicalTitle,
        artist: album.artist,
        album: album.title,
        durationSec: ready.durationSec || candidate.durationSec || libraryTrack?.durationSec || 0,
        trackNumber: candidate.trackNumber ?? libraryTrack?.trackNumber,
        sourceStats: candidate.sourceStats ?? libraryTrack?.sourceStats,
        ready: { ...ready, title: canonicalTitle, artist: album.artist, album: album.title }
      });
    }
  }
  return downloaded;
}

export function readyTracksForAlbum(projects: CdProject[], album: AppleMusicAlbum): Map<string, Track> {
  const ready = new Map<string, Track>();
  const downloaded = downloadedTracksForAlbum(projects, album);
  for (const libraryTrack of album.tracks) {
    const exact = downloaded.find((item) => normalizeTrackTitle(item.title) === normalizeTrackTitle(libraryTrack.title))?.ready;
    if (exact?.path) ready.set(libraryTrack.id, exact);
  }
  return ready;
}

export function normalizeTrackTitle(value: string): string {
  return normalize(
    value
      .replace(/^\d{1,3}\s*[-.]\s*/, "")
      .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:audio|video|visualizer|lyric(?:s|\s+video)?)(?:\s+\d+k)?[)\]]\s*$/i, "")
      .replace(/\s*[([](?:feat(?:uring)?|ft)\.?\s+[^)\]]+[)\]]\s*$/i, "")
      .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.+$/i, "")
  );
}

function projectMatchesAlbum(project: CdProject, album: AppleMusicAlbum, libraryByTitle: Map<string, AppleMusicTrack>): boolean {
  if (albumKey(project.entry.artist, project.entry.album) === album.key) return true;
  if (project.tracks?.some((track) => track.artist && track.album && albumKey(track.artist, track.album) === album.key)) return true;
  if (project.burnQueue?.some((item) => item.albumKey === album.key || albumKey(item.artist, item.album) === album.key)) return true;
  if (project.entry.artist?.trim() || normalize(project.entry.album || project.name) !== normalize(album.title)) return false;
  const titles = [
    ...(project.burnQueue ?? []).map((item) => item.title),
    ...(project.tracks ?? []).map((track) => track.title)
  ];
  return titles.some((title) => libraryByTitle.has(normalizeTrackTitle(cleanAlbumTrackTitle(title, album.artist))))
    || titles.some((title) => hasArtistPrefix(title, album.artist));
}

function burnItemMatchesAlbum(item: CdBurnItem, album: AppleMusicAlbum, exactProject: boolean, recoveredProject: boolean): boolean {
  if (item.albumKey === album.key || albumKey(item.artist, item.album) === album.key) return true;
  if (item.artist?.trim()) return false;
  if (item.album?.trim() && normalize(item.album) !== normalize(album.title)) return false;
  return exactProject || recoveredProject;
}

function trackMatchesAlbum(track: Track, album: AppleMusicAlbum, exactProject: boolean, recoveredProject: boolean): boolean {
  if (track.artist?.trim() && track.album?.trim()) return albumKey(track.artist, track.album) === album.key;
  if (track.artist?.trim() && normalize(track.artist) !== normalize(album.artist)) return false;
  if (track.album?.trim() && normalize(track.album) !== normalize(album.title)) return false;
  return exactProject || recoveredProject;
}

function cleanAlbumTrackTitle(title: string, artist: string): string {
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(/^\d{1,3}\s*[-.]\s*/, "")
    .replace(new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, "i"), "")
    .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:audio|video|visualizer|lyric(?:s|\s+video)?)(?:\s+\d+k)?[)\]]\s*$/i, "")
    .trim();
}

function isVideoVariantTitle(title: string): boolean {
  return /(?:\s*[-–—|:]\s*|\s*[([]\s*)(?:official\s+)?(?:(?:music|lyric)\s+)?(?:video|visuali[sz]er)(?:\s+\d+k)?\s*[)\]]?\s*$/i.test(title);
}

function hasArtistPrefix(title: string, artist: string): boolean {
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, "i").test(title.trim());
}

function albumComparator(sort: AlbumSort): (left: AppleMusicAlbum, right: AppleMusicAlbum) => number {
  if (sort === "plays") return (left, right) => right.playCount - left.playCount || left.title.localeCompare(right.title);
  if (sort === "artist") return (left, right) => left.artist.localeCompare(right.artist) || left.title.localeCompare(right.title);
  if (sort === "album") return (left, right) => left.title.localeCompare(right.title) || left.artist.localeCompare(right.artist);
  return (left, right) => (right.lastPlayedUnixMs ?? 0) - (left.lastPlayedUnixMs ?? 0) || left.title.localeCompare(right.title);
}

/**
 * Matching key: NFKD, fold generic accents (the Combining Diacritical Mark
 * blocks), lowercase, keep letters, digits and script-intrinsic marks. ASCII
 * and accented Latin give the same key as the old ASCII-only rule, so persisted
 * albumKeys still match; non-Latin text keeps its letters instead of collapsing
 * to "". Kana voicing and Indic vowel signs are part of the word, so they stay.
 */
function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

function discOrdinal(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1;
}

function trackOrdinal(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : Number.MAX_SAFE_INTEGER;
}

function mode<T extends string | number>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}
