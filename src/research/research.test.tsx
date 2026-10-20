import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchPanel } from "./ResearchPanel";
import {
  COVER_DIRECTIONS,
  artDirectFromReferences,
  coverAdapterLabel,
  coverPromptForAlbum,
  coverPromptFromArtDirection,
  editCoverFromOriginal,
  fetchCoverTheme,
  fetchEraCovers,
  fetchLyrics,
  fetchRealCoverFile,
  generateCover,
  lookupAlbum,
  styleDnaFromAlbum,
  visionAlbumLabelForDirection,
  type AlbumInfo,
  type GeneratedCover
} from "./research";

function albumFixture(overrides: Partial<AlbumInfo> = {}): AlbumInfo {
  return {
    artist: "Daft Punk",
    album: "Discovery",
    year: 2001,
    label: "Virgin",
    tracks: ["One More Time"],
    coverArtUrls: ["https://coverartarchive.org/release/example/front"],
    tags: ["house", "electronic"],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("research", () => {
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
  });

  it("looks up a known album through Tauri IPC with ordered tracks", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      expect(command).toBe("lookup_album");
      return {
        artist: "Daft Punk",
        album: "Discovery",
        year: 2001,
        label: "Virgin",
        tracks: ["One More Time", "Aerodynamic", "Digital Love", "Harder, Better, Faster, Stronger", "Crescendolls", "Nightvision", "Superheroes", "High Life", "Something About Us", "Voyager"],
        coverArtUrls: ["https://coverartarchive.org/release/example/front"],
        tags: ["house", "electronic"]
      } as never;
    };
    const album = await lookupAlbum("Daft Punk", "Discovery");
    expect(album.tracks.length).toBeGreaterThanOrEqual(10);
    expect(album.tracks[0]).toBe("One More Time");
    expect(album.year).toBe(2001);
  });

  it("fetches lyric text and generates a cover through Tauri IPC", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "fetch_lyrics") {
        return "One More Time\nA real lyric fetch result excerpt" as never;
      }
      if (command === "generate_cover") {
        return { imagePath: "C:/tmp/mock-cover.png", prompt: "neon disco", palette: ["#f45b69"] } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    await expect(fetchLyrics("Daft Punk", "One More Time")).resolves.toContain("One More Time");
    await expect(generateCover("neon disco")).resolves.toMatchObject({ imagePath: expect.stringContaining("mock-cover.png") });
  });

  it("routes every cover-enrichment wrapper through the exact Tauri IPC contract", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      calls.push({ command, args });
      if (command === "fetch_cover_theme") {
        return { sourceUrl: "cover", previewUrl: "data:image/png;base64,x", palette: ["#123456"], luminance: 0.4 } as never;
      }
      if (command === "fetch_real_cover_file") {
        return { imagePath: "C:/tmp/real.png", previewUrl: "data:image/png;base64,y", palette: ["#654321"] } as never;
      }
      if (command === "fetch_era_covers") {
        return ["era-1", "era-2"] as never;
      }
      if (command === "art_direct_from_references") {
        return "Tactile art direction" as never;
      }
      if (command === "edit_cover_from_original") {
        return { imagePath: "C:/tmp/edited.png", prompt: "cartoonish", palette: ["#654321"] } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };

    await expect(fetchCoverTheme(["cover-1"])).resolves.toMatchObject({ palette: ["#123456"] });
    await expect(fetchRealCoverFile(["cover-1", "cover-2"])).resolves.toMatchObject({ imagePath: "C:/tmp/real.png" });
    await expect(fetchEraCovers("Daft Punk", 2001, 3)).resolves.toEqual(["era-1", "era-2"]);
    await expect(artDirectFromReferences("Discovery brief", ["cover-1"], ["era-1"])).resolves.toBe(
      "Tactile art direction"
    );
    await expect(editCoverFromOriginal("C:/tmp/real.png", "Make it cartoonish")).resolves.toMatchObject({
      imagePath: "C:/tmp/edited.png"
    });

    expect(calls).toEqual([
      { command: "fetch_cover_theme", args: { coverArtUrls: ["cover-1"] } },
      { command: "fetch_real_cover_file", args: { coverArtUrls: ["cover-1", "cover-2"] } },
      { command: "fetch_era_covers", args: { artist: "Daft Punk", year: 2001, limit: 3 } },
      {
        command: "art_direct_from_references",
        args: { albumLabel: "Discovery brief", coverArtUrls: ["cover-1"], eraRefUrls: ["era-1"] }
      },
      {
        command: "edit_cover_from_original",
        args: { sourceImagePath: "C:/tmp/real.png", instruction: "Make it cartoonish" }
      }
    ]);
  });

  it("builds a concrete print-art brief for every selectable direction", () => {
    const album = albumFixture();
    const dna = styleDnaFromAlbum(album);
    const theme = {
      sourceUrl: album.coverArtUrls[0],
      previewUrl: "data:image/png;base64,theme",
      palette: ["#102030", "#d0e0f0"],
      luminance: 0.28
    };

    for (const direction of COVER_DIRECTIONS) {
      const prompt = coverPromptForAlbum(album, dna, theme, direction.id);
      expect(prompt).toContain(`Direction: ${direction.label}`);
      expect(prompt).toContain("Concept:");
      expect(prompt).toContain("Composition:");
      expect(prompt).toContain("Material:");
      expect(prompt).toContain("Lighting:");
      expect(prompt).toContain("Palette:");
      expect(prompt).toContain("Era cues:");
      expect(prompt).toContain("Title-safe negative space:");
      expect(prompt).toContain("exact 1:1 square");
      expect(prompt).toContain("Originality:");
      expect(prompt).toContain("all text, letters, numbers, logos");
      expect(prompt).toContain("packaging mockups");
      expect(prompt).toContain("#102030, #d0e0f0");
    }

    expect(visionAlbumLabelForDirection(album, "unexpected-hybrid")).toContain("Unexpected hybrid");
    expect(
      coverPromptFromArtDirection(album, "Macro glass forms over technical grids", dna, theme, "unexpected-hybrid")
    ).toContain("Pixel-grounded palette from the real cover (mandatory): #102030, #d0e0f0");
  });

  it("lets real-cover visual grammar override generic genre stereotypes", () => {
    const album = albumFixture({
      artist: "Radiohead",
      album: "In Rainbows",
      year: 2007,
      tags: ["alternative rock", "experimental rock"]
    });
    const visualGrammar = [
      "PRIMARY ENERGY: dense, ecstatic, full-frame compression",
      "COLOR LOGIC: hot orange and red blooms with electric blue and green sparks on black",
      "TYPOGRAPHY ROLE: PRIMARY; repeated horizontal bands structure the image",
      "NEW MOTIF: photographed chemical emulsion and tangled particulate trails",
      "FORBIDDEN CLICHES: maps, grids, signal orbs, cold dystopian architecture"
    ].join("; ");

    const prompt = coverPromptFromArtDirection(album, visualGrammar);

    expect(prompt).toContain("Highest priority - visual grammar extracted from the real cover");
    expect(prompt).toContain(visualGrammar);
    expect(prompt).toContain("No readable text, fake text, pseudo-letters");
    expect(prompt).toContain("RAW FULL-BLEED ARTWORK ONLY");
    expect(prompt).toContain("no centered glowing orb, portal, cosmic nebula");
    expect(prompt).not.toContain("fragmented map");
    expect(prompt).not.toContain("oxidized green");
    expect(prompt).not.toContain("cold overcast");
    expect(prompt).not.toContain("one dominant image");
  });

  it("resolves contradictory central wording in an asymmetric visual grammar", () => {
    const prompt = coverPromptFromArtDirection(
      albumFixture(),
      [
        "PRIMARY ENERGY: dense and kinetic",
        "COMPOSITION: asymmetrical diagonal flow with a central bright region",
        "COLOR LOGIC: black, red, orange, blue",
        "SURFACE / MEDIUM: ink and emulsion",
        "TYPOGRAPHY ROLE: PRIMARY",
        "NEW MOTIF: layered resin slice",
        "FORBIDDEN CLICHES: mandalas and portals"
      ].join("\n")
    );

    expect(prompt).toContain("asymmetric means no centered focal point");
    expect(prompt).toContain("three to five unequal visual events");
  });

  it.each([
    ["real", "Real album artwork · Cover Art Archive"],
    ["pollinations", "AI artwork · Pollinations (legacy provider label)"],
    ["pollinations-klein", "AI artwork · Pollinations Klein · reference-conditioned"],
    ["pollinations-gptimage", "AI artwork · Pollinations GPT Image · reference-conditioned"],
    ["pollinations-gptimage-large", "AI artwork · Pollinations GPT Image 1.5 · vision-grounded"],
    ["pollinations-nova-canvas", "AI artwork · Pollinations Nova Canvas · vision-grounded"],
    ["pollinations-flux", "AI artwork · Pollinations FLUX · prompt-only"],
    ["cloudflare", "AI artwork · Cloudflare Workers AI / FLUX"],
    ["cloudflare-flux2-pro-preview-edit", "Original-cover edit / Cloudflare FLUX.2 Pro"],
    ["cloudflare-flux2-max-edit", "Original-cover edit / Cloudflare FLUX.2 Max"],
    ["codex", "AI artwork · Codex image generation"],
    ["mock", "Placeholder artwork · mock adapter (not AI-generated)"],
    [undefined, "Generated artwork · provider not reported"]
  ])("labels the %s cover adapter honestly", (adapter, expected) => {
    expect(coverAdapterLabel(adapter)).toBe(expected);
  });

  it("applies research into the project after lookup", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") {
        return {
          artist: "Daft Punk",
          album: "Discovery",
          year: 2001,
          label: "Virgin",
          tracks: ["One More Time"],
          coverArtUrls: [],
          tags: ["house", "electronic"]
        } as never;
      }
      if (command === "generate_cover") {
        return { imagePath: "C:/tmp/mock-cover.png", prompt: "cover", palette: [] } as never;
      }
      if (command === "fetch_lyrics") {
        return "One More Time lyrics" as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: string[] = [];
    render(<ResearchPanel onApply={(album) => applied.push(album.album)} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toEqual(["Discovery"]));
  });

  it("applies research without generating art, and sends Style-DNA tokens when a concept is requested", async () => {
    let prompt = "";
    const calls: string[] = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      calls.push(command);
      if (command === "lookup_album") {
        return {
          artist: "Daft Punk",
          album: "Discovery",
          year: 2001,
          label: "Virgin",
          tracks: ["One More Time", "Aerodynamic"],
          coverArtUrls: [],
          tags: ["house", "electronic"]
        } as never;
      }
      if (command === "generate_cover") {
        prompt = String(args?.prompt);
        return { imagePath: "C:/tmp/mock-cover.png", prompt, palette: ["#f45b69"] } as never;
      }
      if (command === "fetch_lyrics") {
        return "One More Time lyrics" as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: Array<{ album: string; cover: unknown }> = [];
    render(<ResearchPanel onApply={(album, cover) => applied.push({ album: album.album, cover })} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toEqual([{ album: "Discovery", cover: undefined }]));
    expect(calls).not.toContain("generate_cover");

    await user.click(screen.getByTestId("generate-grounded-cover"));
    await waitFor(() => expect(prompt).toContain("Style-DNA"));
    expect(prompt).toContain("palette=");
    expect(prompt).toContain("mood=");
    expect(prompt).toContain("era=early-2000s");
    expect(prompt).toContain("MusicBrainz tags: house, electronic");
    expect(screen.queryByTestId("apply-research")).not.toBeInTheDocument();
  });

  it("never generates art when the real cover download fails: the front stays untouched and Retry is offered", async () => {
    const calls: string[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      calls.push(command);
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") {
        return {
          sourceUrl: albumFixture().coverArtUrls[0],
          previewUrl: "data:image/png;base64,theme",
          palette: ["#0b0908", "#d7a42a"],
          luminance: 0.12
        } as never;
      }
      if (command === "fetch_real_cover_file") throw new Error("archive unavailable");
      if (command === "generate_cover") throw new Error("a replacement must never be generated silently");
      if (command === "fetch_lyrics") return "lyrics" as never;
      throw new Error(`unexpected command ${command}`);
    };

    const user = userEvent.setup();
    const applied: Array<{ album: string; cover: unknown }> = [];
    render(<ResearchPanel onApply={(album, cover) => applied.push({ album: album.album, cover })} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toEqual([{ album: "Discovery", cover: undefined }]));

    expect(calls).not.toContain("generate_cover");
    expect(calls).not.toContain("art_direct_from_references");
    expect(screen.getByTestId("real-cover-note")).toHaveTextContent("Real cover download failed: archive unavailable");
    expect(screen.getByTestId("real-cover-note")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("use-real-cover")).toHaveTextContent("Retry");
    expect(screen.getByTestId("use-real-cover")).toHaveAttribute("aria-describedby", "real-cover-note");
    expect(screen.queryByTestId("cover-provider")).not.toBeInTheDocument();
    // Generating stays one explicit click away.
    expect(screen.getByText("Create a separate concept").closest("details")).toHaveAttribute("open");
  });

  it("auto-lookup applies research without clicking, and a manual re-lookup of the same album applies again", async () => {
    let lookups = 0;
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") {
        lookups += 1;
        return {
          artist: "Daft Punk",
          album: "Discovery",
          year: lookups === 1 ? 2001 : 2011,
          label: "Virgin",
          tracks: ["One More Time"],
          coverArtUrls: [],
          tags: ["house"]
        } as never;
      }
      if (command === "fetch_lyrics") {
        return "One More Time lyrics" as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: number[] = [];
    render(
      <ResearchPanel
        onApply={(album) => applied.push(album.year)}
        initialArtist="Daft Punk"
        initialAlbum="Discovery"
        autoLookupKey="Daft Punk :: Discovery"
      />
    );
    await waitFor(() => expect(applied).toEqual([2001]));
    await user.click(screen.getByTestId("run-research"));
    // The last lookup wins: the project gets the corrected research, not the first run's.
    await waitFor(() => expect(applied).toEqual([2001, 2011]));
    expect(screen.getByTestId("research-result")).toHaveTextContent("Daft Punk - Discovery (2011)");
  });

  it("still applies album and lyrics when the release has no real cover, and never generates one", async () => {
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") {
        return {
          artist: "Radiohead",
          album: "In Rainbows",
          year: 2007,
          label: "XL",
          tracks: ["15 Step", "Bodysnatchers"],
          coverArtUrls: [],
          tags: ["alternative rock"]
        } as never;
      }
      if (command === "generate_cover") {
        throw new Error("a replacement must never be generated silently");
      }
      if (command === "fetch_lyrics") {
        return `${String(args?.title)} lyrics` as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: Array<{ album: string; cover: unknown; lyrics: unknown }> = [];
    render(
      <ResearchPanel onApply={(album, cover, lyrics) => applied.push({ album: album.album, cover, lyrics })} />
    );
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual({
      album: "In Rainbows",
      cover: undefined,
      lyrics: [
        { title: "15 Step", lyrics: "15 Step lyrics" },
        { title: "Bodysnatchers", lyrics: "Bodysnatchers lyrics" }
      ]
    });
    expect(screen.getByTestId("research-result")).toHaveTextContent("15 Step");
    const note = screen.getByTestId("real-cover-note");
    expect(note).toHaveTextContent("No real cover on Cover Art Archive for this release.");
    expect(note).toHaveAttribute("role", "status");
    expect(screen.getByTestId("use-real-cover")).toBeDisabled();
    expect(screen.getByTestId("use-real-cover")).toHaveAttribute("aria-describedby", note.id);
    expect(screen.queryByTestId("research-error")).not.toBeInTheDocument();
  });

  it("still applies the album when the lyrics fetch fails, with a neutral note beside the coverage", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") {
        return {
          artist: "Radiohead",
          album: "In Rainbows",
          year: 2007,
          label: "XL",
          tracks: ["15 Step"],
          coverArtUrls: [],
          tags: ["alternative rock"]
        } as never;
      }
      if (command === "fetch_lyrics") {
        throw new Error("lyrics source unreachable");
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: Array<{ album: string; cover: unknown; lyrics: unknown }> = [];
    render(
      <ResearchPanel onApply={(album, cover, lyrics) => applied.push({ album: album.album, cover, lyrics })} />
    );
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual({ album: "In Rainbows", cover: undefined, lyrics: [] });
    expect(screen.getByTestId("lyrics-coverage")).toHaveTextContent("Lyrics: 0/1 tracks · Lyrics not found for 1 track.");
    expect(screen.getByTestId("lyrics-error-details")).toHaveTextContent("lyrics source unreachable");
    expect(screen.queryByTestId("research-error")).not.toBeInTheDocument();
  });

  it("fetches lyrics for every track and stops early when the lyrics source is down", async () => {
    const fetched: string[] = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") {
        return {
          artist: "Radiohead",
          album: "In Rainbows",
          year: 2007,
          label: "XL",
          tracks: ["15 Step", "Bodysnatchers", "Nude", "Weird Fishes/Arpeggi", "All I Need"],
          coverArtUrls: [],
          tags: ["alternative rock"]
        } as never;
      }
      if (command === "generate_cover") {
        return { imagePath: "C:/tmp/mock-cover.png", prompt: "cover", palette: [] } as never;
      }
      if (command === "fetch_lyrics") {
        fetched.push(String(args?.title));
        throw new Error("lyrics source unreachable");
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const applied: unknown[] = [];
    render(<ResearchPanel onApply={(_album, _cover, lyrics) => applied.push(lyrics)} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(applied).toHaveLength(1));
    // Circuit breaker: 3 straight failures with zero successes stops the sweep.
    expect(fetched).toEqual(["15 Step", "Bodysnatchers", "Nude"]);
    expect(applied[0]).toEqual([]);
    expect(screen.getByTestId("lyrics-note")).toHaveTextContent("Lyrics not found for 5 tracks.");
    expect(screen.queryByTestId("research-error")).not.toBeInTheDocument();
  });

  it("learns the album theme from the real cover art and feeds the fallback concept prompt", async () => {
    let prompt = "";
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") {
        return {
          artist: "Radiohead",
          album: "In Rainbows",
          year: 2007,
          label: "XL",
          tracks: ["15 Step"],
          coverArtUrls: ["https://coverartarchive.org/release/x/front"],
          tags: ["alternative rock"]
        } as never;
      }
      if (command === "fetch_cover_theme") {
        return {
          sourceUrl: "https://coverartarchive.org/release/x/front",
          previewUrl: "data:image/png;base64,abc",
          palette: ["#a01820", "#f0eeea"],
          luminance: 0.31
        } as never;
      }
      if (command === "fetch_real_cover_file") throw new Error("archive unavailable");
      if (command === "generate_cover") {
        prompt = String(args?.prompt);
        return { imagePath: "C:/tmp/mock-cover.png", prompt, palette: [] } as never;
      }
      if (command === "fetch_lyrics") {
        return "15 Step lyrics" as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const appliedThemes: unknown[] = [];
    render(<ResearchPanel onApply={(_album, _cover, _lyrics, theme) => appliedThemes.push(theme)} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(appliedThemes).toHaveLength(1));
    expect(prompt).toBe("");
    await user.click(screen.getByTestId("generate-grounded-cover"));
    await waitFor(() => expect(prompt).not.toBe(""));

    // Theme carried into the project alongside the album.
    expect(appliedThemes[0]).toMatchObject({ palette: ["#a01820", "#f0eeea"] });
    // Learned knowledge is visible: real artwork + extracted swatches.
    expect(screen.getByTestId("theme-source-art")).toHaveAttribute("src", "data:image/png;base64,abc");
    expect(screen.getByTestId("theme-swatches").children).toHaveLength(2);
    expect(screen.getByTestId("theme-tokens")).toHaveTextContent("dark artwork");
    // The learned palette steers cover generation.
    expect(prompt).toContain("#a01820");
    expect(prompt).toContain("Match this album's original visual mood");
  });

  it("loads the original cover first and edits those exact pixels instead of auto-generating a replacement", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const appliedCovers: GeneratedCover[] = [];
    const original: GeneratedCover = {
      imagePath: "C:/tmp/original-cover.png",
      previewUrl: "data:image/png;base64,original",
      palette: ["#18100e"],
      prompt: "real album cover",
      adapter: "real"
    };
    const edited: GeneratedCover = {
      imagePath: "C:/tmp/cartoon-cover.png",
      previewUrl: "data:image/png;base64,cartoon",
      palette: ["#fe3930"],
      prompt: "Make it more cartoonish",
      adapter: "cloudflare-flux2-pro-preview-edit"
    };
    window.__MXTP_INVOKE__ = async (command, args) => {
      calls.push({ command, args });
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") {
        return { sourceUrl: "cover", previewUrl: "data:image/png;base64,theme", palette: ["#18100e"], luminance: 0.2 } as never;
      }
      if (command === "fetch_real_cover_file") {
        return { imagePath: original.imagePath, previewUrl: original.previewUrl, palette: original.palette } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "edit_cover_from_original") return edited as never;
      if (command === "generate_cover") throw new Error("a replacement should not be generated");
      throw new Error(`unexpected command ${command}`);
    };

    const user = userEvent.setup();
    const applied: GeneratedCover[] = [];
    render(
      <ResearchPanel
        onApply={(_album, cover) => {
          if (cover) applied.push(cover);
        }}
        onCover={(cover) => appliedCovers.push(cover)}
      />
    );
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("cover-editor");

    expect(applied).toEqual([original]);
    expect(calls.some(({ command }) => command === "generate_cover")).toBe(false);
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Real album artwork");
    expect(screen.getByTestId("apply-original-edit")).toBeDisabled();

    await user.type(screen.getByTestId("cover-edit-instruction"), "Make it more cartoonish");
    await user.click(screen.getByTestId("apply-original-edit"));

    await waitFor(() => expect(appliedCovers).toEqual([edited]));
    expect(calls).toContainEqual({
      command: "edit_cover_from_original",
      args: { sourceImagePath: original.imagePath, instruction: "Make it more cartoonish" }
    });
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Original-cover edit / Cloudflare FLUX.2 Pro");
    expect(screen.getByTestId("cover-edit-history")).toHaveTextContent("Make it more cartoonish");

    await user.click(screen.getByTestId("reset-original-cover"));
    expect(appliedCovers).toEqual([edited, original]);
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Real album artwork");
  });

  it("keeps the current cover and the typed instruction when the original-cover edit fails", async () => {
    const original: GeneratedCover = {
      imagePath: "C:/tmp/original-cover.png",
      previewUrl: "data:image/png;base64,original",
      palette: ["#18100e"],
      prompt: "real album cover",
      adapter: "real"
    };
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") {
        return { sourceUrl: "cover", previewUrl: "data:image/png;base64,theme", palette: ["#18100e"], luminance: 0.2 } as never;
      }
      if (command === "fetch_real_cover_file") {
        return { imagePath: original.imagePath, previewUrl: original.previewUrl, palette: original.palette } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "edit_cover_from_original") throw new Error("Cloudflare credentials missing");
      if (command === "generate_cover") throw new Error("a replacement should not be generated");
      throw new Error(`unexpected command ${command}`);
    };

    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("cover-editor");
    const input = screen.getByTestId("cover-edit-instruction");
    await user.type(input, "Make it hand-drawn");
    await user.click(screen.getByTestId("apply-original-edit"));

    await waitFor(() => expect(screen.getByTestId("cover-edit-error")).toHaveTextContent("Cloudflare credentials missing"));
    expect(input).toHaveValue("Make it hand-drawn");
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Real album artwork");
    expect(screen.getByTestId("apply-original-edit")).toBeEnabled();
  });

  it("makes the original-cover chat usable while optional theme analysis is still pending", async () => {
    const pendingTheme = deferred<{ sourceUrl: string; previewUrl: string; palette: string[]; luminance: number }>();
    const original = {
      imagePath: "C:/tmp/original-cover.png",
      previewUrl: "data:image/png;base64,original",
      palette: ["#18100e"]
    };
    const edited: GeneratedCover = {
      imagePath: "C:/tmp/edited-before-theme.png",
      previewUrl: "data:image/png;base64,edited",
      palette: ["#f44a4a"],
      prompt: "Make it more cartoonish",
      adapter: "cloudflare-flux2-pro-preview-edit"
    };
    const applied: GeneratedCover[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") return pendingTheme.promise as never;
      if (command === "fetch_real_cover_file") return original as never;
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "edit_cover_from_original") return edited as never;
      if (command === "generate_cover") throw new Error("a replacement should not be generated");
      throw new Error(`unexpected command ${command}`);
    };

    const user = userEvent.setup();
    render(
      <ResearchPanel
        onApply={(_album, cover) => {
          if (cover) applied.push(cover);
        }}
      />
    );
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("cover-editor");
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Real album artwork");
    expect(applied).toEqual([]);
    await user.type(screen.getByTestId("cover-edit-instruction"), "Make it more cartoonish");
    await user.click(screen.getByTestId("apply-original-edit"));
    await waitFor(() => expect(screen.getByTestId("cover-provider")).toHaveTextContent("Original-cover edit"));

    await act(async () => {
      pendingTheme.resolve({
        sourceUrl: "cover",
        previewUrl: "data:image/png;base64,theme",
        palette: ["#18100e"],
        luminance: 0.2
      });
      await pendingTheme.promise;
    });
    await waitFor(() => expect(applied).toEqual([edited]));
  });

  it("fetches a real cover on demand when initial source resolution failed", async () => {
    const pendingReal = deferred<{ imagePath: string; previewUrl: string; palette: string[] }>();
    const appliedCovers: GeneratedCover[] = [];
    let realFetches = 0;
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") {
        return { sourceUrl: "cover", previewUrl: "data:image/png;base64,theme", palette: ["#102030"], luminance: 0.4 } as never;
      }
      if (command === "generate_cover") {
        return { imagePath: "C:/tmp/initial.png", previewUrl: "data:image/png;base64,initial", prompt: "initial", palette: [], adapter: "pollinations" } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "fetch_real_cover_file") {
        realFetches += 1;
        if (realFetches === 1) throw new Error("archive unavailable during lookup");
        return pendingReal.promise as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={(cover) => appliedCovers.push(cover)} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(screen.getByTestId("use-real-cover")).toHaveTextContent("Retry"));

    await user.click(screen.getByTestId("use-real-cover"));
    expect(screen.getByTestId("use-real-cover")).toHaveTextContent("Fetching");
    expect(screen.getByTestId("generate-grounded-cover")).toBeDisabled();
    expect(screen.getByTestId("cover-direction")).toBeDisabled();

    await act(async () => {
      pendingReal.resolve({
        imagePath: "C:/tmp/real-cover.png",
        previewUrl: "data:image/png;base64,real",
        palette: ["#abcdef"]
      });
      await pendingReal.promise;
    });
    await waitFor(() => expect(appliedCovers).toHaveLength(1));
    expect(appliedCovers[0]).toEqual({
      imagePath: "C:/tmp/real-cover.png",
      previewUrl: "data:image/png;base64,real",
      palette: ["#abcdef"],
      prompt: "real album cover",
      adapter: "real"
    });
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Real album artwork");
    expect(screen.queryByTestId("real-cover-note")).not.toBeInTheDocument();
    // One restore control: the original is showing, so Undo edits has nothing to undo.
    expect(screen.queryByTestId("use-real-cover")).not.toBeInTheDocument();
    expect(screen.getByTestId("reset-original-cover")).toBeDisabled();
    expect(screen.getByTestId("cover-direction")).toBeEnabled();
  });

  it("surfaces a real-cover failure and restores the cover controls", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") throw new Error("theme unavailable");
      if (command === "generate_cover") {
        return { imagePath: "C:/tmp/initial.png", prompt: "initial", palette: [], adapter: "codex" } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "fetch_real_cover_file") throw new Error("archive download failed");
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() => expect(screen.getByTestId("use-real-cover")).toHaveTextContent("Retry"));
    await user.click(screen.getByTestId("use-real-cover"));

    await waitFor(() =>
      expect(screen.getByTestId("real-cover-note")).toHaveTextContent("Real cover download failed: archive download failed")
    );
    expect(screen.getByTestId("use-real-cover")).toBeEnabled();
    expect(screen.getByTestId("generate-grounded-cover")).toBeEnabled();
  });

  it("sends the selected direction through vision and emits the grounded cover after its busy state", async () => {
    const pendingGrounded = deferred<GeneratedCover>();
    const appliedCovers: GeneratedCover[] = [];
    let visionArgs: Record<string, unknown> | undefined;
    let groundedArgs: Record<string, unknown> | undefined;
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") {
        return { sourceUrl: "cover", previewUrl: "data:image/png;base64,theme", palette: ["#102030"], luminance: 0.4 } as never;
      }
      if (command === "fetch_real_cover_file") {
        return { imagePath: "C:/tmp/original.png", previewUrl: "data:image/png;base64,original", palette: ["#102030"] } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "fetch_era_covers") return ["era-1", "era-2"] as never;
      if (command === "art_direct_from_references") {
        visionArgs = args;
        return "Macro glass forms over precise technical grids" as never;
      }
      if (command === "generate_cover") {
        groundedArgs = args;
        return pendingGrounded.promise as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={(cover) => appliedCovers.push(cover)} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("generate-grounded-cover");
    expect(screen.getByTestId("cover-direction").querySelectorAll("option")).toHaveLength(3);
    await user.selectOptions(screen.getByTestId("cover-direction"), "unexpected-hybrid");
    expect(screen.getByTestId("cover-direction-description")).toHaveTextContent("surprising but coherent");
    await user.click(screen.getByText("Create a separate concept"));
    await user.click(screen.getByTestId("generate-grounded-cover"));

    await waitFor(() => expect(screen.getByTestId("generate-grounded-cover")).toHaveTextContent("Generating"));
    expect(screen.getByTestId("reset-original-cover")).toBeDisabled();
    expect(screen.getByTestId("cover-direction")).toBeDisabled();
    await waitFor(() => expect(groundedArgs).toBeDefined());
    expect(visionArgs).toMatchObject({
      coverArtUrls: albumFixture().coverArtUrls,
      eraRefUrls: ["era-1", "era-2"]
    });
    expect(String(visionArgs?.albumLabel)).toContain("Unexpected hybrid");
    expect(groundedArgs?.styleRefs).toEqual([]);
    expect(String(groundedArgs?.prompt)).toContain("Creative distance: Unexpected hybrid");
    expect(String(groundedArgs?.prompt)).toContain("Highest priority - visual grammar extracted from the real cover");
    expect(String(groundedArgs?.prompt)).toContain("Macro glass forms over precise technical grids");

    const groundedCover: GeneratedCover = {
      imagePath: "C:/tmp/grounded.png",
      previewUrl: "data:image/png;base64,grounded",
      prompt: String(groundedArgs?.prompt),
      palette: ["#102030"],
      adapter: "cloudflare"
    };
    await act(async () => {
      pendingGrounded.resolve(groundedCover);
      await pendingGrounded.promise;
    });
    await waitFor(() => expect(appliedCovers).toEqual([groundedCover]));
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Cloudflare Workers AI / FLUX");
  });

  it("falls back to the selected print-art brief when era lookup and vision both fail", async () => {
    const appliedCovers: GeneratedCover[] = [];
    let generateCount = 0;
    let fallbackArgs: Record<string, unknown> | undefined;
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") throw new Error("theme unavailable");
      if (command === "fetch_real_cover_file") throw new Error("archive unavailable");
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "fetch_era_covers") throw new Error("era lookup unavailable");
      if (command === "art_direct_from_references") throw new Error("vision unavailable");
      if (command === "generate_cover") {
        generateCount += 1;
        fallbackArgs = args;
        return {
          imagePath: "C:/tmp/fallback.png",
          previewUrl: "data:image/png;base64,fallback",
          prompt: String(args?.prompt),
          palette: [],
          adapter: "pollinations-nova-canvas"
        } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={(cover) => appliedCovers.push(cover)} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("generate-grounded-cover");
    await user.selectOptions(screen.getByTestId("cover-direction"), "archival");
    await user.click(screen.getByTestId("generate-grounded-cover"));

    await waitFor(() => expect(appliedCovers).toHaveLength(1));
    expect(generateCount).toBe(1);
    expect(fallbackArgs?.styleRefs).toEqual([]);
    expect(String(fallbackArgs?.prompt)).toContain("Direction: Archival / referential");
    expect(String(fallbackArgs?.prompt)).toContain("Title-safe negative space:");
    expect(String(fallbackArgs?.prompt)).not.toContain("Reference analysis to interpret, not copy");
    expect(screen.getByTestId("cover-provider")).toHaveTextContent("Pollinations Nova Canvas");
  });

  it("surfaces grounded-generation errors after showing and clearing the busy state", async () => {
    const pendingGrounded = deferred<GeneratedCover>();
    let generateCount = 0;
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") throw new Error("theme unavailable");
      if (command === "fetch_real_cover_file") throw new Error("archive unavailable");
      if (command === "fetch_lyrics") return "lyrics" as never;
      if (command === "fetch_era_covers") return [] as never;
      if (command === "art_direct_from_references") return "Vision brief" as never;
      if (command === "generate_cover") {
        generateCount += 1;
        return pendingGrounded.promise as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} onCover={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("generate-grounded-cover");
    await user.click(screen.getByTestId("generate-grounded-cover"));
    await waitFor(() => expect(screen.getByTestId("generate-grounded-cover")).toHaveTextContent("Generating"));

    await act(async () => {
      pendingGrounded.reject(new Error("image provider offline"));
      await pendingGrounded.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(screen.getByTestId("research-error")).toHaveTextContent("Grounded cover failed: image provider offline")
    );
    expect(screen.getByTestId("generate-grounded-cover")).toBeEnabled();
    expect(screen.getByTestId("cover-direction")).toBeEnabled();
  });

  it("explains a network failure in plain words with the raw text under Technical details", async () => {
    window.__MXTP_INVOKE__ = async () => {
      throw new Error("MusicBrainz request failed after 3 tries: error sending request for url (http://mb.example/release)");
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    expect(screen.queryByTestId("research-error")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("run-research"));
    const error = await screen.findByTestId("research-error");
    expect(error).toHaveTextContent(
      "Couldn't reach MusicBrainz. Check your internet connection, then click Look up album again."
    );
    expect(error).toHaveAttribute("role", "alert");
    expect(error).not.toHaveTextContent("http");
    expect(screen.getByTestId("research-error-details")).toHaveTextContent("error sending request for url");
  });

  it("keeps a non-network lookup failure readable as is", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") throw new Error("MusicBrainz returned no release for A - B");
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await waitFor(() =>
      expect(screen.getByTestId("research-error")).toHaveTextContent(
        "Album research failed: MusicBrainz returned no release for A - B"
      )
    );
    expect(screen.queryByTestId("research-error-details")).not.toBeInTheDocument();
  });

  it("clears the previous album when a later lookup fails", async () => {
    let lookups = 0;
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") {
        lookups += 1;
        if (lookups === 2) throw new Error("MusicBrainz returned no release for Daft Punk - Nope");
        return albumFixture({ coverArtUrls: [] }) as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("research-result");
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("research-error");
    expect(screen.queryByTestId("research-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cover-thumb")).not.toBeInTheDocument();
  });

  it("shows that a lookup is working: busy label, aria-busy and a stage line", async () => {
    const pendingLookup = deferred<AlbumInfo>();
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "lookup_album") return pendingLookup.promise as never;
      if (command === "fetch_lyrics") return "lyrics" as never;
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    const section = screen.getByRole("region", { name: "Album" });
    expect(screen.getByTestId("run-research")).toHaveTextContent("Look up album");
    expect(section).toHaveAttribute("aria-busy", "false");
    await user.click(screen.getByTestId("run-research"));

    expect(screen.getByTestId("run-research")).toHaveTextContent("Looking up…");
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("research-stage")).toHaveTextContent("Finding the release…");
    expect(screen.getByTestId("research-stage")).toHaveAttribute("role", "status");

    await act(async () => {
      pendingLookup.resolve(albumFixture({ coverArtUrls: [] }));
      await pendingLookup.promise;
    });
    await waitFor(() => expect(section).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByTestId("research-stage")).toHaveTextContent("");
  });

  it("disables Cover chat with a visible reason when Cloudflare credentials are missing", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "cover_edit_available") return false as never;
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") throw new Error("theme unavailable");
      if (command === "fetch_real_cover_file") {
        return { imagePath: "C:/tmp/original.png", previewUrl: "data:image/png;base64,o", palette: ["#000000"] } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    await screen.findByTestId("cover-editor");
    const line = await screen.findByTestId("cover-edit-unavailable");
    expect(line).toHaveTextContent("Cover edits need Cloudflare Workers AI credentials.");
    expect(screen.getByTestId("cover-edit-instruction")).toBeDisabled();
    expect(screen.getByTestId("apply-original-edit")).toBeDisabled();
    expect(screen.getByTestId("apply-original-edit")).toHaveAttribute("aria-describedby", line.id);
    for (const label of ["Cartoonish", "Hand-drawn", "Print texture"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("labels a real cover as the album cover and keeps chat enabled when credentials exist", async () => {
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "cover_edit_available") return true as never;
      if (command === "lookup_album") return albumFixture() as never;
      if (command === "fetch_cover_theme") throw new Error("theme unavailable");
      if (command === "fetch_real_cover_file") {
        return { imagePath: "C:/tmp/original.png", previewUrl: "data:image/png;base64,o", palette: ["#000000"] } as never;
      }
      if (command === "fetch_lyrics") return "lyrics" as never;
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(<ResearchPanel onApply={() => undefined} />);
    await user.click(screen.getByTestId("run-research"));
    expect(await screen.findByTestId("cover-thumb")).toHaveAttribute("alt", "Album cover");
    expect(screen.queryByTestId("cover-edit-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("cover-edit-instruction")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Hand-drawn" }));
    expect(screen.getByTestId("cover-edit-instruction")).toHaveValue(
      "Make it more hand-drawn, while preserving the subject and layout."
    );
    expect(document.querySelectorAll("figure.cover-preview figcaption")).toHaveLength(1);
  });
});
