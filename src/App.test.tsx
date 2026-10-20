import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { App } from "./App";
import { confirmRealBurn } from "./app/orchestration";
import { buildBookletPdf } from "./booklet/bookletExport";
import { albumKey, type AppleMusicAlbum } from "./library/appleMusic";
import type { ImportedMusicSource } from "./library/multiLibrary";

// What the library stub's buttons hand to App (set per test).
const stub = vi.hoisted(() => ({ album: undefined as unknown, playlist: undefined as unknown }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("./booklet/bookletExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./booklet/bookletExport")>();
  return { ...actual, buildBookletPdf: vi.fn() };
});
vi.mock("./app/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app/orchestration")>();
  return { ...actual, confirmRealBurn: vi.fn() };
});
// The library and booklet manager are other packages' components; App is
// tested against their props contract through small stand-ins.
vi.mock("./library/AppleMusicLibrary", async () => {
  const React = await import("react");
  const h = React.createElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function AppleMusicLibrary(props: any) {
    const [count, setCount] = React.useState(0);
    const [note, setNote] = React.useState("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initial = props.projects.find((project: any) => project.id === props.initialProjectId);
    return h("section", { "data-testid": "apple-library" },
      h("p", { "data-testid": "stub-initial" }, props.initialProjectId ?? "none"),
      h("p", { "data-testid": "stub-error" }, props.appError ?? ""),
      h("p", { "data-testid": "stub-exit" }, String(props.exitProjectSignal ?? 0)),
      h("p", { "data-testid": "stub-projects" }, String(props.projects.length)),
      h("p", { "data-testid": "stub-queue" }, `Burn list: ${count} tracks`),
      h("p", { "data-testid": "stub-note" }, note),
      h("button", { type: "button", onClick: () => setCount((value: number) => value + 1) }, "Add to stub burn list"),
      h("button", { type: "button", onClick: () => initial && props.onOpenProjectStudio?.(initial) }, "Open initial project in studio"),
      h("button", { type: "button", onClick: () => props.onOpenStudio(stub.album) }, "Open album studio"),
      h("button", { type: "button", onClick: () => props.onPreparedAlbum(stub.album, stub.playlist) }, "Prepare album"),
      h("button", {
        type: "button",
        onClick: () => void props.onRefreshApple?.("/x/Library.musicdb").catch((error: Error) => setNote(error.message))
      }, "Read chosen library"),
      h("button", {
        type: "button",
        onClick: () => void props.onImportSource?.("spotify", [{ name: "history.json", path: "history.json", text: "[]" }])
          .then(() => setNote("imported"), (error: Error) => setNote(error.message))
      }, "Import Spotify"),
      h("button", { type: "button", onClick: props.onCreateCustom }, "New custom CD")
    );
  }
  return { AppleMusicLibrary };
});
vi.mock("./booklet/BookletManager", async () => {
  const React = await import("react");
  const h = React.createElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function BookletManager(props: any) {
    return h("section", { "data-testid": "booklet-manager" },
      h("p", { "data-testid": "stub-booklet-pages" }, String(props.pages)),
      h("button", { type: "button", onClick: () => props.onPagesChange(2) }, "Fold 2 pages"),
      h("button", { type: "button", onClick: () => props.onPagesChange(12) }, "12 pages"),
      h("button", { type: "button", "data-testid": "export-booklet", onClick: () => void props.onExport() }, "Export booklet"),
      props.preview
    );
  }
  return { BookletManager };
});

type Handler = (command: string, args?: Record<string, unknown>) => unknown;
const UNHANDLED = Symbol("unhandled");
const NOT_FOUND = "Apple Music library was not found at `/home/test/Music/Library.musicdb`";

/** Route invokes to `handler`; app-start loads default to "nothing saved yet". */
function mockInvoke(handler: Handler = () => UNHANDLED) {
  window.__MXTP_INVOKE__ = (async (command: string, args?: Record<string, unknown>) => {
    const result = await handler(command, args);
    if (result !== UNHANDLED) return result;
    if (command === "load_cd_projects" || command === "list_cached_playlists" || command === "load_imported_music_sources") return [];
    if (command === "import_apple_music_library") throw new Error(NOT_FOUND);
    if (command === "list_burners") return [];
    throw new Error(`unexpected command ${command}`);
  }) as typeof window.__MXTP_INVOKE__;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const transform = { x: 0, y: 0, scale: 1, rotation: 0 };

function savedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "saved-discovery",
    saved: true,
    entry: { artist: "Daft Punk", album: "Discovery", formatId: "jewelcase" },
    tracks: [{ id: "one", title: "One More Time", durationSec: 180, path: "C:/mix/one.opus" }],
    art: [{ slotId: "front", imageRef: "C:/mix/cover.jpg", imageSource: "playlist", transform }],
    researchApplied: ["Daft Punk - Discovery"],
    research: {
      album: { artist: "Daft Punk", album: "Discovery", year: 2001, label: "Virgin", tracks: ["One More Time"], coverArtUrls: [], tags: ["house"] },
      lyricsByTrack: [{ title: "One More Time", lyrics: "Lyrics saved forever" }]
    },
    bookletPages: 12,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-25T00:00:00Z",
    sourcePath: "C:/mix",
    ...overrides
  };
}

function readyItem(id: string, title: string, durationSec = 180) {
  return {
    id,
    albumKey: "daftpunk::discovery",
    title,
    artist: "Daft Punk",
    album: "Discovery",
    durationSec,
    ready: { id: `${id}-audio`, title, artist: "Daft Punk", album: "Discovery", durationSec, path: `C:/mix/${id}.opus` }
  };
}

function spotifySource(): ImportedMusicSource {
  return {
    source: "spotify",
    sourcePath: "history.json",
    importedAt: "2026-09-01T10:00:00.000Z",
    playlists: [],
    limitations: [],
    tracks: [{
      id: "spotify:1",
      title: "Glass Harbor",
      artist: "Neon Tide",
      album: "Static Bloom",
      albumArtist: "Neon Tide",
      genre: "Electronic",
      durationSec: 201,
      playCount: 3,
      likeStatus: 1
    }]
  };
}

function album(artist: string, title: string, overrides: Partial<AppleMusicAlbum> = {}): AppleMusicAlbum {
  return {
    key: albumKey(artist, title),
    title,
    artist,
    genre: "Electronic",
    tracks: [],
    durationSec: 0,
    playCount: 0,
    ...overrides
  };
}

function savedCalls(calls: Array<{ command: string; args?: Record<string, unknown> }>) {
  return calls
    .filter((call) => call.command === "save_cd_project")
    .map((call) => call.args?.project as Record<string, unknown> & {
      entry: { artist: string; album: string; formatId: string };
      burnQueue: Array<{ title: string; ready?: { title: string } }>;
    });
}

const trackTitles = () => screen.getAllByLabelText(/^Edit title for track/).map((input) => (input as HTMLInputElement).value);

async function createFromLanding(user: ReturnType<typeof userEvent.setup>, artist = "", albumTitle = "") {
  await screen.findByTestId("landing-screen");
  if (artist) await user.type(screen.getByLabelText("Artist"), artist);
  if (albumTitle) await user.type(screen.getByLabelText("Album"), albumTitle);
  await user.click(screen.getByRole("button", { name: artist || albumTitle ? "Create album CD" : "Start custom CD" }));
  return screen.findByTestId("detail-view");
}

/** Landing Recent card -> library (album layout first) -> its studio. */
async function openSavedInStudio(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByTestId("apple-library");
  await user.click(screen.getByRole("button", { name: "Open initial project in studio" }));
  return screen.findByTestId("detail-view");
}

beforeEach(() => {
  vi.mocked(confirmRealBurn).mockReset().mockResolvedValue(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  stub.album = undefined;
  stub.playlist = undefined;
});

afterEach(() => {
  window.__MXTP_INVOKE__ = undefined;
  vi.restoreAllMocks();
});

describe("App landing flow", () => {
  it("opens on a minimal landing, swaps the active model, and submits into a prefilled detail view", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      commands.push({ command, args });
      if (command === "lookup_album") {
        return {
          artist: args?.artist,
          album: args?.album,
          year: 2001,
          label: "Virgin",
          tracks: ["One More Time", "Aerodynamic"],
          coverArtUrls: [],
          tags: ["house", "electronic"]
        };
      }
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      if (command === "save_cd_project") return undefined;
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId("landing-screen")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "MXTP MKR" })).toBeVisible();
    expect(screen.getByText("Make a mixtape CD: pick the songs, design the case, burn the disc.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Start a new CD" })).toBeVisible();
    expect(screen.getByText("Leave Artist and Album empty to start a custom mix.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start custom CD" })).toBeVisible();
    expect(screen.getByLabelText("Artist")).toBeVisible();
    expect(screen.getByLabelText("Album")).toBeVisible();
    const format = screen.getByLabelText("Format");
    expect(format).toHaveValue("jewelcase");
    expect(screen.getByTestId("landing-case-model")).toHaveAttribute("data-model-id", "jewelcase");
    // WP6: a scene that cannot start (no WebGL in jsdom) shows its 2D fallback.
    expect(screen.getByTestId("landing-case-model").querySelector("canvas, .canvas-fallback")).toBeTruthy();

    await user.selectOptions(format, "vinyl");
    expect(screen.getByTestId("landing-case-model")).toHaveAttribute("data-model-id", "vinyl");

    await user.type(screen.getByLabelText("Artist"), "Daft Punk");
    await user.type(screen.getByLabelText("Album"), "Discovery");
    await user.click(screen.getByRole("button", { name: "Create album CD" }));

    await expect(screen.findByTestId("detail-view")).resolves.toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Discovery");
    expect(screen.getByTestId("detail-entry-summary")).toHaveTextContent("Daft Punk · Discovery · Vinyl");
    expect(screen.getByText("Unsaved draft")).toBeVisible();
    expect(screen.getByTestId("artist-input")).toHaveValue("Daft Punk");
    expect(screen.getByTestId("album-input")).toHaveValue("Discovery");
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    await waitFor(() => expect(screen.getByTestId("research-result")).toHaveTextContent("One More Time"));
    expect(commands).toContainEqual({
      command: "lookup_album",
      args: { artist: "Daft Punk", album: "Discovery" }
    });
    expect(commands.some((call) => call.command === "save_cd_project")).toBe(false);
    await user.click(screen.getByTestId("save-project-button"));
    await waitFor(() => expect(commands.some((call) => call.command === "save_cd_project")).toBe(true));
    expect(await screen.findByText("Editing project")).toBeVisible();
    expect(screen.getByTestId("save-project-button")).toHaveTextContent("Saved automatically");
  });

  it("shows a neutral loading shell, not the landing form, until the music library has loaded", async () => {
    const apple = deferred<never>();
    mockInvoke((command) => (command === "import_apple_music_library" ? apple.promise : UNHANDLED));
    const { container } = render(<App />);

    expect(await screen.findByText("Loading your library…")).toBeVisible();
    expect(screen.queryByTestId("landing-screen")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Artist")).not.toBeInTheDocument();
    const shellRoot = container.firstElementChild;
    await act(async () => apple.reject(new Error(NOT_FOUND)));
    expect(await screen.findByTestId("landing-screen")).toBeVisible();
    // One root node throughout, so nothing holding the shell goes stale.
    expect(container.firstElementChild).toBe(shellRoot);
  });

  it("surfaces GO validation failures as plain steps instead of silently doing nothing", async () => {
    mockInvoke((command) => {
      if (command === "lookup_album") throw new Error("offline");
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Daft Punk", "Discovery");

    expect(screen.queryByTestId("go-error")).not.toBeInTheDocument();
    const go = screen.getByTestId("go-button");
    expect(go).toHaveTextContent("Export print files + test burn");
    expect(go.closest("section")).toHaveClass("panel", "print-burn");
    await user.click(go);
    await waitFor(() =>
      expect(screen.getByTestId("go-error")).toHaveTextContent(
        "Add audio first (step 2, Audio). Add front, tray and disc art (step 3, Artwork)."
      )
    );
    expect(screen.getByTestId("go-error")).not.toHaveTextContent("audio required");
  });

  it("downloads the best playlist audio into the burn list and leaves burning as a separate step", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      commands.push({ command, args });
      if (command === "lookup_album") throw new Error("offline");
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      if (command === "list_burners") return [{ id: "burner-1", name: "D: CD Writer" }];
      if (command === "fetch_lyrics") throw new Error("no lyrics");
      if (command === "download_playlist_best") {
        return {
          title: "Road Mix",
          quality: "Best available source stream per track (no lossy re-encode)",
          coverPath: "C:/mix/cover.jpg",
          tracks: [{ id: "C:/mix/001.opus", title: "First", durationSec: 180, path: "C:/mix/001.opus" }]
        };
      }
      if (command === "prepare_pcm") {
        return [{ path: "C:/tmp/001.wav", durationSec: 180, sampleRate: 44100, channels: 2, bitsPerSample: 16 }];
      }
      if (command === "build_cda_image") return { tracks: [], leadinSectors: 4500, leadoutSectors: 6750, totalSectors: 24750 };
      if (command === "burn_cda") return { progress: [0, 100], finalPercent: 100, message: "CD burn complete" };
      if (command === "save_cd_project") return undefined;
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Various", "Road Mix");
    expect(screen.getByTestId("playlist-burn-button")).toBeDisabled();
    expect(screen.getByText("Paste a YouTube playlist link")).toBeInTheDocument();
    await user.click(screen.getByText("Use a YouTube playlist link instead"));
    await user.type(screen.getByLabelText("YouTube playlist link"), "https://www.youtube.com/playlist?list=PL123");
    const download = screen.getByTestId("playlist-burn-button");
    expect(download).toHaveTextContent("Download playlist");
    expect(download.closest(".audio-source-actions")).toBeTruthy();
    await user.click(download);

    await waitFor(() =>
      expect(screen.getByTestId("burn-message")).toHaveTextContent("1 track is audio ready forever. Click Burn CD when ready.")
    );
    expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("First");
    expect(screen.getByTestId("composed-inserts")).toHaveTextContent("front cover.jpg");
    expect(commands).toContainEqual({
      command: "download_playlist_best",
      args: { url: "https://www.youtube.com/playlist?list=PL123" }
    });
    // Download never chains into a burn.
    expect(confirmRealBurn).not.toHaveBeenCalled();
    expect(commands.some((call) => call.command === "prepare_pcm" || call.command === "burn_cda")).toBe(false);

    const burn = screen.getByTestId("burn-cd-button");
    expect(burn).toHaveTextContent("Burn CD");
    await user.click(burn);
    await waitFor(() => expect(screen.getByTestId("burn-message")).toHaveTextContent("CD burn complete"));
    expect(confirmRealBurn).toHaveBeenCalledWith("D: CD Writer", 1, "Road Mix");
    expect(commands).toContainEqual({
      command: "prepare_pcm",
      args: { paths: ["C:/mix/001.opus"], gapSec: 0, normalize: false }
    });
    expect(commands).toContainEqual({
      command: "build_cda_image",
      args: {
        tracks: [{ path: "C:/tmp/001.wav", durationSec: 180, sampleRate: 44100, channels: 2, bitsPerSample: 16 }],
        cdText: { albumTitle: "Road Mix", albumArtist: "Various", tracks: [{ title: "First", artist: "Various" }] }
      }
    });
    expect(commands).toContainEqual({
      command: "burn_cda",
      args: expect.objectContaining({ drive: "burner-1", simulate: false })
    });
    const burned = savedCalls(commands).find((project) => project.lastBurnedAt);
    expect(burned).toEqual(expect.objectContaining({
      saved: true,
      lastBurnedAt: expect.any(String),
      art: expect.arrayContaining([
        expect.objectContaining({ slotId: "front", imageRef: "C:/mix/cover.jpg", imageSource: "playlist" })
      ])
    }));
    expect(burned?.burnQueue.map((item) => item.ready?.title)).toEqual(["First"]);
    await waitFor(() => expect(screen.getByTestId("burn-cd-button")).toHaveTextContent("Burn CD again"));
    expect(screen.getByTestId("last-burned")).toHaveTextContent("Last burned");
  });

  it("keeps a chosen front cover when a playlist with its own cover is downloaded", async () => {
    mockInvoke((command) => {
      if (command === "load_cd_projects") {
        return [savedProject({
          id: "chosen-front",
          tracks: [],
          art: [{ slotId: "front", imageRef: "C:/art/my-pick.png", imageSource: "manual", transform }],
          playlistUrl: "https://www.youtube.com/playlist?list=PL9"
        })];
      }
      if (command === "download_playlist_best") {
        return { title: "Discovery", quality: "best", coverPath: "C:/mix/yt-cover.jpg", tracks: [{ id: "t1", title: "One More Time", durationSec: 180, path: "C:/mix/t1.opus" }] };
      }
      if (command === "save_cd_project") return undefined;
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    await user.click(screen.getByTestId("playlist-burn-button"));
    await waitFor(() => expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("One More Time"));
    expect(screen.getByTestId("composed-inserts")).toHaveTextContent("front my-pick.png");
  });

  it("surfaces an explicit project save failure in the studio header instead of reporting silent success", async () => {
    mockInvoke((command) => {
      if (command === "lookup_album") throw new Error("offline");
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      if (command === "save_cd_project") throw new Error("disk is read-only");
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Artist", "Album");
    await user.click(await screen.findByTestId("save-project-button"));

    const alert = await screen.findByTestId("project-save-error");
    expect(alert).toHaveTextContent("Could not save this project: disk is read-only");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.closest("header")).toHaveClass("app-header");
    await user.click(screen.getByTestId("catalog-button"));
    expect(screen.queryByRole("button", { name: "Open Album" })).not.toBeInTheDocument();
    expect(await screen.findByText("Saved projects and completed burns will appear here.")).toBeVisible();
  });

  it("exports the booklet with the applied album tracklist when no audio is imported and cover generation failed", async () => {
    mockInvoke((command, args) => {
      if (command === "lookup_album") {
        return { artist: "Radiohead", album: "In Rainbows", year: 2007, label: "XL", tracks: ["15 Step", "Bodysnatchers"], coverArtUrls: [], tags: ["alternative rock"] };
      }
      if (command === "generate_cover") throw new Error("codex produced no image");
      if (command === "fetch_lyrics") return `${String(args?.title)} lyrics`;
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      return UNHANDLED;
    });
    vi.mocked(buildBookletPdf).mockResolvedValue(Uint8Array.from([37, 80, 68, 70]));
    vi.mocked(save).mockResolvedValue("C:/out/booklet-CD1600R.pdf");

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Radiohead", "In Rainbows");
    await waitFor(() => expect(screen.getByTestId("research-applied")).toHaveTextContent("Radiohead - In Rainbows"));

    await user.click(screen.getByTestId("export-booklet"));
    await waitFor(() => expect(buildBookletPdf).toHaveBeenCalled());
    expect(buildBookletPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        coverImage: undefined,
        tracks: [{ title: "15 Step" }, { title: "Bodysnatchers" }],
        lyricsByTrack: [
          { title: "15 Step", lyrics: "15 Step lyrics" },
          { title: "Bodysnatchers", lyrics: "Bodysnatchers lyrics" }
        ],
        credits: "Radiohead — In Rainbows (2007) XL"
      })
    );
  });

  it("ignores a booklet page count that has no print template", async () => {
    mockInvoke((command) => {
      if (command === "lookup_album") throw new Error("offline");
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user);
    expect(screen.getByTestId("stub-booklet-pages")).toHaveTextContent("16");
    await user.click(screen.getByRole("button", { name: "Fold 2 pages" }));
    expect(screen.getByTestId("stub-booklet-pages")).toHaveTextContent("16");
    await user.click(screen.getByRole("button", { name: "12 pages" }));
    expect(screen.getByTestId("stub-booklet-pages")).toHaveTextContent("12");
  });

  it("opens a Recent project in the library first, then its studio with cover, audio, burn and delete", async () => {
    vi.mocked(readFile).mockResolvedValue(Uint8Array.from([79, 103, 103, 83]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mxtp-one-opus");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const commands: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_cd_projects") return [savedProject({ saved: undefined, burnProgress: 100 })];
      if (command === "save_cd_project" || command === "delete_cd_project") return undefined;
      if (command === "list_burners") return [{ id: "burner-1", name: "D: CD Writer" }];
      if (command === "prepare_pcm") return [{ path: "C:/tmp/one.wav", durationSec: 180, sampleRate: 44100, channels: 2, bitsPerSample: 16 }];
      if (command === "build_cda_image") return { tracks: [], leadinSectors: 4500, leadoutSectors: 6750, totalSectors: 24750 };
      if (command === "burn_cda") return { progress: [0, 100], finalPercent: 100, message: "Reburn complete" };
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open Discovery" }));
    // Album layout + tracklist first: the library opens with the project, the studio stays closed.
    expect(await screen.findByTestId("stub-initial")).toHaveTextContent("saved-discovery");
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open initial project in studio" }));
    expect(await screen.findByTestId("detail-view")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Discovery");
    expect(screen.getByText("Editing project")).toBeVisible();
    expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("One More Time");
    expect(screen.queryByTestId("layout-options")).not.toBeInTheDocument();
    expect(screen.getByText("Booklet: 12 pages · lyrics for 1 tracks · export it in Booklet")).toBeVisible();
    expect(screen.getByText("Front cover: ✓ cover.jpg")).toBeVisible();
    expect(screen.getAllByAltText("Front cover artwork")[0]).toHaveAttribute("src", expect.stringContaining("cover.jpg"));
    const title = screen.getByLabelText("Edit title for track 1");
    await user.clear(title);
    await user.type(title, "One More Time (Album Mix)");
    await user.click(screen.getByRole("button", { name: /^Play\b/ }));
    await waitFor(() => expect(screen.getByTestId("audio-player")).toHaveAttribute("src", "blob:mxtp-one-opus"));
    // "Now playing" follows the player, so it shows once playback starts.
    fireEvent.playing(screen.getByTestId("audio-player"));
    expect(screen.getByTestId("prelisten")).toHaveTextContent("One More Time (Album Mix)");
    expect(readFile).toHaveBeenCalledWith("C:/mix/one.opus");
    const burn = screen.getByTestId("burn-cd-button");
    await waitFor(() => expect(burn).toBeEnabled());
    expect(burn).toHaveTextContent("Burn CD");
    await user.click(burn);
    await waitFor(() => expect(screen.getByTestId("burn-message")).toHaveTextContent("Reburn complete"));
    expect(commands).toContain("burn_cda");
    expect(screen.getByTestId("burn-cd-button")).toHaveTextContent("Burn CD again");

    expect(screen.queryByTestId("delete-project-button")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    await user.click(screen.getByTestId("delete-project-button"));
    expect(screen.getByRole("alertdialog", { name: "Delete Discovery?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep project" }));
    expect(commands).not.toContain("delete_cd_project");

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getByTestId("delete-project-button")).toHaveTextContent("Delete project…");
    await user.click(screen.getByTestId("delete-project-button"));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(commands).toContain("delete_cd_project"));
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("apple-library")).toBeVisible();
    expect(screen.getByTestId("stub-initial")).toHaveTextContent("none");
  });

  it("enriches a recovered playlist, shows its inferred artist, and saves lyrics without rewriting the artist", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      calls.push({ command, args });
      if (command === "load_cd_projects") {
        return [savedProject({
          id: "recovered-pretti",
          name: "Pretti Loves U 2",
          kind: "artist",
          entry: { artist: "", album: "Pretti Loves U 2", formatId: "jewelcase" },
          burnQueue: [],
          tracks: [{ id: "C:/mix/nobody.opus", title: "prettifun - Nobody (Official Video)", durationSec: 180, path: "C:/mix/nobody.opus" }],
          researchApplied: [],
          research: {
            album: { artist: "", album: "Pretti Loves U 2", year: 2026, label: "Victor Victor", tracks: ["prettifun - Nobody (Official Video)"], coverArtUrls: [], tags: [] },
            lyricsByTrack: []
          },
          bookletPages: 8
        })];
      }
      if (command === "save_cd_project") return undefined;
      if (command === "fetch_lyrics") {
        expect(args).toEqual({ artist: "prettifun", title: "Nobody" });
        return "Recovered lyric line";
      }
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Pretti Loves U 2");

    await waitFor(() => expect(screen.getByText("Booklet: 8 pages · lyrics for 1 tracks · export it in Booklet")).toBeVisible());
    expect(screen.getByTestId("lyrics-status")).toHaveTextContent("Saved lyrics for 1 of 1 tracks.");
    expect(screen.getByTestId("detail-entry-summary")).toHaveTextContent("prettifun");
    expect(screen.getAllByAltText("Front cover artwork")[0]).toHaveAttribute("src", expect.stringContaining("cover.jpg"));
    await waitFor(() => {
      const saved = savedCalls(calls).find((project) => (project.research as { lyricsByTrack: unknown[] }).lyricsByTrack.length === 1);
      expect(saved).toBeTruthy();
      // The guess is for display and CD-Text only; the saved mix stays artist-less.
      expect(saved?.entry.artist).toBe("");
    });
  });

  it("finds the album playlist after Create and names the channel without its ' - Topic' suffix", async () => {
    mockInvoke((command, args) => {
      if (command === "find_youtube_album_playlist") {
        expect(args).toEqual({ artist: "Prettifun", album: "Pretti Loves U 2", expectedTracks: [] });
        return { url: "https://www.youtube.com/playlist?list=official", title: "Pretti Loves U 2", artist: "prettifun - Topic", trackCount: 12, safeTrackPositions: [] };
      }
      if (command === "lookup_album") {
        return { artist: "Prettifun", album: "Pretti Loves U 2", year: 2026, label: "Independent", tracks: [], coverArtUrls: [], tags: [] };
      }
      if (command === "generate_cover") throw new Error("optional cover unavailable");
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Prettifun", "Pretti Loves U 2");

    await waitFor(() => expect(screen.getByLabelText("YouTube playlist link")).toHaveValue(
      "https://www.youtube.com/playlist?list=official"
    ));
    expect(screen.getByTestId("burn-message")).toHaveTextContent(
      "Found prettifun: Pretti Loves U 2 (12 tracks). Click Find album audio to download it."
    );
  });

  it("downloads only the matched playlist's safe tracks, but a pasted link downloads the whole playlist", async () => {
    const downloads: Array<Record<string, unknown> | undefined> = [];
    mockInvoke((command, args) => {
      if (command === "lookup_album") throw new Error("offline");
      if (command === "find_youtube_album_playlist") {
        return { url: "https://www.youtube.com/playlist?list=matched", title: "Tones", artist: "Osc", trackCount: 3, safeTrackPositions: [1, 3] };
      }
      if (command === "download_playlist_best") {
        downloads.push(args);
        return { title: "Tones", quality: "best", tracks: [{ id: `t${downloads.length}`, title: `Tone ${downloads.length}`, durationSec: 60, path: `C:/t${downloads.length}.opus` }] };
      }
      if (command === "fetch_lyrics") throw new Error("none");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Osc", "Tones");
    await waitFor(() => expect(screen.getByTestId("burn-message")).toHaveTextContent("Found Osc: Tones (3 tracks)"));
    await waitFor(() => expect(screen.getByTestId("find-album-burn-button")).toBeEnabled());
    await user.click(screen.getByTestId("find-album-burn-button"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ url: "https://www.youtube.com/playlist?list=matched", playlistItems: "1,3" });
    await waitFor(() => expect(screen.getByTestId("find-album-burn-button")).toBeEnabled());

    await user.click(screen.getByText("Use a YouTube playlist link instead"));
    const link = screen.getByLabelText("YouTube playlist link");
    await user.clear(link);
    await user.type(link, "https://www.youtube.com/playlist?list=pasted");
    await user.click(screen.getByTestId("playlist-burn-button"));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[1]).toEqual({ url: "https://www.youtube.com/playlist?list=pasted" });
  });

  it("uses the YouTube release tracklist as the metadata and lyrics fallback, keeping the download result visible", async () => {
    mockInvoke((command) => {
      if (command === "lookup_album") throw new Error("artist was not found");
      if (command === "find_youtube_album_playlist") {
        return { url: "https://www.youtube.com/playlist?list=official", title: "Rare Album", artist: "Rare Artist", trackCount: 1 };
      }
      if (command === "download_playlist_best") {
        return { title: "Rare Album", quality: "best", coverPath: "C:/rare/cover.jpg", tracks: [{ id: "rare", title: "Deep Cut", durationSec: 200, path: "C:/rare/deep-cut.opus" }] };
      }
      if (command === "fetch_lyrics") return "Recovered lyrics";
      return UNHANDLED;
    });

    const user = userEvent.setup();
    render(<App />);
    await createFromLanding(user, "Rare Artist", "Rare Album");
    await waitFor(() => expect(screen.getByTestId("find-album-burn-button")).toBeEnabled());
    await user.click(screen.getByTestId("find-album-burn-button"));

    await waitFor(() => expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("Deep Cut"));
    await waitFor(() => expect(screen.getByTestId("lyrics-status")).toHaveTextContent("Saved lyrics for 1 of 1 tracks."));
    expect(screen.getByText("Booklet: 16 pages · lyrics for 1 tracks · export it in Booklet")).toBeVisible();
    expect(screen.getByTestId("composed-inserts")).toHaveTextContent("front cover.jpg");
    expect(screen.getByTestId("burn-message")).toHaveTextContent("1 track is audio ready forever. Click Burn CD when ready.");
  });

  it("never searches YouTube by itself when a saved artist project without audio is reopened", async () => {
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_cd_projects") return [savedProject({ tracks: [], art: [], sourcePath: undefined })];
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(commands).not.toContain("find_youtube_album_playlist");
    expect(screen.getByTestId("find-album-burn-button")).toHaveTextContent("Find album audio");
  });
});

describe("App studio: burn list, capacity and busy state", () => {
  it("plays the burn list in its own order and leaves out tracks removed in the library", async () => {
    mockInvoke((command) => {
      if (command === "load_cd_projects") {
        return [savedProject({
          tracks: [readyItem("a", "Aerodynamic").ready, readyItem("b", "Burnin").ready, readyItem("c", "Crescendolls").ready],
          // The library reordered to [b, a] and removed c.
          burnQueue: [readyItem("b", "Burnin"), readyItem("a", "Aerodynamic")]
        })];
      }
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    expect(trackTitles()).toEqual(["Burnin", "Aerodynamic"]);
  });

  it("writes studio edits back to the burn list in the same order", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      calls.push({ command, args });
      if (command === "load_cd_projects") {
        return [savedProject({
          tracks: [readyItem("a", "Aerodynamic").ready, readyItem("b", "Burnin").ready],
          // Reordered in the library; reorders inside the studio are covered by writeTracksToQueue.
          burnQueue: [readyItem("b", "Burnin"), readyItem("a", "Aerodynamic")]
        })];
      }
      if (command === "save_cd_project") return undefined;
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    expect(trackTitles()).toEqual(["Burnin", "Aerodynamic"]);
    await user.type(screen.getByLabelText("Edit title for track 1"), "!");
    await waitFor(() => {
      const last = savedCalls(calls).at(-1);
      expect(last?.burnQueue.map((item) => item.title)).toEqual(["Burnin!", "Aerodynamic"]);
      expect(last?.burnQueue.map((item) => item.ready?.title)).toEqual(["Burnin!", "Aerodynamic"]);
    });
  });

  it("merely opening a saved project in the studio does not save it", async () => {
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_cd_projects") return [savedProject()];
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(commands).not.toContain("save_cd_project");
    await user.click(screen.getByTestId("catalog-button"));
    await screen.findByTestId("apple-library");
    expect(commands).not.toContain("save_cd_project");
  });

  it("blocks an over-80-minute burn and export before asking to burn", async () => {
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_cd_projects") {
        return [savedProject({ tracks: [], burnQueue: [readyItem("a", "Long One", 41 * 60), readyItem("b", "Long Two", 40 * 60)] })];
      }
      if (command === "list_burners") return [{ id: "burner-1", name: "D: CD Writer" }];
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    const burn = screen.getByTestId("burn-cd-button");
    await waitFor(() => expect(burn).toBeEnabled());
    await user.click(burn);
    expect(screen.getByTestId("burn-message")).toHaveTextContent("Over by 1:03. Remove tracks to fit an 80-minute CD.");
    await user.click(screen.getByTestId("go-button"));
    expect(screen.getByTestId("go-error")).toHaveTextContent("Over by 1:03. Remove tracks to fit an 80-minute CD.");
    expect(confirmRealBurn).not.toHaveBeenCalled();
    expect(commands).not.toContain("prepare_pcm");
  });

  it("names a track with no audio file instead of trying to burn it", async () => {
    mockInvoke((command) => {
      if (command === "load_cd_projects") {
        const item = readyItem("a", "Lost Song");
        return [savedProject({ tracks: [], burnQueue: [{ ...item, ready: { ...item.ready, path: undefined } }] })];
      }
      if (command === "list_burners") return [{ id: "burner-1", name: "D: CD Writer" }];
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    await waitFor(() => expect(screen.getByTestId("burn-cd-button")).toBeEnabled());
    await user.click(screen.getByTestId("burn-cd-button"));
    expect(screen.getByTestId("burn-message")).toHaveTextContent("Re-add Lost Song with Add audio files…");
    expect(confirmRealBurn).not.toHaveBeenCalled();
  });

  it("runs one export for a double-click, shows its stage, and keeps the old exports when it fails", async () => {
    const pcm = deferred<unknown>();
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_cd_projects") return [savedProject({ exports: ["C:/old/front.pdf"] })];
      if (command === "prepare_pcm") return pcm.promise;
      if (command === "compose_pdf") throw new Error("image is too small. It needs 1772 px.");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    const go = screen.getByTestId("go-button");
    await user.dblClick(go);
    expect(go).toBeDisabled();
    expect(go).toHaveTextContent("Exporting…");
    expect(screen.getByTestId("studio-busy")).toHaveTextContent("Preparing audio…");
    expect(screen.getByTestId("catalog-button")).toBeDisabled();
    expect(commands.filter((command) => command === "prepare_pcm")).toHaveLength(1);
    await act(async () => pcm.reject(new Error("ffmpeg missing")));
    await waitFor(() => expect(screen.getByTestId("go-error")).toHaveTextContent("Export stopped. Preparing audio: ffmpeg missing Front cover: image is too small."));
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByTestId("export-list")).toHaveTextContent("Exports: C:/old/front.pdf");
    expect(screen.getByTestId("catalog-button")).toBeEnabled();
  });

  it("locks leaving the studio and shows the burn stage while a burn is running", async () => {
    const pcm = deferred<unknown>();
    mockInvoke((command) => {
      if (command === "load_cd_projects") return [savedProject()];
      if (command === "list_burners") return [{ id: "burner-1", name: "D: CD Writer" }];
      if (command === "prepare_pcm") return pcm.promise;
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    await waitFor(() => expect(screen.getByTestId("burn-cd-button")).toBeEnabled());
    await user.click(screen.getByTestId("burn-cd-button"));
    await waitFor(() => expect(screen.getByTestId("studio-busy")).toHaveTextContent("Converting audio…"));
    expect(screen.getByTestId("studio-busy")).toHaveTextContent("Finish the current burn or download first.");
    expect(screen.getByTestId("catalog-button")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exit project" })).toBeDisabled();
    expect(screen.getByTestId("burn-cd-button")).toBeDisabled();
    await act(async () => pcm.reject(new Error("stopped")));
    await waitFor(() => expect(screen.getByTestId("burn-message")).toHaveTextContent("Burn failed: stopped"));
    expect(screen.getByTestId("catalog-button")).toBeEnabled();
  });

  it("replaces a stale no-writer message with the drive Detect drives found", async () => {
    let drives: Array<{ id: string; name: string }> = [];
    mockInvoke((command) => {
      if (command === "load_cd_projects") return [savedProject()];
      if (command === "list_burners") return drives;
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Discovery");
    expect(screen.getByTestId("burn-cd-button")).toBeDisabled();
    expect(screen.getByTestId("burner-status")).toHaveTextContent("No CD writer found.");
    await user.click(screen.getByTestId("detect-burners"));
    expect(await screen.findByTestId("burn-message")).toHaveTextContent("No CD writer found.");
    drives = [{ id: "burner-1", name: "D: CD Writer" }];
    await user.click(screen.getByTestId("detect-burners"));
    await waitFor(() => expect(screen.getByTestId("burn-message")).toHaveTextContent("Found D: CD Writer"));
    expect(screen.getAllByTestId("burn-message")).toHaveLength(1);
    expect(screen.getByTestId("burn-cd-button")).toBeEnabled();
  });
});

describe("App shell: library, landing and load errors", () => {
  it("keeps the library mounted but hidden behind the studio, and returns to it", async () => {
    stub.album = album("Neon Tide", "Static Bloom");
    mockInvoke((command) => {
      if (command === "load_imported_music_sources") return [spotifySource()];
      if (command === "lookup_album") throw new Error("offline");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("apple-library");
    await user.click(screen.getByRole("button", { name: "Add to stub burn list" }));
    expect(screen.getByTestId("stub-queue")).toHaveTextContent("Burn list: 1 tracks");

    await user.click(screen.getByRole("button", { name: "Open album studio" }));
    const detail = await screen.findByTestId("detail-view");
    const library = screen.getByTestId("apple-library");
    expect(detail).toBeVisible();
    expect(library).toBeInTheDocument();
    expect(library).not.toBeVisible();
    expect(screen.getByText("Burn list: 1 tracks")).not.toBeVisible();
    // The studio comes first in the DOM, so text lookups hit studio controls.
    expect(detail.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByTestId("catalog-button"));
    // An unsaved library draft with research asks first.
    const dialog = await screen.findByRole("alertdialog", { name: "Save this CD as a project?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("apple-library")).toBeVisible();
    expect(screen.getByTestId("stub-queue")).toHaveTextContent("Burn list: 1 tracks");
  });

  it("asks before leaving an unsaved draft with content: Cancel stays, Save as project saves and leaves", async () => {
    stub.album = album("Neon Tide", "Static Bloom");
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_imported_music_sources") return [spotifySource()];
      if (command === "lookup_album") throw new Error("offline");
      if (command === "save_cd_project") return undefined;
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("apple-library");
    await user.click(screen.getByRole("button", { name: "Open album studio" }));
    await screen.findByTestId("detail-view");
    await user.click(screen.getByTestId("catalog-button"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("detail-view")).toBeVisible();
    await user.click(screen.getByTestId("catalog-button"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save as project" }));
    await waitFor(() => expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument());
    expect(commands).toContain("save_cd_project");
    expect(screen.getByTestId("apple-library")).toBeVisible();
  });

  it("keeps a digipak project digipak when the library opens its studio or prepares its audio", async () => {
    stub.album = album("Neon Tide", "Static Bloom", { artworkPath: "C:/art/library.jpg" });
    stub.playlist = { title: "Static Bloom", quality: "best", tracks: [{ id: "g", title: "Glass Harbor", durationSec: 201, path: "C:/cache/001 - Glass Harbor.opus" }] };
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      calls.push({ command, args });
      if (command === "load_imported_music_sources") return [spotifySource()];
      if (command === "load_cd_projects") {
        return [savedProject({ id: "bloom", name: "Static Bloom", entry: { artist: "Neon Tide", album: "Static Bloom", formatId: "digipak" }, tracks: [], art: [], research: null })];
      }
      if (command === "save_cd_project") return undefined;
      if (command === "lookup_album") throw new Error("offline");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("apple-library");
    await waitFor(() => expect(screen.getByTestId("stub-projects")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "Prepare album" }));
    await waitFor(() => expect(savedCalls(calls).at(-1)?.entry.formatId).toBe("digipak"));
    await user.click(screen.getByRole("button", { name: "Open album studio" }));
    expect(await screen.findByTestId("detail-entry-summary")).toHaveTextContent("Neon Tide · Static Bloom · Digipak");
  });

  it("opens a burn-list project in the studio by its own name and Exit project signals the library", async () => {
    mockInvoke((command) => {
      if (command === "load_cd_projects") {
        return [savedProject({ id: "road-mix", name: "Road Mix", kind: "custom", entry: { artist: "", album: "Road Mix", formatId: "jewelcase" } })];
      }
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await openSavedInStudio(user, "Road Mix");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Road Mix");
    expect(screen.getByTestId("stub-exit")).toHaveTextContent("0");
    await user.click(screen.getByRole("button", { name: "Exit project" }));
    expect(screen.queryByTestId("detail-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-exit")).toHaveTextContent("1");
  });

  it("New custom CD from the library can get back to the library, from the landing or the studio", async () => {
    mockInvoke((command) => {
      if (command === "load_imported_music_sources") return [spotifySource()];
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("apple-library");
    await user.click(screen.getByRole("button", { name: "New custom CD" }));
    await screen.findByTestId("landing-screen");
    await user.click(screen.getByRole("button", { name: "Back to library" }));
    expect(await screen.findByTestId("apple-library")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New custom CD" }));
    await createFromLanding(user);
    await user.click(screen.getByTestId("catalog-button"));
    expect(await screen.findByTestId("apple-library")).toBeVisible();
    expect(screen.queryByTestId("landing-screen")).not.toBeInTheDocument();
  });

  it("Import music sources works again after New custom CD when no library exists yet", async () => {
    mockInvoke();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("landing-screen");
    await user.click(screen.getByRole("button", { name: "Import music sources" }));
    await screen.findByTestId("apple-library");
    await user.click(screen.getByRole("button", { name: "New custom CD" }));
    await screen.findByTestId("landing-screen");
    await user.click(screen.getByRole("button", { name: "Import music sources" }));
    expect(await screen.findByTestId("apple-library")).toBeVisible();
  });

  it("reads a chosen Apple Music library file through onRefreshApple(path)", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    mockInvoke((command, args) => {
      commands.push({ command, args });
      if (command === "import_apple_music_library" && args?.path) throw new Error("not an Apple Music Library.musicdb file");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Import music sources" }));
    await user.click(await screen.findByRole("button", { name: "Read chosen library" }));
    await waitFor(() => expect(screen.getByTestId("stub-note")).toHaveTextContent("not an Apple Music Library.musicdb file"));
    expect(commands).toContainEqual({ command: "import_apple_music_library", args: { path: "/x/Library.musicdb" } });
    // Not-found at startup stays silent.
    expect(screen.getByTestId("stub-error").textContent).toBe("");
  });

  it("blocks importing over imported sources that failed to load, and says why", async () => {
    const commands: string[] = [];
    mockInvoke((command) => {
      commands.push(command);
      if (command === "load_imported_music_sources") throw new Error("libraries.json is not valid JSON");
      return UNHANDLED;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Import music sources" }));
    expect(await screen.findByTestId("stub-error")).toHaveTextContent(
      "Imported music sources could not be loaded: libraries.json is not valid JSON. Importing is blocked so they are not overwritten."
    );
    await user.click(screen.getByRole("button", { name: "Import Spotify" }));
    await waitFor(() => expect(screen.getByTestId("stub-note")).toHaveTextContent("importing is blocked to avoid overwriting them: libraries.json is not valid JSON"));
    expect(commands).not.toContain("save_imported_music_sources");
  });

  it("shows a project load failure instead of claiming there are no projects", async () => {
    mockInvoke((command) => {
      if (command === "load_cd_projects") throw new Error("projects folder is unreadable");
      return UNHANDLED;
    });
    render(<App />);
    expect(await screen.findByTestId("projects-load-error")).toHaveTextContent(
      "Some projects could not be loaded: projects folder is unreadable"
    );
    expect(screen.queryByText("Saved projects and completed burns will appear here.")).not.toBeInTheDocument();
  });

  it("lists the good projects and names a damaged one (entry: null) instead of hiding all of them", async () => {
    mockInvoke((command) => (command === "load_cd_projects"
      ? [savedProject(), { ...savedProject(), id: "bad-entry", entry: null }]
      : UNHANDLED));
    render(<App />);
    expect(await screen.findByTestId("projects-load-error")).toHaveTextContent('Some projects could not be loaded: "bad-entry" is damaged');
    expect(screen.getByRole("link", { name: "Your projects (1)" })).toBeInTheDocument();
  });

  it("links returning users to their projects from the top of the landing", async () => {
    mockInvoke((command) => (command === "load_cd_projects" ? [savedProject()] : UNHANDLED));
    render(<App />);
    const link = await screen.findByRole("link", { name: "Your projects (1)" });
    expect(link).toHaveAttribute("href", "#recent-projects");
    expect(document.getElementById("recent-projects")).toHaveAttribute("data-testid", "recent-projects");
  });
});
