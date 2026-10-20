import { describe, expect, it } from "vitest";
import type { CdProject } from "../project/catalog";
import { albumKey, albumsFromLibrary, downloadedTracksForAlbum, isAppleLibraryTrack, isLikedTrack, normalizeTrackTitle, readyTracksForAlbum, type AppleMusicLibraryData } from "./appleMusic";

const library: AppleMusicLibraryData = {
  sourcePath: "C:/Music/Library.musicdb",
  version: "1.6.4.90",
  summary: { trackCount: 3, albumCount: 2, artistCount: 2, playlistCount: 0, totalPlays: 20, artworkTrackCount: 3 },
  tracks: [
    { id: "a2", title: "Second", artist: "Artist A", album: "Alpha", albumArtist: "Artist A", genre: "Rap", trackNumber: 2, durationSec: 120, playCount: 3, lastPlayedUnixMs: 200, likeStatus: 0, artworkPath: "C:/art/a.jpg" },
    { id: "a1", title: "First", artist: "Artist A", album: "Alpha", albumArtist: "Artist A", genre: "Rap", trackNumber: 1, durationSec: 180, playCount: 12, lastPlayedUnixMs: 300, likeStatus: 2, artworkPath: "C:/art/a.jpg" },
    { id: "b1", title: "Only", artist: "Artist B", album: "Beta", albumArtist: "Artist B", genre: "Rock", trackNumber: 1, durationSec: 200, playCount: 5, lastPlayedUnixMs: 100, likeStatus: 0, artworkPath: "C:/art/b.jpg" }
  ],
  playlists: []
};

describe("Apple Music library model", () => {
  it("groups track records into ordered albums and sorts them from listening data", () => {
    const albums = albumsFromLibrary(library);
    expect(albums.map((album) => album.title)).toEqual(["Alpha", "Beta"]);
    expect(albums[0].tracks.map((track) => track.title)).toEqual(["First", "Second"]);
    expect(albums[0]).toMatchObject({ durationSec: 300, playCount: 15, artworkPath: "C:/art/a.jpg" });
  });

  it("shows SoundCloud tracks without album metadata as individually identifiable source tracks", () => {
    const albums = albumsFromLibrary({
      ...library,
      tracks: [{
        ...library.tracks[0], id: "soundcloud-track", title: "Loose track", album: "", albumArtist: "", playCount: 4,
        sourceStats: [{ source: "soundcloud", sourceTrackId: "soundcloud:one", playCount: 4, liked: true }]
      }]
    });

    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({
      key: "source-track:soundcloud:soundcloud-track",
      title: "Loose track",
      artist: "Artist A",
      sourceCollection: "soundcloud",
      sourceTrack: true,
      tracks: [expect.objectContaining({ title: "Loose track" })]
    });
  });

  it("orders multi-disc albums by disc, track, then title while treating legacy missing discs as disc one", () => {
    const tracks = [
      { ...library.tracks[0], id: "disc-2-track-1", title: "Disc Two Opener", discNumber: 2, trackNumber: 1 },
      { ...library.tracks[0], id: "disc-1-track-2", title: "Disc One Second", discNumber: 1, trackNumber: 2 },
      { ...library.tracks[0], id: "legacy-disc-1-track-1", title: "Disc One Opener", discNumber: undefined, trackNumber: 1 },
      { ...library.tracks[0], id: "disc-1-untagged-z", title: "Zulu", discNumber: 1, trackNumber: undefined },
      { ...library.tracks[0], id: "disc-1-untagged-a", title: "Alpha", discNumber: 1, trackNumber: undefined }
    ];

    const [album] = albumsFromLibrary({
      ...library,
      summary: { ...library.summary, trackCount: tracks.length, albumCount: 1 },
      tracks
    });

    expect(album.tracks.map((track) => track.id)).toEqual([
      "legacy-disc-1-track-1",
      "disc-1-track-2",
      "disc-1-untagged-a",
      "disc-1-untagged-z",
      "disc-2-track-1"
    ]);
  });

  it("marks only cached MXTP audio as ready", () => {
    const project = {
      entry: { artist: "Artist A", album: "Alpha" },
      tracks: [{ id: "cached", title: "First (Official Audio)", durationSec: 180, path: "C:/cache/first.opus" }]
    } as CdProject;
    const ready = readyTracksForAlbum([project], albumsFromLibrary(library)[0]);
    expect(ready.get("a1")?.path).toBe("C:/cache/first.opus");
    expect(ready.has("a2")).toBe(false);
  });

  it("reconnects a title-only recovered download and keeps the complete release separate from liked songs", () => {
    const album = albumsFromLibrary({
      ...library,
      tracks: library.tracks.map((track) => track.id === "a2" ? { ...track, title: "Second (feat. Guest)" } : track)
    })[0];
    const recovered = {
      entry: { artist: "", album: "Alpha" },
      tracks: [
        { id: "one", title: "Artist A - First", durationSec: 180, path: "C:/cache/001.opus" },
        { id: "two", title: "Artist A - Second", durationSec: 120, path: "C:/cache/002.opus" },
        { id: "bonus", title: "Artist A - Bonus", durationSec: 160, path: "C:/cache/002.opus" },
        { id: "bonus-video", title: "Artist A - Bonus [Official Music Video]", durationSec: 212, path: "C:/cache/003.opus" },
        { id: "video-only", title: "Artist A - Visual Only (Official Music Video)", durationSec: 155, path: "C:/cache/004.opus" },
        { id: "other-project", title: "Unrelated Mix Song", artist: "Other Artist", album: "Other Album", durationSec: 200, path: "C:/cache/other.opus" }
      ],
      burnQueue: []
    } as unknown as CdProject;

    const downloaded = downloadedTracksForAlbum([recovered], album);
    expect(downloaded.map((item) => item.title)).toEqual(["First", "Second (feat. Guest)", "Bonus"]);
    expect(readyTracksForAlbum([recovered], album).get("a1")?.path).toContain("001.opus");
    expect(album.tracks.filter(isLikedTrack).map((track) => track.title)).toEqual(["First"]);
  });

  it("treats the Apple library as the liked-song scope, not favourite flags from other sources", () => {
    const tracks = [
      { ...library.tracks[0], inAppleLibrary: true, likeStatus: 0 },
      {
        ...library.tracks[1],
        inAppleLibrary: false,
        likeStatus: 1,
        sourceStats: [{ source: "spotify" as const, sourceTrackId: "spotify-second", playCount: 1, liked: true }]
      }
    ];

    expect(tracks.filter(isAppleLibraryTrack).map((track) => track.title)).toEqual(["Second"]);
    expect(tracks.filter(isLikedTrack).map((track) => track.title)).toEqual(["First"]);
  });

  it("keeps ASCII and accented Latin keys unchanged", () => {
    expect(albumKey("Daft Punk", "Discovery")).toBe("daftpunk::discovery");
    expect(albumKey("Sigur Rós", "Ágætis byrjun")).toBe("sigurros::agætisbyrjun");
    expect(albumKey("Beyoncé", "4")).toBe("beyonce::4");
    expect(albumKey("ＡＢＣ", "Ⅻ ﬁve")).toBe("abc::xiifive");
    expect(normalizeTrackTitle("01 - First (Official Audio)")).toBe("first");
  });

  it("gives Japanese and Cyrillic albums distinct, non-empty keys and separate album cards", () => {
    const japanese = albumKey("宇多田ヒカル", "初恋");
    const cyrillic = albumKey("Кино", "Группа крови");
    const otherCyrillic = albumKey("Кино", "Звезда по имени Солнце");
    expect(japanese).toBe("宇多田ヒカル::初恋");
    expect(cyrillic).toBe("кино::группакрови");
    expect(new Set([japanese, cyrillic, otherCyrillic]).size).toBe(3);
    // Kana voicing marks are part of the word, not an accent.
    expect(albumKey("", "バード")).not.toBe(albumKey("", "ハード"));
    expect(normalizeTrackTitle("Звезда")).toBe("звезда");

    const albums = albumsFromLibrary({
      ...library,
      tracks: [
        { ...library.tracks[0], id: "jp", title: "First Love", artist: "宇多田ヒカル", albumArtist: "宇多田ヒカル", album: "初恋" },
        { ...library.tracks[0], id: "ru-1", title: "Группа крови", artist: "Кино", albumArtist: "Кино", album: "Группа крови" },
        { ...library.tracks[0], id: "ru-2", title: "Звезда по имени Солнце", artist: "Кино", albumArtist: "Кино", album: "Звезда по имени Солнце" }
      ]
    });
    expect(albums.map((album) => album.title).sort()).toEqual(["Группа крови", "Звезда по имени Солнце", "初恋"]);
  });
});
