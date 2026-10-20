import { invokeCommand } from "../tauriClient";
import {
  albumKey,
  type AppleMusicLibraryData,
  type AppleMusicPlaylist,
  type AppleMusicTrack,
  type MusicSource,
  type MusicSourceSummary,
  type TrackSourceStats
} from "./appleMusic";

export interface ImportTextFile {
  name: string;
  text: string;
  path?: string;
}

export interface ImportedMusicSource {
  source: Exclude<MusicSource, "apple">;
  sourcePath: string;
  importedAt: string;
  tracks: AppleMusicTrack[];
  playlists: AppleMusicPlaylist[];
  limitations: string[];
}

export const SOURCE_LABELS: Record<MusicSource, string> = {
  apple: "Apple Music",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  youtubeMusic: "YouTube Music"
};

export const SOURCE_LIMITATIONS: Record<MusicSource, string[]> = {
  apple: [
    "Local Music library supplies lifetime play count, rating, genre, and last-played time, but not dated play events.",
    "Subscription audio is DRM-protected and is never imported or copied."
  ],
  spotify: [
    "Extended Streaming History provides dated lifetime listening events and milliseconds played; library exports add saved-track state.",
    "Genre, track number, and artwork are not present in Spotify privacy-history JSON."
  ],
  soundcloud: [
    "Likes, playlists, uploads, genre, and metadata can be imported when present in an account export.",
    "SoundCloud does not provide complete personal play counts in its public API; public track playback_count is intentionally ignored."
  ],
  youtubeMusic: [
    "Google Takeout watch history provides dated plays, titles, channels, and URLs; it does not provide duration, album, genre, or a reliable music-only flag for every event.",
    "Only entries attributable to YouTube Music or music.youtube.com are imported automatically; ambiguous YouTube viewing is skipped."
  ]
};

export async function loadImportedMusicSources(): Promise<ImportedMusicSource[]> {
  return invokeCommand<ImportedMusicSource[]>("load_imported_music_sources");
}

export async function saveImportedMusicSources(sources: ImportedMusicSource[]): Promise<void> {
  await invokeCommand("save_imported_music_sources", { sources });
}

export function parseMusicExport(
  source: ImportedMusicSource["source"],
  files: ImportTextFile[],
  now = new Date()
): ImportedMusicSource {
  if (files.length === 0) throw new Error("Choose at least one exported JSON or CSV file.");
  const parsed = source === "spotify"
    ? parseSpotify(files)
    : source === "soundcloud"
      ? parseSoundCloud(files)
      : parseYouTubeMusic(files);
  if (parsed.tracks.length === 0) {
    throw new Error(`No ${SOURCE_LABELS[source]} music records were recognized in those files.`);
  }
  return {
    source,
    sourcePath: files.map((file) => file.path || file.name).join("; "),
    importedAt: now.toISOString(),
    tracks: parsed.tracks,
    playlists: parsed.playlists,
    limitations: SOURCE_LIMITATIONS[source]
  };
}

export function combineMusicLibraries(
  apple: AppleMusicLibraryData | null,
  imported: ImportedMusicSource[],
  enabled: Set<MusicSource>
): AppleMusicLibraryData {
  const sourceLibraries = [
    ...(apple ? [{ source: "apple" as const, tracks: apple.tracks, playlists: apple.playlists }] : []),
    ...imported
  ];
  const selected = sourceLibraries.filter((library) => enabled.has(library.source));
  const combined = new Map<string, AppleMusicTrack>();
  const appleTracksByUniqueTitle = uniqueAppleTracksByTitle(apple?.tracks ?? []);
  const playlists: AppleMusicPlaylist[] = [];
  for (const library of selected) {
    for (const track of library.tracks) {
      const resolved = library.source === "apple" ? track : enrichFromAppleLibrary(track, appleTracksByUniqueTitle);
      mergeTrack(combined, withSourceStats(resolved, library.source));
    }
    playlists.push(...library.playlists.map((playlist) => ({
      ...playlist,
      id: `${library.source}:${playlist.id}`
    })));
  }
  const tracks = [...combined.values()];
  const albumKeys = new Set(tracks.filter((track) => track.album.trim()).map((track) => albumKey(track.albumArtist || track.artist, track.album)));
  const artistKeys = new Set(tracks.map((track) => normalize(track.albumArtist || track.artist)).filter(Boolean));
  return {
    sourcePath: selected.map((library) => library.source).join(","),
    version: "multi-library-v1",
    summary: {
      trackCount: tracks.length,
      albumCount: albumKeys.size,
      artistCount: artistKeys.size,
      playlistCount: playlists.length,
      totalPlays: tracks.reduce((total, track) => total + track.playCount, 0),
      artworkTrackCount: tracks.filter((track) => track.artworkPath).length
    },
    tracks,
    playlists,
    sources: sourceSummaries(apple, imported)
  };
}

function uniqueAppleTracksByTitle(tracks: AppleMusicTrack[]): Map<string, AppleMusicTrack> {
  const candidates = new Map<string, AppleMusicTrack | null>();
  for (const track of tracks) {
    const key = normalize(track.title);
    if (!key) continue;
    candidates.set(key, candidates.has(key) ? null : track);
  }
  return new Map([...candidates].flatMap(([key, track]) => track ? [[key, track]] : []));
}

/**
 * Privacy exports often omit release fields.  Reuse local Apple metadata only
 * for an exact title that occurs once in that library; ambiguity never becomes
 * a guessed album or cover.
 */
function enrichFromAppleLibrary(track: AppleMusicTrack, appleTracksByUniqueTitle: Map<string, AppleMusicTrack>): AppleMusicTrack {
  if (track.album.trim()) return track;
  const match = appleTracksByUniqueTitle.get(normalize(track.title));
  if (!match) return track;
  return {
    ...track,
    title: match.title,
    artist: match.artist,
    album: match.album,
    albumArtist: match.albumArtist,
    genre: match.genre || track.genre,
    discNumber: match.discNumber,
    trackNumber: match.trackNumber,
    year: match.year,
    durationSec: match.durationSec || track.durationSec,
    artworkPath: match.artworkPath
  };
}

export function sourceSummaries(apple: AppleMusicLibraryData | null, imported: ImportedMusicSource[]): MusicSourceSummary[] {
  const bySource = new Map<MusicSource, { tracks: AppleMusicTrack[]; playlists: AppleMusicPlaylist[]; sourcePath: string; importedAt?: string }>();
  if (apple) bySource.set("apple", { tracks: apple.tracks, playlists: apple.playlists, sourcePath: apple.sourcePath });
  imported.forEach((library) => bySource.set(library.source, library));
  return (Object.keys(SOURCE_LABELS) as MusicSource[]).map((source) => {
    const library = bySource.get(source);
    const tracks = library?.tracks ?? [];
    return {
      source,
      label: SOURCE_LABELS[source],
      imported: Boolean(library),
      sourcePath: library?.sourcePath ?? "",
      trackCount: tracks.length,
      albumCount: new Set(tracks.filter((track) => track.album).map((track) => albumKey(track.albumArtist || track.artist, track.album))).size,
      artistCount: new Set(tracks.map((track) => normalize(track.albumArtist || track.artist)).filter(Boolean)).size,
      playlistCount: library?.playlists.length ?? 0,
      totalPlays: tracks.reduce((sum, track) => sum + track.playCount, 0),
      limitations: SOURCE_LIMITATIONS[source],
      importedAt: library?.importedAt
    };
  });
}

function parseSpotify(files: ImportTextFile[]): { tracks: AppleMusicTrack[]; playlists: AppleMusicPlaylist[] } {
  const tracks = new Map<string, AppleMusicTrack>();
  const playlists: AppleMusicPlaylist[] = [];
  for (const file of files) {
    const value = parseJson(file);
    const savedLibrary = isSpotifyLibrary(value);
    const arrays: Array<[string, unknown[]]> = Array.isArray(value)
      ? [["", value]]
      : isRecord(value)
        ? Object.entries(value).flatMap(([key, entry]): Array<[string, unknown[]]> =>
            Array.isArray(entry) && !/^banned/i.test(key) ? [[key, entry]] : [])
        : [];
    for (const [key, event] of arrays) {
      const liked = savedLibrary && key === "tracks";
      for (const raw of event) {
        if (!isRecord(raw)) continue;
        const title = string(raw.master_metadata_track_name ?? raw.trackName ?? raw.track);
        const artist = string(raw.master_metadata_album_artist_name ?? raw.artistName ?? raw.artist);
        if (title && artist) {
          const album = string(raw.master_metadata_album_album_name ?? raw.albumName ?? raw.album);
          const uri = string(raw.spotify_track_uri ?? raw.trackUri ?? raw.uri);
          const playedAt = dateMs(raw.ts ?? raw.endTime ?? raw.played_at);
          const playedMs = number(raw.ms_played ?? raw.msPlayed);
          const isHistory = Boolean(raw.ts || raw.endTime || raw.ms_played !== undefined || raw.msPlayed !== undefined);
          addSourceTrack(tracks, {
            source: "spotify",
            sourceId: uri || `${artist}:${album}:${title}`,
            title,
            artist,
            album,
            durationSec: 0,
            playIncrement: isHistory && playedMs >= 30_000 ? 1 : 0,
            playedMs: isHistory ? playedMs : 0,
            playedAt,
            liked,
            sourceUrl: uri ? `https://open.spotify.com/track/${uri.split(":").pop()}` : undefined
          });
        }
      }
    }
    const root = isRecord(value) ? value : undefined;
    const rawPlaylists = Array.isArray(root?.playlists) ? root.playlists : [];
    for (const rawPlaylist of rawPlaylists) {
      if (!isRecord(rawPlaylist)) continue;
      const name = string(rawPlaylist.name) || "Spotify playlist";
      const items = Array.isArray(rawPlaylist.items) ? rawPlaylist.items : [];
      const ids: string[] = [];
      for (const rawItem of items) {
        const item = isRecord(rawItem) && isRecord(rawItem.track) ? rawItem.track : rawItem;
        if (!isRecord(item)) continue;
        const title = string(item.trackName ?? item.name);
        const artist = string(item.artistName ?? item.artist);
        if (!title || !artist) continue;
        const sourceId = string(item.trackUri ?? item.uri) || `${artist}:${string(item.albumName)}:${title}`;
        addSourceTrack(tracks, {
          source: "spotify", sourceId, title, artist, album: string(item.albumName), durationSec: number(item.duration_ms) / 1000,
          liked: false, sourceUrl: sourceId.startsWith("spotify:") ? `https://open.spotify.com/track/${sourceId.split(":").pop()}` : undefined
        });
        ids.push(sourceTrackId("spotify", sourceId));
      }
      playlists.push({ id: stableId(`spotify:${name}`), name, trackIds: ids });
    }
  }
  return { tracks: [...tracks.values()], playlists };
}

/** Spotify's YourLibrary.json: a root whose `tracks` array holds {track, artist, uri} saved songs. */
function isSpotifyLibrary(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.tracks)
    && value.tracks.some((item) => isRecord(item) && typeof item.track === "string" && typeof item.artist === "string" && "uri" in item);
}

function parseSoundCloud(files: ImportTextFile[]): { tracks: AppleMusicTrack[]; playlists: AppleMusicPlaylist[] } {
  const tracks = new Map<string, AppleMusicTrack>();
  const playlists: AppleMusicPlaylist[] = [];
  for (const file of files) {
    if (/\.csv$/i.test(file.name)) {
      parseSoundCloudCsv(file, tracks);
      continue;
    }
    const value = parseJson(file);
    const likedFile = /like|favorite/i.test(file.name);
    const visit = (raw: unknown, playlistName?: string) => {
      if (!isRecord(raw)) return;
      const candidate = isRecord(raw.track) ? raw.track : raw;
      const title = string(candidate.title);
      const user = isRecord(candidate.user) ? candidate.user : undefined;
      const artist = string(candidate.artist ?? candidate.username ?? user?.username);
      if (!title || !artist) return;
      const sourceId = string(candidate.urn ?? candidate.id ?? candidate.permalink_url) || `${artist}:${title}`;
      const id = sourceTrackId("soundcloud", sourceId);
      addSourceTrack(tracks, {
        source: "soundcloud", sourceId, title, artist, album: string(candidate.album ?? (isRecord(candidate.publisher_metadata) ? candidate.publisher_metadata.album_title : "")),
        genre: string(candidate.genre), durationSec: number(candidate.duration) / 1000, playedAt: dateMs(raw.played_at ?? raw.lastPlayedAt),
        playIncrement: raw.played_at || raw.lastPlayedAt ? 1 : 0, liked: likedFile || Boolean(raw.liked), sourceUrl: string(candidate.permalink_url)
      });
      if (playlistName) return id;
    };
    for (const array of findArrays(value)) array.forEach((item) => visit(item));
    const root = isRecord(value) ? value : undefined;
    const rawPlaylists = Array.isArray(root?.playlists) ? root.playlists : [];
    for (const raw of rawPlaylists) {
      if (!isRecord(raw)) continue;
      const name = string(raw.title ?? raw.name) || "SoundCloud playlist";
      const ids = (Array.isArray(raw.tracks) ? raw.tracks : []).flatMap((item) => {
        const id = visit(item, name);
        return id ? [id] : [];
      });
      playlists.push({ id: stableId(`soundcloud:${name}`), name, trackIds: ids });
    }
  }
  return { tracks: [...tracks.values()], playlists };
}

/**
 * SoundCloud's Subject Access Request archive is CSV, unlike the JSON returned
 * by some API/export tools.  Its playlist export has no membership list, so we
 * intentionally import only track records that can be used in the library:
 * likes, listening history, and the user's own uploads.
 */
function parseSoundCloudCsv(file: ImportTextFile, tracks: Map<string, AppleMusicTrack>): void {
  // Browsers rename repeat downloads ("track-likes (1).csv"), so match the
  // archive's base names by prefix after dropping that suffix.
  const kind = /^(track-likes|play-history|tracks)/.exec(file.name.toLowerCase().replace(/\s*\(\d+\)(?=\.csv$)/, ""))?.[1];
  if (!kind) return;

  for (const row of parseCsv(file.text)) {
    const title = string(row.track_title ?? row.title);
    const sourceUrl = string(row.track_url ?? row.url);
    if (!title || !sourceUrl) continue;
    const sourceId = sourceUrl;
    const artist = soundCloudUrlOwner(sourceUrl) || "SoundCloud";
    const isPlay = kind === "play-history";
    addSourceTrack(tracks, {
      source: "soundcloud",
      sourceId,
      title,
      artist,
      album: "",
      genre: string(row.genre),
      durationSec: number(row.duration) / 1000,
      playedAt: isPlay ? dateMs(row.play_time) : undefined,
      playIncrement: isPlay ? 1 : 0,
      liked: kind === "track-likes",
      sourceUrl
    });
  }
}

function parseYouTubeMusic(files: ImportTextFile[]): { tracks: AppleMusicTrack[]; playlists: AppleMusicPlaylist[] } {
  const tracks = new Map<string, AppleMusicTrack>();
  const playlists: AppleMusicPlaylist[] = [];
  for (const file of files) {
    if (/\.csv$/i.test(file.name)) {
      const rows = parseCsv(file.text);
      const ids: string[] = [];
      for (const row of rows) {
        const title = string(row.Title ?? row.VideoTitle ?? row.Song);
        const artist = string(row.Artist ?? row.Channel ?? row.ArtistName);
        if (!title || !artist) continue;
        const sourceId = string(row.VideoId ?? row.URL ?? row.VideoURL) || `${artist}:${title}`;
        addSourceTrack(tracks, { source: "youtubeMusic", sourceId, title, artist, album: string(row.Album), liked: /like/i.test(file.name), sourceUrl: string(row.URL ?? row.VideoURL) });
        ids.push(sourceTrackId("youtubeMusic", sourceId));
      }
      if (/playlist/i.test(file.name) && ids.length) playlists.push({ id: stableId(file.name), name: file.name.replace(/\.csv$/i, ""), trackIds: ids });
      continue;
    }
    const value = parseJson(file);
    for (const array of findArrays(value)) {
      for (const raw of array) {
        if (!isRecord(raw)) continue;
        const products = Array.isArray(raw.products) ? raw.products.map(string) : [];
        const url = string(raw.titleUrl ?? raw.url);
        const musicSpecific = products.some((product) => /youtube music/i.test(product)) || /music\.youtube\.com/i.test(url) || /youtube.?music/i.test(file.name);
        if (!musicSpecific) continue;
        const title = string(raw.title).replace(/^Watched\s+/i, "").trim();
        const subtitles = Array.isArray(raw.subtitles) ? raw.subtitles : [];
        const firstSubtitle = isRecord(subtitles[0]) ? subtitles[0] : undefined;
        const artist = string(raw.artist ?? firstSubtitle?.name).replace(/\s+-\s+Topic$/i, "").trim();
        if (!title || !artist) continue;
        const sourceId = youtubeId(url) || `${artist}:${title}`;
        addSourceTrack(tracks, { source: "youtubeMusic", sourceId, title, artist, album: string(raw.album), playedAt: dateMs(raw.time), playIncrement: 1, sourceUrl: url });
      }
    }
  }
  return { tracks: [...tracks.values()], playlists };
}

interface AddTrackInput {
  source: ImportedMusicSource["source"];
  sourceId: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  durationSec?: number;
  playedAt?: number;
  playedMs?: number;
  playIncrement?: number;
  liked?: boolean;
  sourceUrl?: string;
}

function addSourceTrack(target: Map<string, AppleMusicTrack>, input: AddTrackInput): void {
  const id = sourceTrackId(input.source, input.sourceId);
  const current = target.get(id);
  const playIncrement = input.playIncrement ?? 0;
  const year = input.playedAt ? new Date(input.playedAt).getUTCFullYear().toString() : undefined;
  const stats: TrackSourceStats = current?.sourceStats?.[0] ?? {
    source: input.source,
    sourceTrackId: input.sourceId,
    sourceUrl: input.sourceUrl,
    playCount: 0,
    totalPlayMs: 0,
    playsByYear: {},
    liked: false,
    limitations: SOURCE_LIMITATIONS[input.source]
  };
  stats.playCount += playIncrement;
  stats.totalPlayMs = (stats.totalPlayMs ?? 0) + (input.playedMs ?? 0);
  stats.liked = Boolean(stats.liked || input.liked);
  if (year && playIncrement) stats.playsByYear = { ...(stats.playsByYear ?? {}), [year]: (stats.playsByYear?.[year] ?? 0) + playIncrement };
  if (input.playedAt) {
    stats.firstPlayedUnixMs = Math.min(stats.firstPlayedUnixMs ?? input.playedAt, input.playedAt);
    stats.lastPlayedUnixMs = Math.max(stats.lastPlayedUnixMs ?? 0, input.playedAt);
  }
  target.set(id, {
    id,
    title: current?.title || input.title,
    artist: current?.artist || input.artist,
    album: current?.album || input.album,
    albumArtist: current?.albumArtist || input.artist,
    genre: current?.genre || input.genre || "",
    durationSec: current?.durationSec || input.durationSec || 0,
    playCount: stats.playCount,
    lastPlayedUnixMs: stats.lastPlayedUnixMs,
    likeStatus: stats.liked ? 1 : 0,
    sourceStats: [stats]
  });
}

function withSourceStats(track: AppleMusicTrack, source: MusicSource): AppleMusicTrack {
  if (track.sourceStats?.length) return track;
  return {
    ...track,
    sourceStats: [{
      source,
      sourceTrackId: track.id,
      playCount: track.playCount,
      lastPlayedUnixMs: track.lastPlayedUnixMs,
      liked: track.likeStatus > 0,
      inAppleLibrary: source === "apple" && track.inAppleLibrary !== false,
      limitations: SOURCE_LIMITATIONS[source]
    }]
  };
}

function mergeTrack(target: Map<string, AppleMusicTrack>, incoming: AppleMusicTrack): void {
  const safeKey = safeDedupKey(incoming);
  const current = target.get(safeKey);
  if (!current) {
    target.set(safeKey, { ...incoming, id: stableId(safeKey) });
    return;
  }
  const stats = [...(current.sourceStats ?? [])];
  for (const source of incoming.sourceStats ?? []) {
    const existing = stats.find((item) => item.source === source.source && item.sourceTrackId === source.sourceTrackId);
    if (!existing) stats.push(source);
  }
  target.set(safeKey, {
    ...current,
    genre: current.genre || incoming.genre,
    artworkPath: current.artworkPath || incoming.artworkPath,
    durationSec: current.durationSec || incoming.durationSec,
    playCount: stats.reduce((sum, item) => sum + item.playCount, 0),
    lastPlayedUnixMs: Math.max(...stats.map((item) => item.lastPlayedUnixMs ?? 0)) || undefined,
    likeStatus: stats.some((item) => item.liked) ? 1 : Math.max(current.likeStatus, incoming.likeStatus),
    sourceStats: stats
  });
}

function safeDedupKey(track: AppleMusicTrack): string {
  const base = `${normalize(track.artist)}::${normalize(track.title)}`;
  if (track.album.trim()) return `${base}::${normalize(track.album)}`;
  return `${base}::${track.durationSec ? Math.round(track.durationSec / 3) : track.sourceStats?.[0]?.source ?? "unknown"}`;
}

function sourceTrackId(source: MusicSource, raw: string): string {
  return `${source}:${stableId(raw)}`;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (const character of value.toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Same key rule as appleMusic.ts normalize: Unicode letters survive, so non-Latin tracks do not collapse into one dedup key. */
function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

function parseJson(file: ImportTextFile): unknown {
  try {
    return JSON.parse(file.text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${file.name} is not valid JSON.`);
  }
}

function findArrays(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).filter(Array.isArray) as unknown[][];
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(field); field = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "").trim()) ?? [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ""])));
}

function youtubeId(url: string): string {
  return /[?&]v=([^&]+)/.exec(url)?.[1] ?? /youtu\.be\/([^?]+)/.exec(url)?.[1] ?? "";
}

function soundCloudUrlOwner(sourceUrl: string): string {
  try {
    const owner = new URL(sourceUrl).pathname.split("/").filter(Boolean)[0] ?? "";
    return decodeURIComponent(owner).replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value.includes("T") || /Z$/.test(value) ? value : `${value.replace(" ", "T")}:00Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
