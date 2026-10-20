import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "@tauri-apps/plugin-fs";
import { AppleMusicLibrary } from "./AppleMusicLibrary";
import type { AppleMusicLibraryData } from "./appleMusic";
import type { CdProject } from "../project/catalog";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

// These drive whole download flows with userEvent; a busy shared test host needs more than 5 s.
vi.setConfig({ testTimeout: 20_000 });

const library: AppleMusicLibraryData = {
  sourcePath: "C:/Music/Library.musicdb",
  version: "1.6.4.90",
  summary: { trackCount: 2, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 15, artworkTrackCount: 2 },
  tracks: [
    { id: "one", title: "First", artist: "Artist", album: "Album", albumArtist: "Artist", genre: "Rap", trackNumber: 1, durationSec: 180, playCount: 10, lastPlayedUnixMs: 200, likeStatus: 2, inAppleLibrary: true, artworkPath: "C:/art/album.jpeg" },
    { id: "two", title: "Second", artist: "Artist", album: "Album", albumArtist: "Artist", genre: "Rap", trackNumber: 2, durationSec: 200, playCount: 5, lastPlayedUnixMs: 100, likeStatus: 2, inAppleLibrary: true, artworkPath: "C:/art/album.jpeg" }
  ],
  playlists: []
};

function savedProjectFixture(): CdProject {
  return {
    id: "recent-album",
    name: "Album",
    kind: "artist",
    saved: true,
    entry: { artist: "Artist", album: "Album", formatId: "jewelcase" },
    burnQueue: [
      { id: "one", albumKey: "artist::album", title: "First", artist: "Artist", album: "Album", durationSec: 180, ready: { id: "ready-one", title: "First", durationSec: 180, path: "C:/cache/first.opus" } },
      { id: "two", albumKey: "artist::album", title: "Second", artist: "Artist", album: "Album", durationSec: 200, ready: { id: "ready-two", title: "Second", durationSec: 200, path: "C:/cache/second.opus" } }
    ],
    tracks: [
      { id: "ready-one", title: "First", durationSec: 180, path: "C:/cache/first.opus" },
      { id: "ready-two", title: "Second", durationSec: 200, path: "C:/cache/second.opus" }
    ],
    art: [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 100,
    playlistUrl: "",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z"
  };
}

/** The curator accept button ("Download + add" until WP7 renames it "Add to burn list"). */
const ACCEPT = /^(Download \+ add|Add to burn list)$/;

function burnListStatus() {
  return document.querySelector<HTMLElement>(".music-message");
}

describe("Apple Music library UI", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows SoundCloud tracks without album tags as individual imported tracks", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const user = userEvent.setup();
    const soundCloudLibrary: AppleMusicLibraryData = {
      ...library,
      tracks: [{
        ...library.tracks[0], id: "soundcloud-one", title: "Loose SoundCloud Track", artist: "SoundCloud creator", album: "", albumArtist: "", inAppleLibrary: false,
        sourceStats: [{ source: "soundcloud", sourceTrackId: "soundcloud:one", playCount: 3, liked: true }]
      }]
    };
    render(
      <AppleMusicLibrary
        library={soundCloudLibrary}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open Loose SoundCloud Track" }));
    expect(screen.getByRole("heading", { name: "Loose SoundCloud Track" })).toBeVisible();
    expect(screen.getByText(/1 imported track\b/)).toBeVisible();
    expect(screen.queryByText(/1 imported tracks/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Full album/ })).toBeNull();
  });

  it("downloads the liked-song scope using only its matched playlist positions", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      commands.push({ command, args });
      if (command === "find_youtube_album_playlist") {
        return { url: "https://youtube.com/playlist?list=album", title: "Album", artist: "Artist", trackCount: 2, trackPositions: [{ title: "Second", position: 2 }] } as never;
      }
      if (command === "download_playlist_best") {
        return {
          title: "Album",
          quality: "best",
          coverPath: "C:/cache/cover.jpg",
          tracks: [{ id: "C:/cache/002.opus", title: "Second", durationSec: 200, path: "C:/cache/002.opus" }]
        } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const onPreparedAlbum = vi.fn();
    const user = userEvent.setup();
    const scopedLibrary = {
      ...library,
      tracks: [{ ...library.tracks[0], inAppleLibrary: false }, library.tracks[1]]
    };
    render(
      <AppleMusicLibrary
        library={scopedLibrary}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={onPreparedAlbum}
        onUpdateProject={vi.fn()}
        onSaveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />
    );

    expect(screen.getByTestId("apple-library")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(screen.getByTestId("album-detail")).toBeVisible();
    expect(screen.getByText(/0 of 1 downloaded/)).toBeVisible();
    expect(screen.queryByText("Audio ready forever")).toBeNull();
    expect(screen.queryByText("First")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Download 1 song" }));

    await waitFor(() => expect(burnListStatus()).toHaveTextContent("Downloaded 1 song. Audio ready forever, saved to the project Album in Projects."));
    expect(commands).toContainEqual({
      command: "download_playlist_best",
      args: { url: "https://youtube.com/playlist?list=album", playlistItems: "2" }
    });
    expect(onPreparedAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Album" }),
      expect.objectContaining({ tracks: [expect.objectContaining({ title: "Second" })] })
    );
  });

  it("opens a saved project with its ordered burn list and plays downloaded songs", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.mocked(readFile).mockResolvedValue(Uint8Array.from([79, 103, 103, 83]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mxtp-first-opus");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const onSaveProject = vi.fn();
    const onUpdateProject = vi.fn();
    const onDeleteProject = vi.fn();
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "list_burners") return [] as never;
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[{
          id: "recent-album",
          name: "Album",
          kind: "artist",
          saved: true,
          entry: { artist: "Artist", album: "Album", formatId: "jewelcase" },
          burnQueue: [
            { id: "one", albumKey: "artist::album", title: "First", artist: "Artist", album: "Album", durationSec: 180, ready: { id: "ready-one", title: "First", durationSec: 180, path: "C:/cache/first.opus" } },
            { id: "two", albumKey: "artist::album", title: "Second", artist: "Artist", album: "Album", durationSec: 200, ready: { id: "ready-two", title: "Second", durationSec: 200, path: "C:/cache/second.opus" } }
          ],
          tracks: [
            { id: "ready-one", title: "First", durationSec: 180, path: "C:/cache/first.opus" },
            { id: "ready-two", title: "Second", durationSec: 200, path: "C:/cache/second.opus" }
          ],
          art: [],
          researchApplied: [],
          research: null,
          bookletPages: 16,
          exports: [],
          burnProgress: 100,
          playlistUrl: "",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:00:00Z"
        }]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={onUpdateProject}
        onSaveProject={onSaveProject}
        onDeleteProject={onDeleteProject}
      />
    );

    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    const projectCard = screen.getByRole("button", { name: "Open Album" });
    fireEvent.contextMenu(projectCard, { clientX: 200, clientY: 150 });
    expect(screen.getByRole("menu", { name: "Actions for Album" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: /Burn project/ }));
    await waitFor(() => expect(burnListStatus()).toHaveTextContent("No CD writer found. You can download the audio now and burn later."));
    expect(screen.getByText("2 tracks")).toBeVisible();

    fireEvent.contextMenu(projectCard, { clientX: 200, clientY: 150 });
    await user.click(screen.getByRole("menuitem", { name: /Delete project/ }));
    expect(onDeleteProject).toHaveBeenCalledWith(expect.objectContaining({ id: "recent-album" }));

    await user.click(projectCard);

    expect(screen.getByTestId("album-detail")).toBeVisible();
    expect(screen.getAllByText("Audio ready forever")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open cover + booklet studio" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Play First" }));
    await waitFor(() => expect(screen.getByTestId("burn-list-audio-player")).toHaveAttribute("src", "blob:mxtp-first-opus"));
    expect(readFile).toHaveBeenCalledWith("C:/cache/first.opus");
    const firstHandle = screen.getByRole("button", { name: "Reorder First" });
    fireEvent.keyDown(firstHandle, { key: "ArrowDown" });
    expect(screen.getAllByRole("button", { name: /^Play / }).map((button) => button.textContent)).toEqual([expect.stringContaining("Second"), expect.stringContaining("First")]);
    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => dragData.set(type, value),
      getData: (type: string) => dragData.get(type) ?? ""
    };
    fireEvent.dragStart(screen.getByRole("button", { name: "Reorder First" }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("button", { name: "Play Second" }).closest(".music-queue-item")!, { dataTransfer });
    fireEvent.drop(screen.getByRole("button", { name: "Play Second" }).closest(".music-queue-item")!, { dataTransfer });
    expect(screen.getAllByRole("button", { name: /^Play / }).map((button) => button.textContent)).toEqual([expect.stringContaining("First"), expect.stringContaining("Second")]);
    expect(screen.queryByRole("button", { name: "Save as project" })).toBeNull();
    expect(screen.getByText("Changes save automatically")).toBeVisible();
    expect(onUpdateProject).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "recent-album",
      name: "Album",
      saved: true,
      burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" })]
    }));
    expect(onSaveProject).not.toHaveBeenCalled();
  });

  it("keeps a saved project cover authoritative when a matching library album opens the studio", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const onOpenStudio = vi.fn();
    const project = savedProjectFixture();
    project.art = [{
      slotId: "front",
      imageRef: "C:/projects/custom-front.png",
      imageSource: "research",
      transform: { x: 3, y: 4, scale: 1.2, rotation: 0 }
    }];

    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[project]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={onOpenStudio}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    const coverImage = screen.getByRole("img", { name: "Album cover" });
    expect(coverImage).toHaveAttribute(
      "src",
      expect.stringContaining("custom-front.png")
    );
    fireEvent.error(coverImage);
    expect(screen.getByRole("img", { name: "Album cover" })).toHaveAttribute(
      "src",
      expect.stringContaining("album.jpeg")
    );
    fireEvent.error(screen.getByRole("img", { name: "Album cover" }));
    expect(screen.getByTestId("artwork-fallback")).toHaveTextContent("MXTP");
    await user.click(screen.getByRole("button", { name: "Open cover + booklet studio" }));

    expect(onOpenStudio).toHaveBeenCalledWith(expect.objectContaining({
      artworkPath: "C:/projects/custom-front.png"
    }));
  });

  it("downloads the complete matched album and adds songs missing from the Apple library to the burn list", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      commands.push({ command, args });
      if (command === "find_youtube_album_playlist") {
        return { url: "https://youtube.com/playlist?list=complete", title: "Album", artist: "Artist", trackCount: 3, safeTrackPositions: [1, 2, 3] } as never;
      }
      if (command === "download_playlist_best") {
        return {
          title: "Album",
          quality: "best",
          tracks: [
            { id: "ready-one", title: "Artist - First (Official Audio)", durationSec: 180, path: "C:/cache/one.opus" },
            { id: "ready-two", title: "Artist - Second", durationSec: 200, path: "C:/cache/two.opus" },
            { id: "ready-three", title: "Artist - Hidden Third", durationSec: 160, path: "C:/cache/three.opus" },
            { id: "ready-three-video", title: "Artist - Hidden Third [Official Music Video]", durationSec: 162, path: "C:/cache/three-video.opus" }
          ]
        } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(screen.getByText("About 7-20 minutes. Nothing burns until you click Burn CD.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));

    await waitFor(() => expect(screen.getByText("3 tracks")).toBeVisible());
    expect(screen.getByRole("button", { name: "Play Hidden Third" })).toBeVisible();
    expect(screen.getAllByText("Audio ready forever")).toHaveLength(3);
    expect(commands).toContainEqual({
      command: "download_playlist_best",
      args: { url: "https://youtube.com/playlist?list=complete", playlistItems: "1,2,3" }
    });
    expect(commands.some((entry) => entry.command === "list_burners")).toBe(false);
    expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({
      saved: true,
      entry: { artist: "Artist", album: "Album", formatId: "jewelcase" },
      burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" }), expect.objectContaining({ title: "Hidden Third" })],
      tracks: [expect.objectContaining({ title: "First", path: "C:/cache/one.opus" }), expect.objectContaining({ title: "Second" }), expect.objectContaining({ title: "Hidden Third" })]
    }));
    expect(burnListStatus()).toHaveTextContent("Downloaded 3 tracks and saved them as the project Album. Burn-list changes now update it.");
    expect(screen.getByText("Changes save automatically")).toBeVisible();
  });

  it("switches between liked songs and the full album while keeping one download action", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const scopedLibrary = {
      ...library,
      tracks: [library.tracks[0], { ...library.tracks[1], inAppleLibrary: false }]
    };
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={scopedLibrary}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(screen.getByRole("button", { name: "My Apple Music songs (1)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("First")).toBeVisible();
    expect(screen.queryByText("Second")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Full album (2)" }));
    expect(screen.getByText("Second")).toBeVisible();
    expect(within(screen.getByTestId("album-detail")).getAllByRole("button", { name: /^Download/ })).toHaveLength(1);
    expect(screen.queryByText(/Download whole album/)).toBeNull();
  });

  it("uses only Apple-library tracks for liked songs, previews a verified full tracklist, and honors the album drag setting", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const commands: string[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      commands.push(command);
      if (command === "find_youtube_album_playlist") {
        return {
          url: "https://youtube.com/playlist?list=complete",
          title: "Album",
          artist: "Artist",
          trackCount: 3,
          tracks: [
            { title: "Artist - First", durationSec: 180, position: 1 },
            { title: "Artist - Second", durationSec: 200, position: 2 },
            { title: "Artist - Third", durationSec: 160, position: 3 }
          ]
        } as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const user = userEvent.setup();
    const mixedLibrary = {
      ...library,
      tracks: [
        { ...library.tracks[0], inAppleLibrary: true, likeStatus: 0 },
        { ...library.tracks[1], inAppleLibrary: false, likeStatus: 1, sourceStats: [{ source: "spotify" as const, sourceTrackId: "spotify-two", playCount: 1, liked: true }] }
      ]
    };
    render(
      <AppleMusicLibrary library={mixedLibrary} projects={[]} projectsLoading={false} onCreateCustom={vi.fn()} onOpenStudio={vi.fn()} onPreparedAlbum={vi.fn()} onUpdateProject={vi.fn()} onSaveProject={vi.fn()} onDeleteProject={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Open Album" }));
    expect(screen.getByText("First")).toBeVisible();
    expect(screen.queryByText("Second")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    expect(await screen.findByText("Third")).toBeVisible();
    expect(commands).toEqual(["find_youtube_album_playlist"]);

    await user.click(screen.getByRole("button", { name: /All albums/ }));
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? ""
    };
    const card = screen.getByRole("button", { name: "Open Album" });
    const burnList = screen.getByRole("complementary", { name: "CD burn list" });
    await user.click(screen.getByRole("radio", { name: "My Apple Music songs" }));
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(burnList, { dataTransfer });
    expect(screen.getByText("1 track")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear burn list" }));
    await user.click(screen.getByRole("radio", { name: "Full album" }));
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(burnList, { dataTransfer });
    await waitFor(() => expect(screen.getByText("3 tracks")).toBeVisible());
    expect(commands).toEqual(["find_youtube_album_playlist"]);
  });

  it("shows a newly saved ordered burn list in Projects immediately", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    await user.click(screen.getByRole("button", { name: "Save as project" }));

    expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({
      saved: true,
      name: "Album",
      burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" })]
    }));
    expect(burnListStatus()).toHaveTextContent("Saved Album to Projects. Changes now save automatically.");
    const projectsButton = screen.getByRole("button", { name: "Projects 1" });
    expect(projectsButton).toBeVisible();
    await user.click(projectsButton);
    expect(screen.getByRole("button", { name: "Open Album" })).toBeVisible();
  });

  it("does not add a failed save to the Projects catalog or report it as saved", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const onSaveProject = vi.fn().mockResolvedValue(false);
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    await user.click(screen.getByRole("button", { name: "Save as project" }));

    await waitFor(() => expect(burnListStatus()).toHaveTextContent("project was not saved"));
    expect(screen.getByRole("button", { name: "Projects 0" })).toBeVisible();
  });

  it("makes project curator mode obvious and exits before creating a separate personal mix", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    window.__MXTP_INVOKE__ = async (command) => {
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=album", title: "Album", artist: "Artist", trackCount: 2 } as never;
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [
        { id: "ready-one-new", title: "First", durationSec: 180, path: "C:/cache/one-new.opus" },
        { id: "ready-two-new", title: "Second", durationSec: 200, path: "C:/cache/two-new.opus" }
      ] } as never;
      throw new Error(`unexpected command ${command}`);
    };
    const original = savedProjectFixture();
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[original]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    expect(screen.getByText("Editing project: Album · changes save automatically")).toBeVisible();
    expect(screen.getByText("Requests here change Album. Use Exit project to start a new mix.")).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), "Make a mixtape of my 2 favorite tracks");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: ACCEPT })).toBeVisible();
    await waitFor(() => expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({ id: original.id })));

    await user.click(screen.getByTestId("exit-project-button"));
    expect(screen.queryByText(/Editing project: Album/)).toBeNull();
    expect(screen.queryByText(/Requests here change/)).toBeNull();
    expect(screen.queryByText("Make a mixtape of my 2 favorite tracks")).toBeNull();
    expect(screen.getByRole("button", { name: "My favorites from 2026" })).toBeVisible();
    onSaveProject.mockClear();
    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), "Make a mixtape of my 2 favorite tracks");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSaveProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: ACCEPT })).toBeVisible();
    await user.click(screen.getByRole("button", { name: ACCEPT }));

    await waitFor(() => expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({ saved: true })));
    expect(onSaveProject.mock.calls.every(([project]) => project.id !== original.id)).toBe(true);
    expect(original.burnQueue.map((item) => item.title)).toEqual(["First", "Second"]);
  });

  it("routes a how-to question to the spotlight guide without modifying the open project", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const original = savedProjectFixture();
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[original]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Projects 1" }));
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await user.click(screen.getByRole("button", { name: "How do I download a full album?" }));

    expect(await screen.findByRole("dialog", { name: "Download audio" })).toBeVisible();
    expect(screen.getByTestId("album-detail")).toBeVisible();
    expect(within(screen.getByTestId("album-detail")).getByRole("button", { name: "Download full album" })).toHaveAttribute("data-help-target", "album-download");
    expect(onSaveProject).not.toHaveBeenCalled();
    expect(original.burnQueue.map((item) => item.title)).toEqual(["First", "Second"]);
    await user.click(screen.getByRole("button", { name: "Close guide" }));
  });

  it("refreshes the locally synced Apple Music database from Sources", async () => {
    const refreshed = { ...library, summary: { ...library.summary, trackCount: 3, totalPlays: 19 } };
    const onRefreshApple = vi.fn().mockResolvedValue(refreshed);
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={{ ...library, sources: [{ source: "apple", label: "Apple Music", imported: true, sourcePath: library.sourcePath, trackCount: 2, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 15, limitations: ["Local history only"] }] }}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRefreshApple={onRefreshApple}
      />
    );
    await user.click(screen.getByRole("button", { name: "Music sources" }));
    await user.click(screen.getByRole("button", { name: "Re-read Apple Music library" }));
    await waitFor(() => expect(onRefreshApple).toHaveBeenCalledOnce());
    expect(within(screen.getByTestId("music-sources")).getByRole("status")).toHaveTextContent("Apple Music library read: 3 songs and 19 recorded plays.");
  });

  it("keeps curator recommendations out of the burn list until the person confirms them, and accepting downloads nothing", async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const commands: string[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      commands.push(command);
      if (command === "find_youtube_album_playlist") return { url: "https://youtube.com/playlist?list=album", title: "Album", artist: "Artist", trackCount: 2 } as never;
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [
        { id: "ready-one", title: "First", durationSec: 180, path: "C:/cache/one.opus" },
        { id: "ready-two", title: "Second", durationSec: 200, path: "C:/cache/two.opus" }
      ] } as never;
      throw new Error(`unexpected command ${command}`);
    };
    const onSaveProject = vi.fn();
    const user = userEvent.setup();
    render(
      <AppleMusicLibrary
        library={library}
        projects={[]}
        projectsLoading={false}
        onCreateCustom={vi.fn()}
        onOpenStudio={vi.fn()}
        onPreparedAlbum={vi.fn()}
        onUpdateProject={vi.fn()}
        onSaveProject={onSaveProject}
        onDeleteProject={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "AI Curator" }));
    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), "Make a mixtape of my 2 favorite tracks");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSaveProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: ACCEPT })).toBeVisible();
    expect(burnListStatus()).toHaveTextContent(/^Curator proposal ready: 2 tracks\. Decide in AI Curator\.$/);
    expect(screen.getByText(/This is only a proposal\. Say yes or click Add to burn list/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "No thanks" }));
    expect(onSaveProject).not.toHaveBeenCalled();
    expect(burnListStatus()).toHaveTextContent("Nothing was downloaded or added");

    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), "Make a mixtape of my 2 favorite tracks");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByRole("textbox", { name: "Ask the MXTP curator" }), "yes");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSaveProject).toHaveBeenCalledWith(expect.objectContaining({
      saved: true,
      burnQueue: [expect.objectContaining({ title: "First" }), expect.objectContaining({ title: "Second" })],
      curator: expect.objectContaining({ revision: expect.any(Number), messages: expect.arrayContaining([expect.objectContaining({ role: "user" }), expect.objectContaining({ role: "assistant" })]) })
    })));
    expect(screen.getAllByText(/Here's a mix/)).toHaveLength(2);
    expect(screen.getAllByText(/This is only a proposal/)).toHaveLength(2);
    expect(burnListStatus()).toHaveTextContent(/^Added 2 tracks to .+\. Click Download in the burn list when you want the audio\.$/);
    expect(screen.getByText("2 tracks")).toBeVisible();
    expect(screen.getByRole("button", { name: "First is not downloaded" })).toBeVisible();
    expect(commands.filter((command) => command === "find_youtube_track" || command === "download_playlist_best")).toEqual([]);
  });
});
