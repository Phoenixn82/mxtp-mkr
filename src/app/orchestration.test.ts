import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  burnReal,
  canUsePlaylistCover,
  composeResearchArt,
  detectBurners,
  downloadPlaylistBest,
  exportDir,
  findYouTubeAlbumPlaylist,
  libraryProjectFor,
  mergeSlotArt,
  playableTracks,
  playlistFront,
  replaceResearchBookletArt,
  replaceResearchArt,
  researchArtKeepingChosenFront,
  runGo,
  validateProject,
  writeTracksToQueue
} from "./orchestration";
import { coverPromptForAlbum, styleDnaFromAlbum, type AlbumInfo } from "../research/research";
import type { CdBurnItem, CdProject } from "../project/catalog";
import { albumKey, type AppleMusicAlbum } from "../library/appleMusic";

const AUDIO_MSG = "Add audio first (step 2, Audio).";
const ART_MSG = "Add front, tray and disc art (step 3, Artwork).";
const T0 = { x: 0, y: 0, scale: 1, rotation: 0 };

describe("GO orchestration", () => {
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
  });

  it("validates audio and art before export with plain next steps", () => {
    expect(validateProject({ tracks: [], art: [] })).toEqual([AUDIO_MSG, ART_MSG]);
  });

  it.each([
    [{ tracks: [], art: [{ slotId: "front", imageRef: "front.png", transform: T0 }] }, [AUDIO_MSG]],
    [{ tracks: [{ id: "a", title: "A", durationSec: 1, path: "C:/a.wav" }], art: [] }, [ART_MSG]],
    // A cleared slot (no image, no text) is not art.
    [{ tracks: [{ id: "a", title: "A", durationSec: 1, path: "C:/a.wav" }], art: [{ slotId: "tray", transform: T0 }] }, [ART_MSG]],
    // A browser import without a native path can never be decoded: name it.
    [{ tracks: [{ id: "a", title: "Lost", durationSec: 1 }], art: [{ slotId: "front", imageRef: "front.png", transform: T0 }] }, ["Re-add Lost with Add audio files…"]]
  ])("reports each partial validation failure", (project, expected) => {
    expect(validateProject(project)).toEqual(expected);
  });

  it("detects physical burners through the backend bridge", async () => {
    const handler = vi.fn(async () => [{ id: "D:", name: "Optiarc DVD RW" }]);
    window.__MXTP_INVOKE__ = handler as typeof window.__MXTP_INVOKE__;

    await expect(detectBurners()).resolves.toEqual([{ id: "D:", name: "Optiarc DVD RW" }]);
    expect(handler).toHaveBeenCalledWith("list_burners", undefined);
  });

  it("surfaces burner enumeration failures to the caller", async () => {
    window.__MXTP_INVOKE__ = async () => {
      throw new Error("IMAPI2 enumeration failed");
    };

    await expect(detectBurners()).rejects.toThrow("IMAPI2 enumeration failed");
  });

  it("imports a YouTube playlist through the best-quality downloader command", async () => {
    const imported = {
      title: "Road Mix",
      quality: "Best available source stream per track (no lossy re-encode)",
      coverPath: "C:/mix/cover.jpg",
      tracks: [{ id: "C:/mix/001.opus", title: "First", durationSec: 180, path: "C:/mix/001.opus" }]
    };
    const handler = vi.fn(async () => imported);
    window.__MXTP_INVOKE__ = handler as typeof window.__MXTP_INVOKE__;

    await expect(downloadPlaylistBest("https://www.youtube.com/playlist?list=PL123")).resolves.toEqual(imported);
    expect(handler).toHaveBeenCalledWith("download_playlist_best", {
      url: "https://www.youtube.com/playlist?list=PL123"
    });
  });

  it("passes the canonical tracklist to the native YouTube verifier", async () => {
    const handler = vi.fn(async () => ({
      url: "https://youtube.com/playlist?list=verified",
      title: "Album",
      artist: "Artist",
      trackCount: 2,
      confidence: 0.96,
      explanation: "verified"
    }));
    window.__MXTP_INVOKE__ = handler as typeof window.__MXTP_INVOKE__;
    const expectedTracks = [{ title: "First", durationSec: 180 }, { title: "Second", durationSec: 200 }];
    await findYouTubeAlbumPlaylist("Artist", "Album", expectedTracks);
    expect(handler).toHaveBeenCalledWith("find_youtube_album_playlist", {
      artist: "Artist",
      album: "Album",
      expectedTracks
    });
  });

  it("rejects a real burn before backend work when no audio exists", async () => {
    const handler = vi.fn();
    window.__MXTP_INVOKE__ = handler;

    await expect(burnReal([], "D:", false)).resolves.toEqual({
      ok: false,
      message: "",
      finalPercent: 0,
      errors: ["add audio tracks before burning"]
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("prepares, images, and burns real audio on the selected drive", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      commands.push({ command, args });
      if (command === "prepare_pcm") {
        return [
          { path: "C:/tmp/a.wav", durationSec: 10, sampleRate: 44100, channels: 2, bitsPerSample: 16 },
          { path: "C:/tmp/b.wav", durationSec: 12, sampleRate: 44100, channels: 2, bitsPerSample: 16 }
        ] as never;
      }
      if (command === "build_cda_image") {
        return {
          tracks: [],
          leadinSectors: 4500,
          leadoutSectors: 6750,
          totalSectors: 12900
        } as never;
      }
      if (command === "burn_cda") {
        return { progress: [0, 50, 100], finalPercent: 100, message: "burn complete" } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };

    const stages: string[] = [];
    const result = await burnReal(
      [
        { id: "a", title: "  A\nSignal  ", artist: "Artist", album: "Source Album", durationSec: 10, path: "C:/audio/a.flac" },
        { id: "b", title: "B", artist: "Artist", album: "Source Album", durationSec: 12, path: "C:/audio/b.mp3" }
      ],
      "D:",
      false,
      "  Custom Disc  ",
      (stage) => stages.push(stage)
    );

    expect(result).toEqual({ ok: true, message: "burn complete", finalPercent: 100, errors: [] });
    expect(stages).toEqual(["Converting audio…", "Building CD image…", "Writing disc… 00:00 elapsed"]);
    expect(commands[0]).toEqual({
      command: "prepare_pcm",
      args: { paths: ["C:/audio/a.flac", "C:/audio/b.mp3"], gapSec: 0, normalize: false }
    });
    expect(commands[1]).toEqual({
      command: "build_cda_image",
      args: {
        tracks: [
          { path: "C:/tmp/a.wav", durationSec: 10, sampleRate: 44100, channels: 2, bitsPerSample: 16 },
          { path: "C:/tmp/b.wav", durationSec: 12, sampleRate: 44100, channels: 2, bitsPerSample: 16 }
        ],
        cdText: {
          albumTitle: "Custom Disc",
          albumArtist: "Artist",
          tracks: [
            { title: "A Signal", artist: "Artist" },
            { title: "B", artist: "Artist" }
          ]
        }
      }
    });
    expect(commands[2]).toMatchObject({
      command: "burn_cda",
      args: { drive: "D:", simulate: false }
    });
  });

  it("uses Various Artists for a mixed-artist CD-Text album credit", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      commands.push({ command, args });
      if (command === "prepare_pcm") {
        return [
          { path: "C:/tmp/a.wav", durationSec: 10, sampleRate: 44100, channels: 2, bitsPerSample: 16 },
          { path: "C:/tmp/b.wav", durationSec: 12, sampleRate: 44100, channels: 2, bitsPerSample: 16 }
        ] as never;
      }
      if (command === "build_cda_image") return { tracks: [] } as never;
      if (command === "burn_cda") return { progress: [100], finalPercent: 100, message: "burn complete" } as never;
      throw new Error(`unexpected command ${command}`);
    };

    await burnReal([
      { id: "a", title: "First", artist: "Artist One", album: "Road Mix", durationSec: 10, path: "C:/a.wav" },
      { id: "b", title: "Second", artist: "Artist Two", album: "Road Mix", durationSec: 12, path: "C:/b.wav" }
    ], "D:", false);

    expect(commands[1]).toMatchObject({
      command: "build_cda_image",
      args: {
        cdText: {
          albumTitle: "Road Mix",
          albumArtist: "Various Artists",
          tracks: [
            { title: "First", artist: "Artist One" },
            { title: "Second", artist: "Artist Two" }
          ]
        }
      }
    });
  });

  it.each(["prepare_pcm", "build_cda_image", "burn_cda"])(
    "returns a stable failed result when real burn stage %s rejects",
    async (failedCommand) => {
      const commands: string[] = [];
      window.__MXTP_INVOKE__ = async (command) => {
        commands.push(command);
        if (command === failedCommand) {
          throw new Error(`${command} failed`);
        }
        if (command === "prepare_pcm") {
          return [{ path: "C:/tmp/a.wav" }] as never;
        }
        if (command === "build_cda_image") {
          return { tracks: [], totalSectors: 0 } as never;
        }
        return { progress: [], finalPercent: 100, message: "ok" } as never;
      };

      await expect(burnReal([{ id: "a", title: "A", durationSec: 1, path: "C:/a.wav" }], "D:", false)).resolves.toEqual({
        ok: false,
        message: "",
        finalPercent: 0,
        errors: [`${failedCommand} failed`]
      });
      expect(commands.at(-1)).toBe(failedCommand);
    }
  );

  it("rejects a burn of a track that has no native file before any backend work", async () => {
    const handler = vi.fn();
    window.__MXTP_INVOKE__ = handler;
    await expect(burnReal([{ id: "x", title: "Lost Song", durationSec: 1 }], "D:", false)).resolves.toMatchObject({
      ok: false,
      errors: ["Re-add Lost Song with Add audio files…"]
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("writes GO's PDFs under exports/<project>/<timestamp>, placing art on the bleed box", async () => {
    const commands: string[] = [];
    const composedPieces: unknown[] = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      commands.push(command);
      if (command === "prepare_pcm") {
        expect(args?.paths).toEqual(["C:/audio/a.wav"]);
        return [
          { path: "C:/tmp/a.wav", durationSec: 10, sampleRate: 44100, channels: 2, bitsPerSample: 16 }
        ] as never;
      }
      if (command === "build_cda_image") {
        return {
          tracks: [{ number: 1, path: "C:/tmp/a.wav", sectors: 750, pregapSectors: 150, startSector: 4650 }],
          leadinSectors: 4500,
          leadoutSectors: 6750,
          totalSectors: 12150
        } as never;
      }
      if (command === "compose_pdf") {
        const piece = args?.piece as { pieceId: string };
        composedPieces.push(piece);
        return { path: `C:/export/${piece.pieceId}.pdf` } as never;
      }
      if (command === "burn_cda") {
        return { progress: [0, 100], finalPercent: 100, message: "validated" } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const stages: string[] = [];
    const result = await runGo({
      projectId: "neon-tide-static-bloom-1",
      tracks: [{ id: "a", title: "A", durationSec: 10, path: "C:/audio/a.wav" }],
      art: [
        {
          slotId: "front",
          imageRef: "e2e/fixtures/art-front.png",
          transform: { x: 4, y: 5, scale: 1.2, rotation: 15 }
        },
        {
          slotId: "tray",
          textContent: {
            title: "Known Tracklist",
            lines: ["1. Alpha Signal", "2. Beta Window"]
          },
          transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        },
        // Booklet pages come only from the Booklet panel's export.
        {
          slotId: "saddle-16",
          textContent: { title: "Lyrics", lines: ["la la"] },
          transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        },
        // Cleared by "Remove art": nothing to print.
        { slotId: "disc", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }
      ]
    }, (stage) => stages.push(stage), new Date(2026, 9, 19, 14, 5, 9));
    expect(result).toMatchObject({
      ok: true,
      burnProgress: 100,
      exports: ["C:/export/front.pdf", "C:/export/tray.pdf"]
    });
    expect(stages).toEqual(["Preparing audio…", "Writing print PDFs…", "Checking the CD image…"]);
    const outputDir = "exports/neon-tide-static-bloom-1/20261019-140509";
    expect(composedPieces).toEqual([
      {
        pieceId: "front",
        outputDir,
        images: [
          {
            path: "e2e/fixtures/art-front.png",
            xMm: 0,
            yMm: 0,
            wMm: 126.35,
            hMm: 126.35,
            scale: 1.2,
            rotationDeg: 15
          }
        ],
        texts: []
      },
      {
        pieceId: "tray",
        outputDir,
        images: [],
        texts: [
          {
            content: {
              title: "Known Tracklist",
              lines: ["1. Alpha Signal", "2. Beta Window"]
            },
            xMm: 9.675,
            yMm: 3.175,
            wMm: 130.65,
            hMm: 111.65,
            fontSizePt: 8.5
          }
        ]
      }
    ]);
    expect(commands).toEqual(["prepare_pcm", "compose_pdf", "compose_pdf", "build_cda_image", "burn_cda"]);
  });

  it("names the export folder safely for any project id", () => {
    expect(exportDir("../../etc", new Date(2026, 0, 2, 3, 4, 5))).toBe("exports/etc/20260102-030405");
    expect(exportDir(undefined, new Date(2026, 0, 2, 3, 4, 5))).toBe("exports/project/20260102-030405");
  });

  it("keeps the PDFs that composed and names the piece that failed", async () => {
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "prepare_pcm") return [{ path: "C:/tmp/a.wav" }] as never;
      if (command === "compose_pdf") {
        const piece = (args?.piece as { pieceId: string }).pieceId;
        if (piece === "tray") throw new Error("image too small: needs 1772x1394px");
        return { path: `C:/export/${piece}.pdf` } as never;
      }
      if (command === "build_cda_image") return { tracks: [], totalSectors: 0 } as never;
      return { progress: [], finalPercent: 100, message: "ok" } as never;
    };
    const result = await runGo({
      tracks: [{ id: "a", title: "A", durationSec: 1, path: "C:/a.wav" }],
      art: [
        { slotId: "front", imageRef: "C:/art/front.png", transform: T0 },
        { slotId: "tray", imageRef: "C:/art/tray.png", transform: T0 },
        { slotId: "disc", imageRef: "C:/art/disc.png", transform: T0 }
      ]
    });
    expect(result).toEqual({
      ok: false,
      exports: ["C:/export/front.pdf", "C:/export/disc.pdf"],
      burnProgress: 100,
      errors: ["Tray card: image too small: needs 1772x1394px"]
    });
  });

  it.each([
    ["prepare_pcm", ["prepare_pcm", "compose_pdf"], "Preparing audio: prepare_pcm failed"],
    ["build_cda_image", ["prepare_pcm", "compose_pdf", "build_cda_image"], "Test burn: build_cda_image failed"],
    ["burn_cda", ["prepare_pcm", "compose_pdf", "build_cda_image", "burn_cda"], "Test burn: simulated media rejected"]
  ])("reports a named error when GO stage %s fails", async (failedCommand, expectedCommands, expectedError) => {
    const commands: string[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      commands.push(command);
      if (command === failedCommand) {
        if (command === "burn_cda") {
          throw "simulated media rejected";
        }
        throw new Error(`${command} failed`);
      }
      if (command === "prepare_pcm") {
        return [{ path: "C:/tmp/a.wav" }] as never;
      }
      if (command === "build_cda_image") {
        return { tracks: [], totalSectors: 0 } as never;
      }
      if (command === "compose_pdf") {
        return { path: "C:/export/front.pdf" } as never;
      }
      return { progress: [], finalPercent: 100, message: "ok" } as never;
    };

    const result = await runGo({
      tracks: [{ id: "a", title: "A", durationSec: 1, path: "C:/a.wav" }],
      art: [{ slotId: "front", imageRef: "C:/art/front.png", transform: T0 }]
    });

    expect(result).toEqual({ ok: false, exports: ["C:/export/front.pdf"], burnProgress: 0, errors: [expectedError] });
    expect(commands).toEqual(expectedCommands);
  });

  it("never runs backend work for a GO that fails validation", async () => {
    const handler = vi.fn();
    window.__MXTP_INVOKE__ = handler;
    await expect(runGo({ tracks: [], art: [] })).resolves.toEqual({ ok: false, exports: [], burnProgress: 0, errors: [AUDIO_MSG, ART_MSG] });
    expect(handler).not.toHaveBeenCalled();
  });

  it("composes research tracklist and lyrics into tray/booklet with the Style-DNA prompt", () => {
    const album: AlbumInfo = {
      artist: "Daft Punk",
      album: "Discovery",
      year: 2001,
      label: "Virgin",
      tracks: ["One More Time", "Aerodynamic"],
      coverArtUrls: ["https://coverartarchive.org/release/example/front"],
      tags: ["house", "electronic", "disco"]
    };
    const cover = {
      imagePath: "C:/tmp/mock-cover.png",
      prompt: coverPromptForAlbum(album, styleDnaFromAlbum(album)),
      palette: ["#f45b69"]
    };
    const composed = composeResearchArt(album, cover, [
      { title: "One More Time", lyrics: "One More Time lyrics\nA real lyric line" },
      { title: "Aerodynamic", lyrics: "Aerodynamic lyric line" }
    ]);

    expect(composed.find((item) => item.slotId === "tray")?.textContent).toEqual({
      title: "Daft Punk - Discovery",
      lines: ["1. One More Time", "2. Aerodynamic"]
    });
    expect(composed.find((item) => item.slotId === "front")?.imageSource).toBe("research");
    expect(composed.find((item) => item.slotId === "tray")?.textSource).toBe("research");
    expect(composed.find((item) => item.slotId === "saddle-16")?.textContent).toEqual({
      title: "Discovery lyrics",
      lines: [
        "1. One More Time",
        "One More Time lyrics",
        "A real lyric line",
        "",
        "2. Aerodynamic",
        "Aerodynamic lyric line"
      ]
    });
    expect(cover.prompt).toContain("Style-DNA");
    expect(cover.prompt).toContain("palette=");
    expect(cover.prompt).toContain("mood=");
    expect(cover.prompt).toContain("era=early-2000s");
    expect(cover.prompt).toContain("MusicBrainz tags: house, electronic, disco");

  });

  it("composes tray tracklist and booklet lyrics without a front slot when the cover is missing", () => {
    const album: AlbumInfo = {
      artist: "Radiohead",
      album: "In Rainbows",
      year: 2007,
      label: "XL",
      tracks: ["15 Step", "Bodysnatchers"],
      coverArtUrls: [],
      tags: ["alternative rock"]
    };
    const composed = composeResearchArt(album, undefined, [
      { title: "15 Step", lyrics: "15 Step lyrics\nAnother lyric line" }
    ]);

    expect(composed.find((item) => item.slotId === "front")).toBeUndefined();
    expect(composed.find((item) => item.slotId === "tray")?.textContent).toEqual({
      title: "Radiohead - In Rainbows",
      lines: ["1. 15 Step", "2. Bodysnatchers"]
    });
    expect(composed.find((item) => item.slotId === "saddle-16")?.textContent).toEqual({
      title: "In Rainbows lyrics",
      lines: ["1. 15 Step", "15 Step lyrics", "Another lyric line"]
    });
  });

  it("writes current AI pipeline evidence when enabled", () => {
    if (process.env.MXTP_MKR_GOAL_EVIDENCE !== "1") {
      return;
    }
    const runDir = path.join(
      process.cwd(),
      "pipeline",
      "goal-runs",
      "20260629T170240Z-mxtp-ai-pipeline"
    );
    const evidenceDir = path.join(runDir, "evidence");
    const rawLyricsPath = process.env.MXTP_MKR_GOAL_LYRICS_JSON;
    expect(rawLyricsPath).toBeTruthy();
    expect(fs.existsSync(rawLyricsPath as string)).toBe(true);

    const daftPunk = readAlbumEvidence(path.join(evidenceDir, "G1-musicbrainz-daftpunk.json"));
    const radiohead = readAlbumEvidence(path.join(evidenceDir, "G1-musicbrainz-radiohead.json"));
    const daftStyle = styleDnaFromAlbum(daftPunk);
    const radioStyle = styleDnaFromAlbum(radiohead);
    const daftPrompt = coverPromptForAlbum(daftPunk, daftStyle);
    const radioPrompt = coverPromptForAlbum(radiohead, radioStyle);

    expect(daftStyle.profile).not.toEqual(radioStyle.profile);
    expect(daftStyle.palette).not.toEqual(radioStyle.palette);
    fs.writeFileSync(
      path.join(evidenceDir, "G3-styledna-daftpunk.txt"),
      styleEvidence(daftPunk, daftStyle, daftPrompt),
      "utf8"
    );
    fs.writeFileSync(
      path.join(evidenceDir, "G3-styledna-radiohead.txt"),
      styleEvidence(radiohead, radioStyle, radioPrompt),
      "utf8"
    );
    fs.writeFileSync(path.join(evidenceDir, "G2-cover-prompt.txt"), daftPrompt, "utf8");

    const rawLyrics = JSON.parse(fs.readFileSync(rawLyricsPath as string, "utf8")) as Record<string, string>;
    const lyricKey = `${daftPunk.artist} - ${daftPunk.tracks[0]}`;
    const lyrics = rawLyrics[lyricKey];
    expect(lyrics.length).toBeGreaterThan(100);

    const composed = composeResearchArt(
      daftPunk,
      { imagePath: path.join(evidenceDir, "G2-cover.png"), prompt: daftPrompt, palette: [] },
      [{ title: daftPunk.tracks[0], lyrics }]
    );
    fs.writeFileSync(
      path.join(evidenceDir, "G4-composed.json"),
      JSON.stringify(sanitizeComposedArt(composed), null, 2),
      "utf8"
    );
  });

  it("drops a slot whose art was removed", () => {
    const front = { slotId: "front", imageRef: "front.png", imageSource: "manual" as const, transform: T0 };
    const tray = { slotId: "tray", imageRef: "tray.png", imageSource: "manual" as const, transform: T0 };
    expect(mergeSlotArt([front, tray], [{ slotId: "tray", imageRef: undefined, previewRef: undefined, imageSource: undefined, transform: T0 }])).toEqual([front]);
  });

  it("keeps a chosen front through a Lookup but lets research replace research", () => {
    const research = composeResearchArt(
      { artist: "A", album: "B", year: 2001, label: "L", tracks: ["One"], coverArtUrls: [], tags: [] },
      { imagePath: "C:/research.png", previewUrl: "data:image/png;base64,x", prompt: "p", palette: [] },
      []
    );
    for (const source of ["manual", "playlist"] as const) {
      const current = [{ slotId: "front", imageRef: `C:/${source}.png`, imageSource: source, transform: T0 }];
      const next = replaceResearchArt(current, researchArtKeepingChosenFront(current, research));
      expect(next.find((item) => item.slotId === "front")).toEqual(current[0]);
      expect(next.some((item) => item.slotId === "tray")).toBe(true);
    }
    const researched = [{ slotId: "front", imageRef: "C:/old-research.png", imageSource: "research" as const, transform: T0 }];
    const next = replaceResearchArt(researched, researchArtKeepingChosenFront(researched, research));
    expect(next.find((item) => item.slotId === "front")?.imageRef).toBe("C:/research.png");
  });

  it("uses a playlist cover only for an empty or playlist front, with no stale preview", () => {
    expect(canUsePlaylistCover([])).toBe(true);
    expect(canUsePlaylistCover([{ slotId: "front", imageRef: "C:/yt-old.jpg", imageSource: "playlist", transform: T0 }])).toBe(true);
    expect(canUsePlaylistCover([{ slotId: "front", imageRef: "C:/mine.png", imageSource: "manual", transform: T0 }])).toBe(false);
    expect(canUsePlaylistCover([{ slotId: "front", imageRef: "C:/r.png", previewRef: "data:x", imageSource: "research", transform: T0 }])).toBe(false);
    const merged = mergeSlotArt(
      [{ slotId: "front", imageRef: "C:/r.png", previewRef: "data:research", imageSource: "research", transform: T0 }],
      [playlistFront("C:/yt.jpg")]
    );
    expect(merged[0]).toMatchObject({ imageRef: "C:/yt.jpg", imageSource: "playlist" });
    expect(merged[0].previewRef).toBeUndefined();
  });

  it("upserts canonical slot art instead of leaving stale duplicates", () => {
    const oldFront = { slotId: "front", imageRef: "old.png", transform: { x: 0, y: 0, scale: 1, rotation: 0 } };
    const newFront = { slotId: "front", imageRef: "new.png", transform: { x: 1, y: 2, scale: 1, rotation: 0 } };
    const disc = { slotId: "disc", imageRef: "disc.png", transform: { x: 0, y: 0, scale: 1, rotation: 0 } };

    expect(mergeSlotArt([oldFront, disc, oldFront], [newFront])).toEqual([newFront, disc]);
  });

  it("replaces research-owned fields while preserving manual imagery on the same physical slots", () => {
    const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    const current = [
      { slotId: "front", imageRef: "album-a.png", imageSource: "research" as const, transform },
      {
        slotId: "tray",
        imageRef: "hand-made-tray.png",
        imageSource: "manual" as const,
        textContent: { title: "A", lines: [] },
        textSource: "research" as const,
        transform
      },
      {
        slotId: "saddle-12",
        imageRef: "hand-made-pages.png",
        imageSource: "manual" as const,
        textContent: { title: "A lyrics", lines: [] },
        textSource: "research" as const,
        transform
      },
      { slotId: "disc", imageRef: "hand-made.png", imageSource: "manual" as const, transform }
    ];
    const next = [
      { slotId: "front", imageRef: "album-b.png", imageSource: "research" as const, transform },
      {
        slotId: "tray",
        textContent: { title: "B", lines: ["one"] },
        textSource: "research" as const,
        transform
      },
      {
        slotId: "saddle-20",
        textContent: { title: "B lyrics", lines: [] },
        textSource: "research" as const,
        transform
      }
    ];

    const replaced = replaceResearchArt(current, next);
    expect(replaced.find((item) => item.slotId === "front")?.imageRef).toBe("album-b.png");
    expect(replaced.find((item) => item.slotId === "tray")).toMatchObject({
      imageRef: "hand-made-tray.png",
      textContent: { title: "B", lines: ["one"] }
    });
    const oldBooklet = replaced.find((item) => item.slotId === "saddle-12");
    expect(oldBooklet?.imageRef).toBe("hand-made-pages.png");
    expect(oldBooklet?.textContent).toBeUndefined();
    expect(replaced.find((item) => item.slotId === "disc")?.imageRef).toBe("hand-made.png");
    expect(replaced.find((item) => item.slotId === "saddle-20")?.textContent?.title).toBe("B lyrics");
  });

  it("moves generated lyric text between booklet sizes without deleting either booklet's manual artwork", () => {
    const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    const current = [
      {
        slotId: "saddle-16",
        imageRef: "16-page-art.png",
        imageSource: "manual" as const,
        textContent: { title: "Old lyrics", lines: [] },
        textSource: "research" as const,
        transform
      },
      { slotId: "saddle-20", imageRef: "20-page-art.png", imageSource: "manual" as const, transform }
    ];
    const lyrics = {
      slotId: "saddle-20",
      textContent: { title: "New lyrics", lines: ["line"] },
      textSource: "research" as const,
      transform
    };

    expect(replaceResearchBookletArt(current, [lyrics])).toEqual([
      { slotId: "saddle-16", imageRef: "16-page-art.png", imageSource: "manual", transform },
      {
        slotId: "saddle-20",
        imageRef: "20-page-art.png",
        imageSource: "manual",
        textContent: { title: "New lyrics", lines: ["line"] },
        textSource: "research",
        transform
      }
    ]);
  });
});

describe("burn list <-> studio tracks", () => {
  const entry = { artist: "Daft Punk", album: "Discovery" };
  const item = (id: string, ready = true): CdBurnItem => ({
    id,
    albumKey: "daftpunk::discovery",
    title: id.toUpperCase(),
    artist: "Daft Punk",
    album: "Discovery",
    durationSec: 100,
    ...(ready ? { ready: { id: `${id}-audio`, title: id.toUpperCase(), durationSec: 100, path: `C:/${id}.opus` } } : {})
  });

  it("plays only downloaded burn-list items, in burn order", () => {
    expect(playableTracks([item("c"), item("x", false), item("a")]).map((track) => track.id)).toEqual(["c-audio", "a-audio"]);
  });

  it("writes a reorder, a removal and a rename back, keeping items still waiting for audio in place", () => {
    const queue = [item("a"), item("b"), item("w", false), item("c")];
    const [a, , c] = playableTracks(queue);
    const next = writeTracksToQueue(queue, [{ ...c, title: "C (live)" }, a], entry);
    expect(next.map((queued) => queued.id)).toEqual(["c", "a", "w"]);
    expect(next[0]).toMatchObject({ title: "C (live)", ready: { title: "C (live)" } });
    expect(next[2].ready).toBeUndefined();
  });

  it("appends an imported track as a new burn-list item for the project's album", () => {
    const imported = { id: "new", title: "Bonus", durationSec: 90, path: "C:/bonus.wav" };
    const next = writeTracksToQueue([item("a")], [...playableTracks([item("a")]), imported], entry);
    expect(next[1]).toEqual({
      id: "new",
      albumKey: albumKey("Daft Punk", "Discovery"),
      title: "Bonus",
      artist: "Daft Punk",
      album: "Discovery",
      durationSec: 90,
      ready: imported
    });
  });
});

describe("libraryProjectFor", () => {
  const album: AppleMusicAlbum = {
    key: albumKey("Neon Tide", "Static Bloom"),
    title: "Static Bloom",
    artist: "Neon Tide",
    genre: "Electronic",
    artworkPath: "C:/art/library.jpg",
    tracks: [],
    durationSec: 0,
    playCount: 0
  };
  const existing = {
    id: "bloom",
    name: "Static Bloom",
    kind: "artist",
    saved: true,
    entry: { artist: "Neon Tide", album: "Static Bloom", formatId: "digipak" },
    burnQueue: [],
    tracks: [],
    art: [{ slotId: "front", imageRef: "C:/art/mine.png", imageSource: "manual", transform: T0 }],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z"
  } as CdProject;

  it("keeps the project's case format and its updatedAt when nothing changed", () => {
    const project = libraryProjectFor([existing], album, undefined, new Date("2026-10-19T00:00:00Z"));
    expect(project.entry.formatId).toBe("digipak");
    expect(project.updatedAt).toBe(existing.updatedAt);
    expect(project.art).toEqual(existing.art);
  });

  it("bumps updatedAt when a download adds tracks, still keeping the format", () => {
    const playlist = { title: "Static Bloom", quality: "best", tracks: [{ id: "g", title: "Glass Harbor", durationSec: 201, path: "C:/cache/sb/001 - Glass Harbor.opus" }] };
    const project = libraryProjectFor([existing], album, playlist, new Date("2026-10-19T00:00:00Z"));
    expect(project.entry.formatId).toBe("digipak");
    expect(project.tracks).toEqual(playlist.tracks);
    expect(project.sourcePath).toBe("C:/cache/sb");
    expect(project.updatedAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("starts a new jewel-case project with the library artwork as its front", () => {
    const project = libraryProjectFor([], album, undefined, new Date("2026-10-19T00:00:00Z"));
    expect(project.entry).toEqual({ artist: "Neon Tide", album: "Static Bloom", formatId: "jewelcase" });
    expect(project.art[0]).toMatchObject({ slotId: "front", imageRef: "C:/art/library.jpg", imageSource: "manual" });
  });
});

function readAlbumEvidence(file: string): AlbumInfo {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AlbumInfo;
}

function styleEvidence(album: AlbumInfo, styleDna: ReturnType<typeof styleDnaFromAlbum>, prompt: string): string {
  return [
    `album=${album.artist} - ${album.album}`,
    `tags=${album.tags.join(", ")}`,
    `profile=${styleDna.profile}`,
    `palette=${styleDna.palette.join(", ")}`,
    `mood=${styleDna.mood.join(", ")}`,
    `era=${styleDna.era}`,
    `finalCoverPrompt=${prompt}`
  ].join("\n");
}

function sanitizeComposedArt(composed: ReturnType<typeof composeResearchArt>) {
  return composed.map((item) => {
    if (!item.slotId.startsWith("saddle-") || !item.textContent) {
      return item;
    }
    return {
      ...item,
      textContent: {
        title: item.textContent.title,
        lineCount: item.textContent.lines.length
      }
    };
  });
}
