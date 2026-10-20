// Fixture music for the lib-* native specs. All names are invented; all audio
// is synthesized sine tones (see lib.mjs writeToneWav and yt-dlp-stub.mjs).
const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 1) / 1000);

/** The Oscillators - Sine Wave Suite: 3 owned tracks with Apple artwork, most recently played. */
export const SINE_WAVE_SUITE = [
  { id: 1001, title: "Alpha Tone", track: 1, durationMs: 120_000, plays: 10, like: 2 },
  { id: 1002, title: "Beta Tone", track: 2, durationMs: 180_000, plays: 20 },
  { id: 1003, title: "Gamma Tone", track: 3, durationMs: 240_000, plays: 30 }
].map((track) => ({
  ...track,
  artist: "The Oscillators",
  album: "Sine Wave Suite",
  albumArtist: "The Oscillators",
  genre: "Electronic",
  year: 2019,
  lastPlayedUnix: NOW - DAY,
  art: [40, 170, 220]
}));

/** Night Owl - Quiet Hours: most played, no artwork, not on YouTube as an album. */
export const QUIET_HOURS = [
  { id: 2001, title: "Midnight", track: 1, durationMs: 200_000, plays: 300 },
  { id: 2002, title: "Dawn", track: 2, durationMs: 210_000, plays: 250 }
].map((track) => ({
  ...track,
  artist: "Night Owl",
  album: "Quiet Hours",
  genre: "Ambient",
  year: 2021,
  lastPlayedUnix: NOW - 3 * DAY
}));

/** Marathon Band - Long Player: two 45-minute tracks, together over an 80-minute CD. */
export const LONG_PLAYER = [
  { id: 3001, title: "First Side", track: 1, durationMs: 45 * 60_000, plays: 1 },
  { id: 3002, title: "Second Side", track: 2, durationMs: 45 * 60_000, plays: 1 }
].map((track) => ({
  ...track,
  artist: "Marathon Band",
  album: "Long Player",
  genre: "Drone",
  year: 2015,
  lastPlayedUnix: NOW - 5 * DAY
}));

/** First by artist sort ("Aardvark Trio"), last by album title. */
export const ZEBRA_CROSSING = [{
  id: 4001, title: "Stripes", track: 1, durationMs: 150_000, plays: 2,
  artist: "Aardvark Trio", album: "Zebra Crossing", genre: "Jazz", year: 2001, lastPlayedUnix: NOW - 30 * DAY
}];

/** First by album title ("Absolute Zero"), last by artist. */
export const ABSOLUTE_ZERO = [{
  id: 5001, title: "Kelvin", track: 1, durationMs: 160_000, plays: 3,
  artist: "Zed Quartet", album: "Absolute Zero", genre: "Jazz", year: 2003, lastPlayedUnix: NOW - 31 * DAY
}];

/** Enough single-track albums to push the grid past its 60-card page. */
export function fillerAlbums(count) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      id: 9000 + index,
      title: `Filler Song ${number}`,
      track: 1,
      durationMs: 100_000,
      plays: 0,
      artist: `Filler Artist ${number}`,
      album: `Filler Album ${number}`,
      genre: "Test Pattern",
      year: 2000,
      lastPlayedUnix: NOW - (60 + index) * DAY
    };
  });
}

export const SINE_PLAYLIST_URL = "https://www.youtube.com/playlist?list=OLAK5uy_e2eSineWaveSuite";

/**
 * The only YouTube that exists in these tests. Sine Wave Suite's release has a
 * music-video duplicate at position 2 (must never be downloaded) and a bonus
 * track at position 5. Night Owl has no album playlist: Midnight exists as an
 * official audio upload, Dawn only as a music video (must be rejected).
 */
export function youtubeCatalog({ cover } = {}) {
  return {
    albums: [{
      url: SINE_PLAYLIST_URL,
      title: "Sine Wave Suite",
      channel: "The Oscillators",
      artist: "The Oscillators",
      album: "Sine Wave Suite",
      cover,
      entries: [
        { title: "Alpha Tone", duration: 120 },
        { title: "Alpha Tone (Official Music Video)", duration: 125 },
        { title: "Beta Tone", duration: 180 },
        { title: "Gamma Tone", duration: 240 },
        { title: "Delta Tone", duration: 200 }
      ]
    }],
    videos: [
      { url: "https://www.youtube.com/watch?v=e2eMidnight", title: "Night Owl - Midnight (Official Audio)", channel: "Night Owl - Topic", duration: 200, query: "Night Owl Midnight" },
      { url: "https://www.youtube.com/watch?v=e2eDawnVideo", title: "Night Owl - Dawn (Official Music Video)", channel: "Night Owl", duration: 214, query: "Night Owl Dawn" }
    ]
  };
}
