import { describe, expect, it } from "vitest";
import type { AppleMusicTrack } from "../library/appleMusic";
import { curateMix } from "./curator";

const tracks: AppleMusicTrack[] = [
  track("soad", "Chop Suey!", "System of a Down", "Toxicity", "Heavy Metal", 20, 4),
  track("aic", "Would?", "Alice in Chains", "Dirt", "Grunge", 14, 8),
  track("sound", "Outshined", "Soundgarden", "Badmotorfinger", "Grunge", 10, 7),
  track("sabbath", "War Pigs", "Black Sabbath", "Paranoid", "Heavy Metal", 30, 6)
];

describe("on-device curator", () => {
  it("ranks dated favorites and cites source evidence", () => {
    const result = curateMix("Make a mixtape of my 2 favorite tracks from 2026", tracks, memory());
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0].track.title).toBe("Would?");
    expect(result.choices[0].explanation).toContain("8 plays in 2026");
    expect(result.choices[0].citations[0]).toContain("Spotify");
  });

  it("replies in plain words that point at the Sources and evidence list", () => {
    const fresh = curateMix("Give me the ultimate heavy metal mixtape", tracks, memory());
    const replaced = curateMix("I don't like System of a Down; replace those songs with 2 tracks that are more grunge", tracks, memory(), [
      { id: "soad", albumKey: "systemofadown::toxicity", title: "Chop Suey!", artist: "System of a Down", album: "Toxicity", durationSec: 210 }
    ]);
    expect(fresh.reply).toMatch(/^Here's a mix with 2 tracks\./);
    expect(fresh.reply).toContain("and 2 likes.");
    for (const { reply } of [fresh, replaced]) {
      expect(reply).not.toMatch(/source badges|ranked mix|liked\/saved/);
      expect(reply).toContain("See Sources and evidence below.");
    }
  });

  it("remembers a disliked artist and replaces it with requested grunge", () => {
    const existing = [{ id: "soad", albumKey: "systemofadown::toxicity", title: "Chop Suey!", artist: "System of a Down", album: "Toxicity", durationSec: 210 }];
    const result = curateMix("I don't like System of a Down; replace those songs with 2 tracks that are more grunge", tracks, memory(), existing);
    expect(result.replaceExisting).toBe(true);
    expect(result.memory.dislikedArtists).toContain("System of a Down");
    expect(result.choices.every((choice) => choice.track.artist !== "System of a Down")).toBe(true);
    expect(result.choices[0].track.genre).toBe("Grunge");
  });
});

function track(id: string, title: string, artist: string, album: string, genre: string, plays: number, yearPlays: number): AppleMusicTrack {
  return {
    id, title, artist, album, albumArtist: artist, genre, durationSec: 210, playCount: plays, likeStatus: 1,
    lastPlayedUnixMs: Date.parse("2026-06-01T00:00:00Z"),
    sourceStats: [{ source: "spotify", sourceTrackId: id, playCount: plays, liked: true, playsByYear: { "2026": yearPlays } }]
  };
}

function memory() {
  return { dislikedArtists: [], preferredGenres: [], notes: "" };
}
