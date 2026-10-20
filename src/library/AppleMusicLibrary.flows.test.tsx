import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { AppleMusicLibrary } from "./AppleMusicLibrary";
import type { AppleMusicLibraryData, AppleMusicTrack } from "./appleMusic";
import { mergeCachedPlaylists, type CdBurnItem, type CdProject } from "../project/catalog";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
// These drive whole download flows with userEvent; a busy shared test host needs more than 5 s.
vi.setConfig({ testTimeout: 20_000 });

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const ACCEPT = /^(Download \+ add|Add to burn list)$/;

function track(id: string, title: string, overrides: Partial<AppleMusicTrack> = {}): AppleMusicTrack {
  return {
    id, title, artist: "Artist", album: "Album", albumArtist: "Artist", genre: "Rap", trackNumber: 1, durationSec: 180,
    playCount: 10, lastPlayedUnixMs: 200, likeStatus: 2, inAppleLibrary: true, ...overrides
  };
}

function libraryOf(tracks: AppleMusicTrack[], extra: Partial<AppleMusicLibraryData> = {}): AppleMusicLibraryData {
  return {
    sourcePath: "C:/Music/Library.musicdb",
    version: "1",
    summary: { trackCount: tracks.length, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 15, artworkTrackCount: 0 },
    tracks,
    playlists: [],
    ...extra
  };
}

const ALBUM_TRACKS = [track("one", "First", { trackNumber: 1 }), track("two", "Second", { trackNumber: 2, playCount: 5 })];
const OTHER_TRACKS = ["X1", "X2", "X3"].map((title, index) => track(`other-${index}`, title, { album: "Other", trackNumber: index + 1, playCount: 3 - index }));
const library = libraryOf(ALBUM_TRACKS);
const twoAlbums = libraryOf([...ALBUM_TRACKS, ...OTHER_TRACKS]);

function item(id: string, title: string, overrides: Partial<CdBurnItem> = {}): CdBurnItem {
  return { id, albumKey: "artist::album", title, artist: "Artist", album: "Album", durationSec: 180, ...overrides };
}

function ready(path: string, title: string) {
  return { id: path, title, durationSec: 180, path };
}

function project(overrides: Partial<CdProject> = {}): CdProject {
  return {
    id: "recent-album",
    name: "Album",
    kind: "artist",
    saved: true,
    entry: { artist: "Artist", album: "Album", formatId: "jewelcase" },
    burnQueue: [
      item("one", "First", { ready: ready("C:/cache/first.opus", "First") }),
      item("two", "Second", { ready: ready("C:/cache/second.opus", "Second") })
    ],
    tracks: [ready("C:/cache/first.opus", "First"), ready("C:/cache/second.opus", "Second")],
    art: [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    ...overrides
  };
}

type Props = ComponentProps<typeof AppleMusicLibrary>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    library,
    projects: [],
    projectsLoading: false,
    onCreateCustom: vi.fn(),
    onOpenStudio: vi.fn(),
    onPreparedAlbum: vi.fn(),
    onUpdateProject: vi.fn(),
    onSaveProject: vi.fn(),
    onDeleteProject: vi.fn(),
    ...overrides
  };
}

function useInvoke(handler: Invoke) {
  const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  window.__MXTP_INVOKE__ = (async (command: string, args?: Record<string, unknown>) => {
    commands.push({ command, args });
    return handler(command, args);
  }) as typeof window.__MXTP_INVOKE__;
  return commands;
}

function status() {
  return document.querySelector<HTMLElement>(".music-message");
}

function queueTitles() {
  return [...document.querySelectorAll(".music-queue-item .music-queue-play strong")].map((node) => node.textContent);
}

function burnList() {
  return within(screen.getByRole("complementary", { name: "CD burn list" }));
}

async function addWholeAlbum(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: "Albums" }));
  await user.click(screen.getByRole("button", { name: `Open ${title}` }));
  await user.click(screen.getByRole("button", { name: "Select all" }));
  await user.click(screen.getByRole("button", { name: "Add to burn list" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("library data safety", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("looks up a failed release tracklist once, settles on the local tracklist, and Retry asks again", async () => {
    const commands = useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") throw new Error("offline");
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    expect(await screen.findByText(/Could not verify the release tracklist: offline\. Showing your local tracklist\./)).toBeVisible();
    await sleep(500);
    expect(commands.filter((entry) => entry.command === "find_youtube_album_playlist")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(commands.filter((entry) => entry.command === "find_youtube_album_playlist")).toHaveLength(2));
  });

  it("marks verified Full album rows ready from the downloaded file positions", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") {
        return {
          url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 4, safeTrackPositions: [1, 2, 3, 4],
          tracks: ["First", "Second", "Third", "Fourth"].map((title, index) => ({ title, durationSec: 180, position: index + 1 }))
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    const saved = project({
      burnQueue: [
        item("a", "First", { ready: ready("C:/cache/Album/001 - First.opus", "First") }),
        item("b", "Third", { ready: ready("C:/cache/Album/003 - Third.opus", "Third") }),
        item("c", "Fourth (2011 Remaster)", { ready: ready("C:/cache/Album/004 - Fourth (2011 Remaster).opus", "Fourth (2011 Remaster)") })
      ],
      tracks: []
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [saved] })} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    expect(await screen.findByText("Showing the verified release tracklist.")).toBeVisible();
    const rows = within(screen.getByRole("list", { name: "Album tracklist" })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".music-track-title strong")?.textContent)).toEqual(["First", "Second", "Third", "Fourth"]);
    expect(rows.map((row) => row.querySelector(".music-download-state")?.textContent ?? "")).toEqual(["Audio ready forever", "", "Audio ready forever", "Audio ready forever"]);
    expect(rows[2].querySelector(".music-track-number")).toHaveAttribute("title", "Playlist position 3");
  });

  it("downloading an album never rewrites a custom CD that contains it", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/cache/Album/001 - First.opus", "First"), ready("C:/cache/Album/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const custom = project({
      id: "road-mix", name: "Road Mix", kind: "custom", entry: { artist: "", album: "Road Mix", formatId: "jewelcase" },
      burnQueue: [item("one", "First"), item("other-0", "X1", { albumKey: "artist::other", album: "Other" })], tracks: []
    });
    const snapshot = JSON.stringify(custom);
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums, projects: [custom], onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(onSaveProject).toHaveBeenCalled());
    expect(onSaveProject.mock.calls.every(([saved]) => saved.id !== "road-mix")).toBe(true);
    expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({ kind: "artist", entry: { artist: "Artist", album: "Album", formatId: "jewelcase" } }));
    expect(JSON.stringify(custom)).toBe(snapshot);
  });

  it("a re-download keeps a curated artist project's order and format", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/cache/Album/001 - First.opus", "First"), ready("C:/cache/Album/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const curated = project({
      entry: { artist: "Artist", album: "Album", formatId: "digipak" },
      burnQueue: [item("two", "Second"), item("one", "First", { ready: ready("C:/old/first.opus", "First") })],
      tracks: [ready("C:/old/first.opus", "First")]
    });
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [curated], onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(onSaveProject).toHaveBeenCalled());
    const saved = onSaveProject.mock.calls.at(-1)![0] as CdProject;
    expect(saved.id).toBe("recent-album");
    expect(saved.entry.formatId).toBe("digipak");
    expect(saved.burnQueue.map((entry) => entry.title)).toEqual(["Second", "First"]);
    expect(saved.burnQueue[0].ready?.path).toBe("C:/cache/Album/002 - Second.opus");
    await waitFor(() => expect(queueTitles()).toEqual(["Second", "First"]));
    expect(burnList().getByText("Changes save automatically")).toBeVisible();
  });

  it("a re-download saves into the saved album project, not an unsaved stub for the same album", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First"), ready("C:/c/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const stub = project({ id: "stub", saved: false, burnQueue: [], tracks: [], updatedAt: "2026-09-30T00:00:00Z" });
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [stub, project()], onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(onSaveProject).toHaveBeenCalled());
    expect(onSaveProject.mock.calls.map(([saved]) => saved.id)).toEqual(["recent-album"]);
  });

  it("a track removed while its download is pending stays removed", async () => {
    const lookup = deferred<unknown>();
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return lookup.promise;
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First"), ready("C:/c/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await addWholeAlbum(user, "Album");
    await user.click(burnList().getByRole("button", { name: "Download (2)" }));
    await user.click(screen.getByRole("button", { name: "Remove First from burn list" }));
    await act(async () => {
      lookup.resolve({ url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, trackPositions: [{ title: "First", position: 1 }, { title: "Second", position: 2 }] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play Second" })).toBeEnabled());
    expect(queueTitles()).toEqual(["Second"]);
  });

  it("a Full album download adds to an unsaved burn list instead of replacing it", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First"), ready("C:/c/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums })} />);
    await addWholeAlbum(user, "Other");
    await user.click(screen.getByRole("button", { name: "Albums" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(status()).toHaveTextContent("saved to the project Album in Projects"));
    expect(queueTitles()).toEqual(["X1", "X2", "X3", "First", "Second"]);
    expect(burnList().getByText("Not saved")).toBeVisible();
  });

  it("a Full album download that adopts an unsaved list keeps its order and extra tracks", async () => {
    localStorage.setItem("mxtp.unsavedBurnList", JSON.stringify({ name: "", items: [item("two", "Second"), item("one", "First"), item("bonus", "Bonus Demo")] }));
    const onSaveProject = vi.fn();
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First"), ready("C:/c/002 - Second.opus", "Second")] };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Albums" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(status()).toHaveTextContent("saved them as the project"));
    expect(queueTitles()).toEqual(["Second", "First", "Bonus Demo"]);
    const saved = onSaveProject.mock.calls.at(-1)![0] as CdProject;
    expect(saved.burnQueue.map((entry) => entry.title)).toEqual(["Second", "First", "Bonus Demo"]);
  });

  it("Clear burn list in a project saves the empty list but keeps the artist, and Undo restores the order", async () => {
    const onUpdateProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project()], onUpdateProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(burnList().getByRole("button", { name: "Clear burn list" }));
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({ burnQueue: [], kind: "artist", entry: expect.objectContaining({ artist: "Artist" }) }));
    expect(status()).toHaveTextContent("Cleared 2 tracks from Album.");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(queueTitles()).toEqual(["First", "Second"]);
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({ burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" })] }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("Clear burn list lets go of the project's download folder so the cache recovers it, and Undo takes it back", async () => {
    const onUpdateProject = vi.fn();
    const owner = project({ sourcePath: "C:/cache/album" });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [owner], onUpdateProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(burnList().getByRole("button", { name: "Clear burn list" }));
    const cleared = onUpdateProject.mock.lastCall![0] as CdProject;
    expect(cleared).toMatchObject({ burnQueue: [], tracks: [] });
    expect(cleared.sourcePath).toBeUndefined();
    const cache = { sourcePath: "C:/cache/album", title: "Album", quality: "best", tracks: owner.tracks, updatedAtMs: 1 };
    const recovered = mergeCachedPlaylists([cleared], [cache]).find((candidate) => candidate.id.startsWith("recovered-"));
    expect(recovered?.burnQueue.map((entry) => entry.ready?.path)).toEqual(["C:/cache/first.opus", "C:/cache/second.opus"]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const restored = onUpdateProject.mock.lastCall![0] as CdProject;
    expect(restored.sourcePath).toBe("C:/cache/album");
    expect(restored.tracks.map((entry) => entry.path)).toEqual(["C:/cache/first.opus", "C:/cache/second.opus"]);
    expect(queueTitles()).toEqual(["First", "Second"]);
  });

  it("a Full album download that finishes after another project opened never lands in that project", async () => {
    const download = deferred<unknown>();
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return download.promise;
      throw new Error(`unexpected ${command}`);
    });
    const unrelated = project({
      id: "q", name: "Unrelated CD", kind: "custom", entry: { artist: "", album: "Unrelated CD", formatId: "jewelcase" },
      burnQueue: [item("other-0", "X1", { albumKey: "artist::other", album: "Other" })], tracks: []
    });
    const onUpdateProject = vi.fn();
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums, projects: [unrelated], onUpdateProject, onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Albums" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await waitFor(() => expect(status()).toHaveTextContent("Downloading the complete"));
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Unrelated CD" }));
    expect(queueTitles()).toEqual(["X1"]);
    await act(async () => {
      download.resolve({ title: "Album", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First"), ready("C:/c/002 - Second.opus", "Second")] });
    });
    await waitFor(() => expect(status()).toHaveTextContent("Downloaded 2 tracks and saved them to the project Album in Projects."));
    expect(queueTitles()).toEqual(["X1"]);
    expect(screen.getByText("Editing project: Unrelated CD · changes save automatically")).toBeVisible();
    for (const [published] of [...onUpdateProject.mock.calls, ...onSaveProject.mock.calls] as Array<[CdProject]>) {
      if (published.id === "q") expect(published.burnQueue.map((entry) => entry.title)).toEqual(["X1"]);
    }
    expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({ kind: "artist", name: "Album", burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" })] }));
  });

  it("sends only verified positions to the album download and binds files by their position prefix", async () => {
    const verifiedTracks = ["First", "Second", "Third", "Fourth"].map((title, index) => ({ title, durationSec: 180, position: index + 1 }));
    const commands = useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 4, safeTrackPositions: [1, 2, 3, 4], tracks: verifiedTracks };
      if (command === "download_playlist_best") {
        // The folder already holds every position; the item at 3 must get 003.
        return { title: "Album", quality: "best", tracks: ["First", "Second", "Third", "Fourth"].map((title, index) => ready(`C:/c/00${index + 1} - ${title}.opus`, title)) };
      }
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await screen.findByText("Showing the verified release tracklist.");
    for (const title of ["First", "Third", "Fourth"]) await user.click(screen.getByRole("checkbox", { name: `Select ${title}` }));
    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    await user.click(burnList().getByRole("button", { name: "Download (3)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Play Third" })).toBeEnabled());
    expect(commands.filter((entry) => entry.command === "download_playlist_best").map((entry) => entry.args?.playlistItems)).toEqual(["1,3,4"]);
    const third = screen.getByRole("button", { name: "Play Third" });
    fireEvent.click(third);
    expect(commands.some((entry) => entry.command === "find_youtube_track")).toBe(false);
  });

  it("prepares a track with no verified position on its own instead of guessing a library position", async () => {
    const commands = useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=a", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2], trackPositions: [] };
      if (command === "find_youtube_track") return { url: "https://youtube.com/watch?v=first", title: "First", artist: "Artist", confidence: 1, explanation: "" };
      if (command === "download_playlist_best") return { title: "First", quality: "best", tracks: [ready("C:/c/001 - First.opus", "First")] };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("checkbox", { name: "Select First" }));
    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    await user.click(burnList().getByRole("button", { name: "Download (1)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Play First" })).toBeEnabled());
    const downloads = commands.filter((entry) => entry.command === "download_playlist_best");
    expect(downloads).toEqual([{ command: "download_playlist_best", args: { url: "https://youtube.com/watch?v=first" } }]);
    expect(commands.some((entry) => entry.command === "find_youtube_track")).toBe(true);
  });

  it("names unmatched tracks apart from download failures and tags only the unmatched row", async () => {
    useInvoke(async (command, args) => {
      if (command === "find_youtube_album_playlist") throw new Error("no album playlist");
      if (command === "find_youtube_track") {
        if (args?.title === "First") throw new Error("no confident match");
        return { url: "https://youtube.com/watch?v=second", title: "Second", artist: "Artist", confidence: 1, explanation: "" };
      }
      if (command === "download_playlist_best") throw new Error("yt-dlp exited with status 1");
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await addWholeAlbum(user, "Album");
    await user.click(burnList().getByRole("button", { name: "Download (2)" }));
    await waitFor(() => expect(status()).toHaveTextContent("0 tracks ready. Not found on YouTube: First. 1 could not be downloaded: yt-dlp exited with status 1"));
    const tags = document.querySelectorAll(".music-unmatched-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].closest(".music-queue-item")).toHaveTextContent("First");
    expect(tags[0]).toHaveAttribute("title", "no confident match");
    expect(burnList().getByText("2 tracks · 2 need audio")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove unmatched" }));
    expect(queueTitles()).toEqual(["Second"]);
    expect(burnList().getByText("1 track · 1 needs audio")).toBeVisible();
  });

  it("Burn CD with no CD writer says so before downloading anything", async () => {
    const commands = useInvoke(async (command) => {
      if (command === "list_burners") return [];
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await addWholeAlbum(user, "Album");
    await user.click(burnList().getByRole("button", { name: "Burn CD" }));
    await waitFor(() => expect(status()).toHaveTextContent("No CD writer found. You can download the audio now and burn later."));
    expect(commands.map((entry) => entry.command)).toEqual(["list_burners"]);
  });

  it("explains why Download and Burn CD are disabled when the list is over 80 minutes", async () => {
    const long = libraryOf([track("a", "Side A", { durationSec: 45 * 60 }), track("b", "Side B", { durationSec: 45 * 60, trackNumber: 2 })]);
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: long })} />);
    expect(burnList().getByText("Add songs to the burn list first.")).toBeVisible();
    await addWholeAlbum(user, "Album");
    const reason = burnList().getByText("Over by 10:03. Remove tracks to fit an 80-minute CD.");
    expect(reason).toHaveAttribute("id", "capacity-reason");
    expect(burnList().getByRole("button", { name: "Burn CD" })).toBeDisabled();
    expect(burnList().getByRole("button", { name: "Burn CD" })).toHaveAttribute("aria-describedby", "capacity-reason");
    expect(burnList().getByRole("button", { name: "Download (2)" })).toHaveAttribute("aria-describedby", "capacity-reason");
  });

  it("dropping an album on a queue row adds it once", async () => {
    const onUpdateProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums, projects: [project()], onUpdateProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "Albums" }));
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    fireEvent.dragStart(screen.getByRole("button", { name: "Open Other" }), { dataTransfer });
    onUpdateProject.mockClear();
    fireEvent.drop(screen.getByRole("button", { name: "Play First" }).closest(".music-queue-item")!, { dataTransfer });
    await waitFor(() => expect(queueTitles()).toEqual(["First", "Second", "X1", "X2", "X3"]));
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
  });
});

describe("project context", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("opening another album keeps the open project, and its tracks go into that project", async () => {
    const onUpdateProject = vi.fn();
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums, projects: [project()], onUpdateProject, onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await addWholeAlbum(user, "Other");
    expect(screen.getByText("Editing project: Album · changes save automatically")).toBeVisible();
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "recent-album",
      burnQueue: ["First", "Second", "X1", "X2", "X3"].map((title) => expect.objectContaining({ title }))
    }));
    expect(onSaveProject).not.toHaveBeenCalled();
  });

  it("a custom CD opens on its own tracklist and its studio button opens that CD", async () => {
    const onOpenProjectStudio = vi.fn();
    const custom = project({
      id: "road-mix", name: "Road Mix", kind: "custom", entry: { artist: "", album: "Road Mix", formatId: "jewelcase" },
      burnQueue: [
        item("one", "First", { ready: ready("C:/c/first.opus", "First") }),
        item("other-0", "X1", { albumKey: "artist::other", album: "Other" }),
        item("two", "Second", { ready: ready("C:/c/second.opus", "Second") }),
        item("other-1", "X2", { albumKey: "artist::other", album: "Other" })
      ],
      tracks: []
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: twoAlbums, projects: [custom], onOpenProjectStudio })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Road Mix" }));
    const detail = within(screen.getByTestId("album-detail"));
    expect(detail.getByRole("heading", { level: 1, name: "Road Mix" })).toBeVisible();
    expect(detail.getByText("Project · Custom CD")).toBeVisible();
    expect(detail.getAllByRole("listitem")).toHaveLength(4);
    expect(detail.queryByRole("button", { name: /^Full album/ })).toBeNull();
    await user.click(detail.getByRole("button", { name: "Open cover + booklet studio" }));
    expect(onOpenProjectStudio).toHaveBeenCalledWith(expect.objectContaining({ id: "road-mix" }));
  });

  it("asks before opening a project over an unsaved burn list; Cancel keeps it and Discard opens the project", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project({ id: "p2", name: "Saved CD" })] })} />);
    await addWholeAlbum(user, "Album");
    expect(burnList().getByText("Not saved")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Saved CD" }));
    const dialog = screen.getByRole("alertdialog", { name: "Save your burn list first?" });
    expect(dialog).toHaveTextContent("Your 2-track burn list isn't saved. Leaving will clear it.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(queueTitles()).toEqual(["First", "Second"]);
    expect(screen.queryByText(/Editing project/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Saved CD" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard list" }));
    expect(screen.getByText("Editing project: Saved CD · changes save automatically")).toBeVisible();
  });

  it("keeps an unsaved burn list across a remount and still renders when storage throws", async () => {
    const user = userEvent.setup();
    const first = render(<AppleMusicLibrary {...props()} />);
    await addWholeAlbum(user, "Album");
    first.unmount();
    const second = render(<AppleMusicLibrary {...props()} />);
    expect(queueTitles()).toEqual(["First", "Second"]);
    expect(burnList().getByText("Not saved")).toBeVisible();
    second.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<AppleMusicLibrary {...props()} />);
    expect(screen.getByTestId("apple-library")).toBeVisible();
    await addWholeAlbum(user, "Album");
    expect(queueTitles()).toEqual(["First", "Second"]);
  });

  it("a stored unsaved list survives opening a requested project and comes back on Exit project", async () => {
    const stored = JSON.stringify({ name: "Road trip", items: [item("one", "First"), item("two", "Second")] });
    localStorage.setItem("mxtp.unsavedBurnList", stored);
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project({ burnQueue: [item("one", "First")] })], initialProjectId: "recent-album" })} />);
    expect(await screen.findByText("Editing project: Album · changes save automatically")).toBeVisible();
    expect(queueTitles()).toEqual(["First"]);
    expect(localStorage.getItem("mxtp.unsavedBurnList")).toBe(stored);
    await user.click(screen.getByTestId("exit-project-button"));
    expect(queueTitles()).toEqual(["First", "Second"]);
    expect(burnList().getByText("Not saved")).toBeVisible();
    expect(status()).toHaveTextContent("Closed Album. Your unsaved 2-track burn list is back.");
    expect(JSON.parse(localStorage.getItem("mxtp.unsavedBurnList")!)).toMatchObject({ name: "Road trip", items: [{ title: "First" }, { title: "Second" }] });
  });

  it("opens initialProjectId once, exits on exitProjectSignal, and follows outside changes to the open project", async () => {
    const onUpdateProject = vi.fn();
    const base = props({ projects: [project()], onUpdateProject, initialProjectId: "recent-album" });
    const view = render(<AppleMusicLibrary {...base} />);
    expect(await screen.findByText("Editing project: Album · changes save automatically")).toBeVisible();
    expect(screen.getByTestId("album-detail")).toBeVisible();
    // The studio reorders the project while the library is hidden.
    const reordered = project({ burnQueue: [...project().burnQueue].reverse(), updatedAt: "2026-09-01T00:00:00Z" });
    view.rerender(<AppleMusicLibrary {...base} projects={[reordered]} />);
    await waitFor(() => expect(queueTitles()).toEqual(["Second", "First"]));
    expect(onUpdateProject).not.toHaveBeenCalled();
    view.rerender(<AppleMusicLibrary {...base} projects={[reordered]} exitProjectSignal={1} />);
    await waitFor(() => expect(screen.queryByText(/Editing project/)).toBeNull());
    expect(queueTitles()).toEqual([]);
    expect(status()).toHaveTextContent("Closed Album. The burn list is empty and ready for a new mix.");
  });

  it("exitProjectSignal with no project open keeps the unsaved list and its stored copy", async () => {
    localStorage.setItem("mxtp.unsavedBurnList", JSON.stringify({ name: "Road trip", items: [item("one", "First"), item("two", "Second")] }));
    const base = props();
    const view = render(<AppleMusicLibrary {...base} />);
    expect(queueTitles()).toEqual(["First", "Second"]);
    view.rerender(<AppleMusicLibrary {...base} exitProjectSignal={1} />);
    await sleep(0);
    expect(queueTitles()).toEqual(["First", "Second"]);
    expect(JSON.parse(localStorage.getItem("mxtp.unsavedBurnList")!)).toMatchObject({ items: [{ title: "First" }, { title: "Second" }] });
  });

  it("deleting the requested project brings back the stored unsaved list and keeps storing new edits", async () => {
    localStorage.setItem("mxtp.unsavedBurnList", JSON.stringify({ name: "Road trip", items: [item("one", "First"), item("two", "Second")] }));
    const base = props({ library: twoAlbums, initialProjectId: "recent-album" });
    const view = render(<AppleMusicLibrary {...base} projects={[project({ burnQueue: [item("one", "First")] })]} />);
    expect(await screen.findByText(/Editing project: Album/)).toBeVisible();
    view.rerender(<AppleMusicLibrary {...base} projects={[]} />);
    await waitFor(() => expect(screen.queryByText(/Editing project/)).toBeNull());
    expect(queueTitles()).toEqual(["First", "Second"]);
    await addWholeAlbum(userEvent.setup(), "Other");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("mxtp.unsavedBurnList")!).items.map((entry: CdBurnItem) => entry.title))
      .toEqual(["First", "Second", "X1", "X2", "X3"]));
  });

  it("a track renamed in the studio shows in the library, so a later edit keeps the new title", async () => {
    const base = props({ projects: [project()], initialProjectId: "recent-album" });
    const view = render(<AppleMusicLibrary {...base} />);
    expect(await screen.findByText(/Editing project: Album/)).toBeVisible();
    const [first, second] = project().burnQueue;
    const renamed = project({ burnQueue: [{ ...first, title: "First (Album Mix)" }, second], updatedAt: "2026-09-01T00:00:00Z" });
    view.rerender(<AppleMusicLibrary {...base} projects={[renamed]} />);
    await waitFor(() => expect(queueTitles()).toEqual(["First (Album Mix)", "Second"]));
  });

  it("an own publish landing late does not undo a newer edit", async () => {
    const onUpdateProject = vi.fn();
    const base = props({ projects: [project()], onUpdateProject });
    const user = userEvent.setup();
    const view = render(<AppleMusicLibrary {...base} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder First" }), { key: "ArrowDown" });
    const firstPublish = onUpdateProject.mock.calls.at(-1)![0] as CdProject;
    await user.click(screen.getByRole("button", { name: "Remove First from burn list" }));
    // The parent stamps the older publish later than ours.
    view.rerender(<AppleMusicLibrary {...base} projects={[{ ...firstPublish, updatedAt: "2099-01-01T00:00:00Z" }]} />);
    await sleep(50);
    expect(queueTitles()).toEqual(["Second"]);
  });

  it("Design cover + booklet saves an unsaved list once and opens that project", async () => {
    const onSaveProject = vi.fn();
    const onOpenProjectStudio = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ onSaveProject, onOpenProjectStudio })} />);
    const studio = burnList().getByRole("button", { name: "Design cover + booklet" });
    expect(studio).toBeDisabled();
    expect(studio).toHaveAttribute("data-help-target", "cover-studio");
    expect(studio).toHaveAccessibleDescription("Add tracks first");
    await addWholeAlbum(user, "Album");
    await user.click(burnList().getByRole("button", { name: "Design cover + booklet" }));
    await waitFor(() => expect(onOpenProjectStudio).toHaveBeenCalled());
    expect(onSaveProject).toHaveBeenCalledTimes(1);
    expect(onOpenProjectStudio.mock.calls[0][0].id).toBe(onSaveProject.mock.calls[0][0].id);
  });

  it("New mix leaves project mode and focuses the name field; with unsaved tracks it asks first", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project()] })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "New mix" }));
    expect(screen.queryByText(/Editing project/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Albums" })).toHaveAttribute("aria-current", "page");
    await addWholeAlbum(user, "Album");
    await user.click(screen.getByRole("button", { name: "New mix" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start a new mix?" });
    expect(dialog).toHaveTextContent("The burn list has 2 unsaved tracks.");
    await user.click(within(dialog).getByRole("button", { name: "Discard list" }));
    expect(queueTitles()).toEqual([]);
  });

  it("renaming a saved project saves on blur", async () => {
    const onUpdateProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project()], onUpdateProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    const name = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(name);
    await user.type(name, "Road Trip");
    await user.tab();
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({ id: "recent-album", name: "Road Trip" }));
  });

  it("shows an app error at the top and a failed save with Retry in the burn list", async () => {
    const onSaveProject = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const user = userEvent.setup();
    const view = render(<AppleMusicLibrary {...props({ projects: [project()], onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    view.rerender(<AppleMusicLibrary {...props({ projects: [project()], onSaveProject, appError: "Could not save this project: disk full" })} />);
    expect(screen.getAllByRole("alert").some((node) => node.textContent === "Could not save this project: disk full")).toBe(true);
    expect(burnList().getByText(/Couldn't save: disk full/)).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(burnList().getByRole("button", { name: "Retry" }));
    expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({ id: "recent-album" }));
  });

  it("keyboard reorder keeps focus on the moved handle and announces the position", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await addWholeAlbum(user, "Album");
    const handle = screen.getByRole("button", { name: "Reorder First" });
    expect(handle).toHaveAccessibleDescription("Press up or down arrow to move");
    handle.focus();
    await user.keyboard("{ArrowDown}");
    expect(queueTitles()).toEqual(["Second", "First"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reorder First" }));
    expect(screen.getByText("Moved First to position 2 of 2")).toBeInTheDocument();
  });

  it("a project opened after an exit shows no stale message", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project()] })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByTestId("exit-project-button"));
    expect(status()).toHaveTextContent("Closed Album.");
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(status()).toBeNull();
  });

  it("the ⋯ button opens project actions that work from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project({ name: "Bloom Sessions" })] })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    expect(screen.getByRole("button", { name: "Open Bloom Sessions" })).toBeVisible();
    const more = screen.getByRole("button", { name: "Actions for Bloom Sessions" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    await user.click(more);
    const menu = screen.getByRole("menu", { name: "Actions for Bloom Sessions" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getByRole("menuitem", { name: /Burn project/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: /Delete project/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
  });

  it("Find a project filters the cards; the album search shows only on the Albums grid", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project(), project({ id: "road", name: "Road Mix", kind: "custom", entry: { artist: "", album: "Road Mix", formatId: "jewelcase" } })] })} />);
    expect(screen.getByRole("textbox", { name: "Search library" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Projects 2" }));
    expect(screen.queryByRole("textbox", { name: "Search library" })).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: "Find a project" }), "road");
    expect(screen.getByRole("button", { name: "Open Road Mix" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Album" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Music sources" }));
    expect(screen.queryByRole("textbox", { name: "Search library" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    expect(screen.queryByRole("textbox", { name: "Search library" })).toBeNull();
  });
});

describe("curator", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const sixTracks = libraryOf(["One", "Two", "Three", "Four", "Five", "Six"].map((title, index) => track(`t${index}`, title, {
    album: `Album ${index}`, artist: `Artist ${index}`, albumArtist: `Artist ${index}`, playCount: 60 - index, lastPlayedUnixMs: Date.UTC(2026, 3, 1)
  })));

  async function propose(user: ReturnType<typeof userEvent.setup>, text = "Make a mixtape of my 2 favorite tracks") {
    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
  }

  it("only a whole-message yes accepts; other text refines the proposal", async () => {
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: sixTracks, onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await propose(user);
    for (const refinement of ["add some Bowie too", "please make it longer", "download the deluxe edition"]) {
      await propose(user, refinement);
      expect(onSaveProject).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: ACCEPT })).toBeVisible();
    }
    await propose(user, "add them");
    await waitFor(() => expect(onSaveProject).toHaveBeenCalledTimes(1));
  });

  it("'no thanks' declines", async () => {
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: sixTracks, onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await propose(user);
    await propose(user, "no thanks");
    expect(status()).toHaveTextContent("Proposal dismissed. Nothing was downloaded or added.");
    expect(onSaveProject).not.toHaveBeenCalled();
  });

  it("the global chat and its proposal survive opening an album, and memory survives a remount", async () => {
    const user = userEvent.setup();
    const first = render(<AppleMusicLibrary {...props({ library: sixTracks })} />);
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await propose(user);
    await user.click(screen.getByRole("button", { name: "Albums" }));
    await user.click(screen.getByRole("button", { name: "Open Album 0" }));
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    expect(screen.getByText("Make a mixtape of my 2 favorite tracks")).toBeVisible();
    expect(screen.getByRole("button", { name: ACCEPT })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "no skits");
    first.unmount();
    render(<AppleMusicLibrary {...props({ library: sixTracks })} />);
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("no skits");
  });

  it("project memory keeps every keystroke without a full save per keystroke", async () => {
    const onUpdateProject = vi.fn();
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ projects: [project()], onUpdateProject, onSaveProject })} />);
    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "ab");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("ab");
    await user.tab();
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({ curator: expect.objectContaining({ memory: expect.objectContaining({ notes: "ab" }) }) }));
    expect(onSaveProject).not.toHaveBeenCalled();
  });

  it("accepting a global proposal over an unsaved list asks first; Discard starts a mix with only the proposal", async () => {
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: sixTracks, onSaveProject })} />);
    await addWholeAlbum(user, "Album 5");
    await user.click(screen.getByRole("button", { name: "Albums" }));
    await user.click(screen.getByRole("button", { name: "Open Album 4" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    expect(queueTitles()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await propose(user, "Make a mixtape of my 5 favorite tracks");
    await user.click(screen.getByRole("button", { name: ACCEPT }));
    const dialog = screen.getByRole("alertdialog", { name: "Save your burn list first?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard list" }));
    await waitFor(() => expect(onSaveProject).toHaveBeenCalledTimes(1));
    expect(onSaveProject.mock.calls[0][0].burnQueue).toHaveLength(5);
  });
});

describe("library first run, sources and wording", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const empty = libraryOf([], {
    summary: { trackCount: 0, albumCount: 0, artistCount: 0, playlistCount: 0, totalPlays: 0, artworkTrackCount: 0 },
    sources: [{ source: "apple", label: "Apple Music", imported: false, sourcePath: "", trackCount: 0, albumCount: 0, artistCount: 0, playlistCount: 0, totalPlays: 0, limitations: [] }]
  });

  it("an empty library opens on Music sources and its Albums page never claims a search found nothing", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: empty })} />);
    expect(screen.getByTestId("music-sources")).toBeVisible();
    expect(screen.getByRole("button", { name: "Music sources" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Albums" }));
    expect(screen.queryByText(/No albums match/)).toBeNull();
    expect(screen.getByText(/Your library is empty\./)).toBeVisible();
    expect(screen.getByRole("note", { name: "Your first CD" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Album drag setting" })).toBeNull();
  });

  it("a search with no hits says so, and singular counts never read '1 albums'", async () => {
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    expect(screen.getByText("1 album from your listening data")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\b1 (albums|tracks|songs)\b/);
    expect(screen.getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "AI Curator" })).not.toHaveAttribute("aria-label");
    await user.type(screen.getByRole("textbox", { name: "Search library" }), "zzz");
    expect(screen.getByText(/No albums match “zzz”\./)).toBeVisible();
  });

  it("a Spotify-only album opens on Full album and Download is named by its visible text", async () => {
    useInvoke(async () => { throw new Error("offline"); });
    const spotify = libraryOf([track("s1", "Liked Elsewhere", { inAppleLibrary: false, likeStatus: 0, sourceStats: [{ source: "spotify", sourceTrackId: "s1", playCount: 3, liked: true }] })]);
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: spotify })} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(screen.getByRole("button", { name: "Full album (1)" })).toHaveAttribute("aria-pressed", "true");
    const download = within(screen.getByTestId("album-detail")).getByRole("button", { name: "Download full album" });
    expect(download).not.toHaveAttribute("aria-label");
    await user.click(screen.getByRole("button", { name: "My Apple Music songs (0)" }));
    expect(screen.getByText(/No songs from this album are in your Apple Music library\. It came from Spotify\. Choose Full album/)).toBeVisible();
  });

  it("Add album to burn list adds the whole Full album and confirms it on the album page", async () => {
    useInvoke(async (command) => {
      if (command === "find_youtube_album_playlist") {
        return { url: "u", title: "Album", artist: "Artist", trackCount: 4, safeTrackPositions: [], tracks: ["First", "Second", "Third", "Fourth"].map((title, index) => ({ title, durationSec: 180, position: index + 1 })) };
      }
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await screen.findByText("Showing the verified release tracklist.");
    await user.click(screen.getByRole("button", { name: "Add album to burn list" }));
    expect(queueTitles()).toEqual(["First", "Second", "Third", "Fourth"]);
    expect(within(screen.getByTestId("album-detail")).getByRole("status")).toHaveTextContent("4 tracks added to the burn list.");
  });

  it("Choose Library.musicdb… reads the picked Apple library file", async () => {
    vi.mocked(open).mockResolvedValue("/home/me/Library.musicdb");
    const onRefreshApple = vi.fn().mockResolvedValue(library);
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: empty, onRefreshApple })} />);
    expect(screen.getByText("Not found on this PC")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose Library.musicdb…" }));
    await waitFor(() => expect(onRefreshApple).toHaveBeenCalledWith("/home/me/Library.musicdb"));
  });

  it("a failed Apple read is a plain sentence with the raw error tucked into Technical details", async () => {
    const onRefreshApple = vi.fn().mockRejectedValue(new Error("Apple Music library was not found at `/home/me/Music/Library.musicdb`"));
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props({ library: empty, onRefreshApple })} />);
    await user.click(screen.getByRole("button", { name: "Read Apple Music library" }));
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("p")).toHaveTextContent(/^MXTP could not find your Apple Music library on this PC\./);
    expect(alert.querySelector("p")?.textContent).not.toContain("`");
    expect(within(alert).getByText("Technical details")).toBeInTheDocument();
  });

  it("adds local audio files with probed durations and names the file that failed", async () => {
    vi.mocked(open).mockResolvedValue(["/music/a.wav", "/music/b.flac", "/music/bad.mp3"]);
    useInvoke(async (command, args) => {
      if (command === "copy_audio_file") {
        if (String(args?.sourcePath).includes("bad")) throw new Error("unreadable file");
        expect(args?.projectId).toBe("library-imports");
        return `/data/library-imports/${String(args?.sourcePath).split("/").pop()}`;
      }
      if (command === "probe_audio") return { durationSec: String(args?.path).endsWith("a.wav") ? 61 : 120, sampleRate: 44100, channels: 2, codec: "pcm" };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<AppleMusicLibrary {...props()} />);
    await user.click(screen.getByRole("button", { name: "Music sources" }));
    await user.click(screen.getByRole("button", { name: "Add audio files…" }));
    await waitFor(() => expect(queueTitles()).toEqual(["a", "b"]));
    expect(screen.getByRole("button", { name: "Play a" })).toBeEnabled();
    expect(burnList().getByText("3:01")).toBeVisible();
    expect(burnList().getByText("All 2 tracks have audio")).toBeVisible();
    expect(status()).toHaveTextContent("Added 2 audio files to the burn list. Could not add bad (unreadable file).");
  });
});
