import type { AppleMusicTrack, MusicSource } from "../library/appleMusic";
import type { CdBurnItem, CuratorMemory } from "../project/catalog";

export interface CuratorChoice {
  track: AppleMusicTrack;
  score: number;
  explanation: string;
  citations: string[];
}

export interface CuratorResult {
  title: string;
  choices: CuratorChoice[];
  memory: CuratorMemory;
  reply: string;
  replaceExisting: boolean;
}

const GENRE_ALIASES: Record<string, string[]> = {
  "heavy metal": ["heavy metal", "metal", "thrash", "doom", "sludge", "death metal", "black metal"],
  grunge: ["grunge", "alternative rock", "seattle"],
  punk: ["punk", "hardcore"],
  hiphop: ["hip hop", "hip-hop", "rap"],
  electronic: ["electronic", "electronica", "techno", "house", "ambient"]
};

export function curateMix(
  prompt: string,
  tracks: AppleMusicTrack[],
  memory: CuratorMemory,
  existingQueue: CdBurnItem[] = []
): CuratorResult {
  const nextMemory = updateMemory(prompt, memory);
  const year = Number(/\b(20\d{2})\b/.exec(prompt)?.[1]) || undefined;
  const requestedGenre = findGenre(prompt, tracks);
  const requestedCount = clamp(Number(/\b(\d{1,2})(?:\s+\w+){0,2}\s+(?:songs?|tracks?)\b/i.exec(prompt)?.[1]) || 14, 1, 30);
  const replacement = /\b(replace|swap|instead|don'?t like|do not like|less of)\b/i.test(prompt) && existingQueue.length > 0;
  const disliked = new Set(nextMemory.dislikedArtists.map(normalize));
  const scored = tracks
    .filter((track) => track.title.trim() && track.artist.trim())
    .filter((track) => !disliked.has(normalize(track.artist)))
    .map((track) => scoreTrack(track, requestedGenre, year, nextMemory.preferredGenres))
    .filter((choice) => choice.score > (requestedGenre ? 0 : -20))
    .sort((left, right) => right.score - left.score || left.track.title.localeCompare(right.track.title));

  const preserved = replacement
    ? existingQueue.filter((item) => !disliked.has(normalize(item.artist)))
    : [];
  const preservedKeys = new Set(preserved.map((item) => trackKey(item.artist, item.title)));
  const targetCount = replacement ? Math.max(existingQueue.length, requestedCount) : requestedCount;
  const artistCounts = new Map<string, number>();
  preserved.forEach((item) => artistCounts.set(normalize(item.artist), (artistCounts.get(normalize(item.artist)) ?? 0) + 1));
  let seconds = preserved.reduce((sum, item) => sum + item.durationSec, 0);
  const choices: CuratorChoice[] = [];
  for (const choice of scored) {
    if (preserved.length + choices.length >= targetCount) break;
    const key = trackKey(choice.track.artist, choice.track.title);
    const artistKey = normalize(choice.track.artist);
    if (preservedKeys.has(key) || (artistCounts.get(artistKey) ?? 0) >= 2) continue;
    const duration = choice.track.durationSec || 240;
    if (seconds + duration > 4_800) continue;
    choices.push(choice);
    seconds += duration;
    artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
  }

  const qualifier = [year ? `${year}` : "", requestedGenre].filter(Boolean).join(" ");
  const title = replacement
    ? memory.lastProjectName || "Curated MXTP"
    : `${qualifier ? `${titleCase(qualifier)} ` : ""}MXTP`;
  const citations = choices.flatMap((choice) => choice.citations);
  const reply = choices.length
    ? `${replacement ? "I kept the parts that still fit and replaced the conflicts" : "Here's a mix"} with ${preserved.length + choices.length} tracks. ${summarizeEvidence(choices)}${citations.length ? " See Sources and evidence below." : ""}`
    : "I couldn't find enough eligible tracks in the enabled libraries. Try enabling another source or relaxing the year/genre request.";
  return {
    title,
    choices,
    memory: { ...nextMemory, lastProjectName: title, lastPrompt: prompt },
    reply,
    replaceExisting: replacement
  };
}

export function choicesToQueue(choices: CuratorChoice[]): CdBurnItem[] {
  return choices.map(({ track }) => ({
    id: track.id,
    albumKey: `${normalize(track.albumArtist || track.artist)}::${normalize(track.album)}`,
    title: track.title,
    artist: track.artist,
    album: track.album || "Unknown release",
    durationSec: track.durationSec || 240,
    trackNumber: track.trackNumber,
    sourceStats: track.sourceStats
  }));
}

function scoreTrack(track: AppleMusicTrack, genre: string | undefined, year: number | undefined, preferred: string[]): CuratorChoice {
  const stats = track.sourceStats ?? [];
  const yearPlays = year ? stats.reduce((sum, item) => sum + (item.playsByYear?.[String(year)] ?? 0), 0) : 0;
  const liked = stats.some((item) => item.liked) || track.likeStatus > 0;
  const lastYear = track.lastPlayedUnixMs ? new Date(track.lastPlayedUnixMs).getUTCFullYear() : undefined;
  const genreMatch = genre ? genreAliases(genre).some((alias) => normalize(track.genre).includes(normalize(alias))) : false;
  const preferenceMatch = preferred.some((item) => genreAliases(item).some((alias) => normalize(track.genre).includes(normalize(alias))));
  let score = Math.log1p(track.playCount) * 5 + (liked ? 12 : 0) + (track.rating ?? 0) / 10;
  if (year) score += yearPlays * 10 + (lastYear === year ? 6 : 0) - (yearPlays === 0 && lastYear !== year ? 12 : 0);
  if (genre) score += genreMatch ? 35 : -28;
  if (preferenceMatch) score += 6;
  const evidence: string[] = [];
  if (yearPlays) evidence.push(`${yearPlays} play${yearPlays === 1 ? "" : "s"} in ${year}`);
  else if (track.playCount) evidence.push(`${track.playCount} recorded play${track.playCount === 1 ? "" : "s"}`);
  if (liked) evidence.push("liked/saved");
  if (genreMatch) evidence.push(`${track.genre || genre} genre match`);
  if (lastYear === year && !yearPlays) evidence.push(`last played in ${year}`);
  if (evidence.length === 0) evidence.push("library match");
  return {
    track,
    score,
    explanation: evidence.join(" · "),
    citations: stats.map((item) => sourceCitation(item.source, item.playCount, item.liked, year ? item.playsByYear?.[String(year)] : undefined))
  };
}

function updateMemory(prompt: string, memory: CuratorMemory): CuratorMemory {
  const dislikes = [...memory.dislikedArtists];
  const dislikePattern = /(?:don'?t like|do not like|no more|avoid)\s+([^.;,!]+)(?=[.;,!]|$)/gi;
  for (const match of prompt.matchAll(dislikePattern)) {
    const value = match[1].replace(/\b(?:songs?|tracks?|music|please)\b/gi, "").trim();
    if (value && !dislikes.some((item) => normalize(item) === normalize(value))) dislikes.push(value);
  }
  const genre = findGenre(prompt, []);
  const preferredGenres = genre && /\b(more|ultimate|make|give|prefer|like)\b/i.test(prompt)
    ? Array.from(new Set([...memory.preferredGenres, genre]))
    : memory.preferredGenres;
  return { ...memory, dislikedArtists: dislikes, preferredGenres };
}

function findGenre(prompt: string, tracks: AppleMusicTrack[]): string | undefined {
  const lower = prompt.toLocaleLowerCase();
  for (const [genre, aliases] of Object.entries(GENRE_ALIASES)) {
    if ([genre, ...aliases].some((alias) => lower.includes(alias))) return genre;
  }
  return tracks.map((track) => track.genre).filter(Boolean).sort((left, right) => right.length - left.length).find((genre) => lower.includes(genre.toLocaleLowerCase()));
}

function genreAliases(genre: string): string[] {
  return GENRE_ALIASES[genre] ?? [genre];
}

function sourceCitation(source: MusicSource, plays: number, liked?: boolean, yearPlays?: number): string {
  const label = source === "youtubeMusic" ? "YouTube Music" : titleCase(source);
  const detail = yearPlays ? `${yearPlays} dated plays` : plays ? `${plays} plays` : liked ? "liked/saved" : "library record";
  return `${label}: ${detail}`;
}

function summarizeEvidence(choices: CuratorChoice[]): string {
  const liked = choices.filter((choice) => choice.track.sourceStats?.some((item) => item.liked)).length;
  const plays = choices.reduce((sum, choice) => sum + choice.track.playCount, 0);
  return `The ranking used ${plays.toLocaleString()} recorded plays${liked ? ` and ${liked} ${liked === 1 ? "like" : "likes"}` : ""}.`;
}

function trackKey(artist: string, title: string): string {
  return `${normalize(artist)}::${normalize(title)}`;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
