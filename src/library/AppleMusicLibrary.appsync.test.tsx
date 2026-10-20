import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleMusicLibrary } from "./AppleMusicLibrary";
import type { AppleMusicLibraryData, AppleMusicTrack } from "./appleMusic";
import { upsertCdProject, type CdProject } from "../project/catalog";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
// These drive whole download flows with userEvent; a busy shared test host needs more than 5 s.
vi.setConfig({ testTimeout: 20_000 });

const track = (id: string, title: string, n: number): AppleMusicTrack => ({
  id, title, artist: "Artist", album: "Album", albumArtist: "Artist", genre: "Rap", trackNumber: n, durationSec: 180,
  playCount: 10, lastPlayedUnixMs: 200, likeStatus: 2, inAppleLibrary: true
});
const library: AppleMusicLibraryData = {
  sourcePath: "x", version: "1",
  summary: { trackCount: 2, albumCount: 1, artistCount: 1, playlistCount: 0, totalPlays: 20, artworkTrackCount: 0 },
  tracks: [track("one", "First", 1), track("two", "Second", 2)], playlists: []
};

// Mirrors App.tsx: sync updateProject, async explicit save that re-stamps updatedAt.
const published: CdProject[] = [];

function Harness() {
  const [projects, setProjects] = useState<CdProject[]>([]);
  const updateProject = useCallback((project: CdProject) => {
    published.push(project);
    setProjects((current) => upsertCdProject(current, project));
  }, []);
  const save = useCallback(async (project: CdProject) => {
    const saved = { ...project, saved: true, updatedAt: new Date(Date.now() + 1).toISOString() };
    await new Promise((done) => setTimeout(done, 5));
    setProjects((current) => upsertCdProject(current, saved));
    return true;
  }, []);
  return <AppleMusicLibrary library={library} projects={projects} projectsLoading={false} onCreateCustom={vi.fn()} onOpenStudio={vi.fn()}
    onPreparedAlbum={vi.fn()} onUpdateProject={updateProject} onSaveProject={save} onDeleteProject={vi.fn()} />;
}

describe("library inside an App-like parent", () => {
  beforeEach(() => { localStorage.clear(); Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() }); });
  afterEach(() => { window.__MXTP_INVOKE__ = undefined; localStorage.clear(); });

  it("a downloaded album project stays cleared after Clear burn list", async () => {
    window.__MXTP_INVOKE__ = (async (command: string) => {
      if (command === "find_youtube_album_playlist") return { url: "u", title: "Album", artist: "Artist", trackCount: 2, safeTrackPositions: [1, 2] };
      if (command === "download_playlist_best") return { title: "Album", quality: "best", tracks: [{ id: "a", title: "First", durationSec: 2, path: "/c/001 - First.wav" }, { id: "b", title: "Second", durationSec: 2, path: "/c/002 - Second.wav" }] };
      throw new Error(command);
    }) as typeof window.__MXTP_INVOKE__;
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open Album" }));
    await user.click(screen.getByRole("button", { name: /^Full album/ }));
    await user.click(await screen.findByRole("button", { name: "Download full album" }));
    await screen.findByText(/Editing project/);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder First" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder First" }), { key: "ArrowUp" });
    const list = within(screen.getByRole("complementary", { name: "CD burn list" }));
    await user.click(list.getByRole("button", { name: "Clear burn list" }));
    await new Promise((done) => setTimeout(done, 100));
    expect(list.getByText("0 tracks")).toBeInTheDocument();
    // Loading falls back to tracks when burnQueue is empty, so a cleared project keeps none.
    expect(published.at(-1)).toMatchObject({ burnQueue: [], tracks: [], kind: "artist", entry: { artist: "Artist", album: "Album" } });
  });
});
