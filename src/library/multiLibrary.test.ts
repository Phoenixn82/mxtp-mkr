import { describe, expect, it } from "vitest";
import { combineMusicLibraries, parseMusicExport } from "./multiLibrary";
import type { AppleMusicLibraryData } from "./appleMusic";

describe("multi-library imports", () => {
  it("imports Spotify extended history with dated plays and saved state", () => {
    const history = JSON.stringify([
      { ts: "2026-02-01T12:00:00Z", ms_played: 180000, master_metadata_track_name: "Rust", master_metadata_album_artist_name: "Low", master_metadata_album_album_name: "Things We Lost", spotify_track_uri: "spotify:track:one" },
      { ts: "2026-02-02T12:00:00Z", ms_played: 180000, master_metadata_track_name: "Rust", master_metadata_album_artist_name: "Low", master_metadata_album_album_name: "Things We Lost", spotify_track_uri: "spotify:track:one" }
    ]);
    const saved = JSON.stringify({ tracks: [{ track: "Rust", artist: "Low", album: "Things We Lost", uri: "spotify:track:one" }] });
    const result = parseMusicExport("spotify", [{ name: "Streaming_History_Audio_2026.json", text: history }, { name: "YourLibrary.json", text: saved }], new Date("2026-08-26T00:00:00Z"));
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].playCount).toBe(2);
    expect(result.tracks[0].sourceStats?.[0].playsByYear?.["2026"]).toBe(2);
    expect(result.tracks[0].sourceStats?.[0].liked).toBe(true);
  });

  it("imports only music-specific Google Takeout history", () => {
    const history = JSON.stringify([
      { title: "Watched Stone", titleUrl: "https://music.youtube.com/watch?v=music1", time: "2026-03-02T10:00:00Z", products: ["YouTube Music"], subtitles: [{ name: "Alice in Chains - Topic" }] },
      { title: "Watched Cat video", titleUrl: "https://youtube.com/watch?v=cat", time: "2026-03-03T10:00:00Z", products: ["YouTube"] }
    ]);
    const result = parseMusicExport("youtubeMusic", [{ name: "watch-history.json", text: history }]);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ title: "Stone", artist: "Alice in Chains", playCount: 1 });
  });

  it("imports SoundCloud's CSV account archive without treating public track stats as personal plays", () => {
    const likes = [
      "like_time,track_title,track_url",
      "2026-02-01 12:00:00 UTC,First Song,https://soundcloud.com/a-creator/first-song"
    ].join("\n");
    const history = [
      "play_time,track_title,track_url",
      "2026-02-02 12:00:00 UTC,First Song,https://soundcloud.com/a-creator/first-song",
      "2026-02-03 12:00:00 UTC,First Song,https://soundcloud.com/a-creator/first-song"
    ].join("\n");
    const uploads = [
      "title,url,genre,duration,plays_count",
      "My Upload,https://soundcloud.com/a-creator/my-upload,Electronic,190000,999999"
    ].join("\n");

    const result = parseMusicExport("soundcloud", [
      { name: "track-likes.csv", text: likes },
      { name: "play-history.csv", text: history },
      { name: "tracks.csv", text: uploads }
    ]);

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks.find((track) => track.title === "First Song")).toMatchObject({
      artist: "a creator",
      playCount: 2,
      likeStatus: 1,
      sourceStats: [{ source: "soundcloud", liked: true, playsByYear: { "2026": 2 } }]
    });
    expect(result.tracks.find((track) => track.title === "My Upload")).toMatchObject({
      genre: "Electronic",
      durationSec: 190,
      playCount: 0
    });
  });

  it("keeps provenance while safely deduplicating exact artist-title-album matches", () => {
    const apple: AppleMusicLibraryData = {
      sourcePath: "Library.musicdb", version: "1",
      summary: { trackCount: 1, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 8, artworkTrackCount: 0 },
      playlists: [],
      tracks: [{ id: "apple-one", title: "Rust", artist: "Low", album: "Things We Lost", albumArtist: "Low", genre: "Slowcore", durationSec: 201, playCount: 8, likeStatus: 0 }]
    };
    const spotify = parseMusicExport("spotify", [{ name: "history.json", text: JSON.stringify([{ ts: "2026-01-01T00:00:00Z", ms_played: 200000, master_metadata_track_name: "Rust", master_metadata_album_artist_name: "Low", master_metadata_album_album_name: "Things We Lost", spotify_track_uri: "spotify:track:one" }]) }]);
    const combined = combineMusicLibraries(apple, [spotify], new Set(["apple", "spotify"]));
    expect(combined.tracks).toHaveLength(1);
    expect(combined.tracks[0].playCount).toBe(9);
    expect(combined.tracks[0].sourceStats?.map((item) => item.source)).toEqual(["apple", "spotify"]);
    expect(combined.summary.totalPlays).toBe(9);
  });

  it("uses a uniquely titled local Apple track to supply missing release metadata for an imported track", () => {
    const apple: AppleMusicLibraryData = {
      sourcePath: "Library.musicdb", version: "1",
      summary: { trackCount: 1, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 8, artworkTrackCount: 1 },
      playlists: [],
      tracks: [{ id: "apple-one", title: "Yung Bratz", artist: "XXXTENTACION", album: "Revenge", albumArtist: "XXXTENTACION", genre: "Hip-Hop", trackNumber: 4, year: 2017, durationSec: 111, playCount: 8, likeStatus: 0, artworkPath: "/art/revenge.jpg" }]
    };
    const soundCloud = parseMusicExport("soundcloud", [{
      name: "track-likes.csv",
      text: "like_time,track_title,track_url\n2026-02-01 12:00:00 UTC,Yung Bratz,https://soundcloud.com/jahseh-onfroy/xxxtentacion-yung-bratz"
    }]);

    const combined = combineMusicLibraries(apple, [soundCloud], new Set(["apple", "soundcloud"]));
    expect(combined.tracks).toHaveLength(1);
    expect(combined.tracks[0]).toMatchObject({ album: "Revenge", artworkPath: "/art/revenge.jpg" });
    expect(combined.tracks[0].sourceStats?.map((stat) => stat.source)).toEqual(["apple", "soundcloud"]);
  });

  it("changes combined counts when sources are toggled", () => {
    const spotify = parseMusicExport("spotify", [{ name: "history.json", text: JSON.stringify([{ ts: "2026-01-01T00:00:00Z", ms_played: 200000, master_metadata_track_name: "One", master_metadata_album_artist_name: "Band", master_metadata_album_album_name: "Record", spotify_track_uri: "spotify:track:one" }]) }]);
    expect(combineMusicLibraries(null, [spotify], new Set(["spotify"])).summary.trackCount).toBe(1);
    expect(combineMusicLibraries(null, [spotify], new Set()).summary.trackCount).toBe(0);
  });

  it("keeps every track of a Cyrillic-only library", () => {
    const apple: AppleMusicLibraryData = {
      sourcePath: "Library.musicdb", version: "1",
      summary: { trackCount: 3, albumCount: 2, artistCount: 1, playlistCount: 0, totalPlays: 3, artworkTrackCount: 0 },
      playlists: [],
      tracks: [
        { id: "ru-1", title: "Группа крови", artist: "Кино", album: "Группа крови", albumArtist: "Кино", genre: "", durationSec: 286, playCount: 1, likeStatus: 0 },
        { id: "ru-2", title: "Закрой за мной дверь", artist: "Кино", album: "Группа крови", albumArtist: "Кино", genre: "", durationSec: 260, playCount: 1, likeStatus: 0 },
        { id: "ru-3", title: "Звезда по имени Солнце", artist: "Кино", album: "Звезда по имени Солнце", albumArtist: "Кино", genre: "", durationSec: 225, playCount: 1, likeStatus: 0 }
      ]
    };
    const combined = combineMusicLibraries(apple, [], new Set(["apple"]));
    expect(combined.tracks).toHaveLength(3);
    expect(new Set(combined.tracks.map((track) => track.id)).size).toBe(3);
    expect(combined.summary).toMatchObject({ trackCount: 3, albumCount: 2, artistCount: 1 });
  });

  it("marks only the saved tracks of a Spotify library file liked, whatever the file is called", () => {
    const library = JSON.stringify({
      tracks: [{ track: "Rust", artist: "Low", album: "Things We Lost", uri: "spotify:track:one" }],
      bannedTracks: [{ track: "Skip Me", artist: "Nobody", album: "Never", uri: "spotify:track:banned" }],
      other: [{ track: "Elsewhere", artist: "Someone", album: "Other", uri: "spotify:track:other" }]
    });
    const result = parseMusicExport("spotify", [{ name: "library.json", text: library }]);
    expect(result.tracks.map((track) => track.title).sort()).toEqual(["Elsewhere", "Rust"]);
    expect(result.tracks.find((track) => track.title === "Rust")?.likeStatus).toBe(1);
    expect(result.tracks.find((track) => track.title === "Elsewhere")?.likeStatus).toBe(0);

    const history = JSON.stringify([{ ts: "2026-01-01T00:00:00Z", ms_played: 200000, master_metadata_track_name: "One", master_metadata_album_artist_name: "Band", master_metadata_album_album_name: "Record", spotify_track_uri: "spotify:track:h" }]);
    const fromHistory = parseMusicExport("spotify", [{ name: "my-library-history.json", text: history }]);
    expect(fromHistory.tracks[0].likeStatus).toBe(0);

    const renamed = parseMusicExport("spotify", [{ name: "saved.json", text: library }]);
    expect(renamed.tracks.find((track) => track.title === "Rust")?.likeStatus).toBe(1);
  });

  it("imports SoundCloud CSVs that the browser renamed on download", () => {
    const result = parseMusicExport("soundcloud", [
      { name: "track-likes (1).csv", text: "like_time,track_title,track_url\n2026-02-01 12:00:00 UTC,First Song,https://soundcloud.com/a-creator/first-song" },
      { name: "Play-History (2).csv", text: "play_time,track_title,track_url\n2026-02-02 12:00:00 UTC,First Song,https://soundcloud.com/a-creator/first-song" },
      { name: "notes.csv", text: "track_title,track_url\nIgnored,https://soundcloud.com/x/ignored" }
    ]);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ title: "First Song", likeStatus: 1, playCount: 1 });
  });
});
