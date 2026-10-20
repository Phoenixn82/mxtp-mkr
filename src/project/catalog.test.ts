import { afterEach, describe, expect, it, vi } from "vitest";
import { createCdProject, loadCdProjects, mergeCachedPlaylists, normalizeCdProject, projectCover, projectFromBurnQueue, savedProjects, upsertCdProject, type CdProject } from "./catalog";

describe("recent CD catalog", () => {
  it("creates a persistable project with a stable safe id", () => {
    const project = createCdProject(
      { artist: "Daft Punk", album: "Discovery", formatId: "jewelcase" },
      new Date("2026-08-25T01:00:00Z"),
      "abc123"
    );
    expect(project.id).toBe("daft-punk-discovery-1787619600000-abc123");
    expect(project.bookletPages).toBe(16);
    expect(project.research).toBeNull();
    expect(project.saved).toBe(false);
    expect(project.kind).toBe("artist");
  });

  it("recovers cached playlist audio and cover without duplicating an existing source", () => {
    const cached = [{
      sourcePath: "C:/cache/Pretti Loves U 2",
      title: "Pretti Loves U 2",
      quality: "best",
      coverPath: "C:/cache/Pretti Loves U 2/cover.jpg",
      tracks: [{ id: "one", title: "One", durationSec: 180, path: "C:/cache/one.opus" }],
      updatedAtMs: Date.parse("2026-08-24T22:00:00Z")
    }];
    const first = mergeCachedPlaylists([], cached);
    const second = mergeCachedPlaylists(first, cached);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].tracks).toHaveLength(1);
    expect(first[0].saved).toBe(false);
    expect(savedProjects(first)).toEqual([]);
    expect(projectCover(first[0])?.imageRef).toContain("cover.jpg");
  });

  it("migrates meaningful legacy projects while hiding recovered caches and empty drafts", () => {
    const base = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" }, new Date("2026-01-01"), "base");
    const legacy = normalizeCdProject({ ...base, saved: undefined, tracks: [{ id: "one", title: "One", durationSec: 10, path: "C:/one.opus" }] });
    const recovered = normalizeCdProject({ ...base, id: "recovered-cache", saved: undefined, tracks: [{ id: "one", title: "One", durationSec: 10, path: "C:/one.opus" }] });
    const empty = normalizeCdProject({ ...base, saved: undefined, entry: { artist: "", album: "", formatId: "jewelcase" } });
    expect(legacy.saved).toBe(true);
    expect(recovered.saved).toBe(false);
    expect(empty.saved).toBe(false);
  });

  it("restores completed progress for a legacy project with a recorded physical burn", () => {
    const base = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" });
    const burned = normalizeCdProject({
      ...base,
      burnProgress: 0,
      lastBurnedAt: "2026-09-05T21:21:04.727Z"
    });

    expect(burned.saved).toBe(true);
    expect(burned.burnProgress).toBe(100);
  });

  it("classifies a mixed burn queue as a custom CD for project filtering", () => {
    const project = projectFromBurnQueue([
      { id: "one", albumKey: "artist::first", title: "One", artist: "Artist", album: "First", durationSec: 120 },
      { id: "two", albumKey: "other::second", title: "Two", artist: "Other", album: "Second", durationSec: 140 }
    ], "Road mix");
    expect(project.kind).toBe("custom");
    expect(project.name).toBe("Road mix");
  });

  it("keeps the most recently changed project first", () => {
    const older = createCdProject({ artist: "A", album: "Old", formatId: "jewelcase" }, new Date("2026-01-01"), "old");
    const newer = { ...older, id: "new", entry: { ...older.entry, album: "New" }, updatedAt: "2026-08-25T01:00:00Z" };
    expect(upsertCdProject([older], newer).map((project) => project.entry.album)).toEqual(["New", "Old"]);
  });

  it("uses saved research artwork as the project-card cover when no front slot is assigned", () => {
    const project = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" });
    project.research = {
      album: { artist: "Artist", album: "Album", year: 2026, label: "Label", tracks: [], coverArtUrls: [], tags: [] },
      cover: { imagePath: "/project/assets/front.png", previewUrl: "data:image/png;base64,preview", prompt: "cover", palette: [] },
      lyricsByTrack: []
    };

    expect(projectCover(project)).toEqual(expect.objectContaining({
      slotId: "front",
      imageRef: "/project/assets/front.png",
      previewRef: "data:image/png;base64,preview",
      imageSource: "research"
    }));
  });

  it("keeps ASCII album identities byte-identical and gives non-Latin albums their own key", () => {
    const legacy = normalizeCdProject({
      ...createCdProject({ artist: "Daft Punk", album: "Discovery", formatId: "jewelcase" }, new Date("2026-01-01"), "a"),
      burnQueue: undefined,
      tracks: [{ id: "one", title: "One", durationSec: 10, path: "/one.opus" }]
    });
    expect(legacy.burnQueue[0].albumKey).toBe("daftpunk::discovery");
    const accented = normalizeCdProject({
      ...createCdProject({ artist: "Beyoncé", album: "Lemonade", formatId: "jewelcase" }, new Date("2026-01-01"), "a"),
      burnQueue: undefined,
      tracks: [{ id: "one", title: "One", durationSec: 10, path: "/one.opus" }]
    });
    expect(accented.burnQueue[0].albumKey).toBe("beyonce::lemonade");
    const [recovered] = mergeCachedPlaylists([], [{
      sourcePath: "/cache/Pretti Loves U 2", title: "Pretti Loves U 2", quality: "best",
      tracks: [{ id: "one", title: "One", durationSec: 180, path: "/cache/one.opus" }], updatedAtMs: 0
    }]);
    expect(recovered.burnQueue[0].albumKey).toBe("::prettilovesu2");
    expect(recovered.id).toMatch(/^recovered-pretti-loves-u-2-/);

    const japanese = normalizeCdProject({
      ...createCdProject({ artist: "宇多田ヒカル", album: "初恋", formatId: "jewelcase" }, new Date("2026-01-01"), "a"),
      burnQueue: undefined,
      tracks: [{ id: "one", title: "One", durationSec: 10, path: "/one.opus" }]
    });
    expect(japanese.burnQueue[0].albumKey).toBe("宇多田ヒカル::初恋");
  });

  it("gives non-Latin projects distinct ids instead of a shared 'cd' slug", () => {
    const now = new Date("2026-01-01");
    const first = createCdProject({ artist: "Кино", album: "Группа крови", formatId: "jewelcase" }, now, "x");
    const second = createCdProject({ artist: "Кино", album: "Звезда по имени Солнце", formatId: "jewelcase" }, now, "x");
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toMatch(/^cd-cd-/);
    expect(first.id).toMatch(/^[a-z0-9-]+$/);
    expect(createCdProject({ artist: "!!!", album: "", formatId: "jewelcase" }, now, "x").id).toBe(`cd-untitled-${now.getTime()}-x`);
  });

  it("keeps an artist project's identity when its burn list is emptied", () => {
    const existing = projectFromBurnQueue([
      { id: "one", albumKey: "artist::album", title: "One", artist: "Artist", album: "Album", durationSec: 120 }
    ], "Album", undefined, new Date("2026-01-01"));
    expect(existing.kind).toBe("artist");
    const emptied = projectFromBurnQueue([], "", existing, new Date("2026-01-02"));
    expect(emptied.entry).toEqual(existing.entry);
    expect(emptied.kind).toBe("artist");
    expect(emptied.name).toBe("Album");
    expect(emptied.burnQueue).toEqual([]);
    expect(emptied.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keeps an emptied burn list empty after reopening and still migrates legacy projects", () => {
    const base = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" }, new Date("2026-01-01"), "base");
    const track = { id: "a", title: "A", durationSec: 10, path: "/a.opus" };
    expect(normalizeCdProject({ ...base, burnQueue: [], tracks: [track] }).burnQueue).toEqual([]);
    const legacy = normalizeCdProject({ ...base, burnQueue: undefined, tracks: [track] });
    expect(legacy.burnQueue.map((item) => item.id)).toEqual(["a"]);
    expect(legacy.burnQueue[0].ready).toEqual(track);
  });

  it("clamps the booklet page count to the nearest printable count, ties rounding up", () => {
    const base = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" }, new Date("2026-01-01"), "base");
    const pages = (bookletPages: unknown) => normalizeCdProject({ ...base, bookletPages: bookletPages as number }).bookletPages;
    expect(pages(2)).toBe(8);
    expect(pages(6)).toBe(8);
    expect(pages(10)).toBe(12);
    expect(pages(14)).toBe(16);
    expect(pages(16)).toBe(16);
    expect(pages(18)).toBe(20);
    expect(pages(40)).toBe(24);
    expect(pages(undefined)).toBe(16);
    expect(pages("12")).toBe(16);
    expect(pages(Number.NaN)).toBe(16);
  });

  it("defaults partial research and curator data to empty arrays", () => {
    const base = createCdProject({ artist: "Artist", album: "Album", formatId: "jewelcase" }, new Date("2026-01-01"), "base");
    const project = normalizeCdProject({
      ...base,
      research: { album: { artist: "Artist", album: "Album" }, cover: { imagePath: "/front.png" } } as unknown as CdProject["research"],
      curator: { memory: {}, messages: "nope" } as unknown as CdProject["curator"]
    });
    expect(project.research?.lyricsByTrack).toEqual([]);
    expect(project.research?.album).toMatchObject({ artist: "Artist", album: "Album", tracks: [], coverArtUrls: [], tags: [] });
    expect(project.research?.cover).toMatchObject({ imagePath: "/front.png", palette: [] });
    expect(project.curator).toMatchObject({ memory: { dislikedArtists: [], preferredGenres: [], notes: "" }, messages: [], revision: 0 });
    expect(normalizeCdProject({ ...base, research: { lyricsByTrack: [] } as unknown as CdProject["research"] }).research?.album)
      .toMatchObject({ artist: "Artist", album: "Album", tracks: [] });
  });

  describe("loading stored projects", () => {
    afterEach(() => {
      window.__MXTP_INVOKE__ = undefined;
      vi.restoreAllMocks();
    });

    it("skips structurally invalid projects and keeps every valid one", async () => {
      const good = createCdProject({ artist: "Neon Tide", album: "Static Bloom", formatId: "jewelcase" }, new Date("2026-09-01"), "good");
      const partial = {
        ...createCdProject({ artist: "Iron Meridian", album: "Forge Lines", formatId: "jewelcase" }, new Date("2026-08-01"), "part"),
        research: { album: { artist: "Iron Meridian", album: "Forge Lines", year: 2025, label: "x", tracks: [], coverArtUrls: [], tags: [] } }
      };
      const stored: unknown[] = [
        good,
        { ...good, id: "bad-entry", entry: null },
        { ...good, id: "string-entry", entry: "Static Bloom" },
        { ...good, id: undefined },
        { id: "no-entry" },
        null,
        "garbage",
        partial
      ];
      window.__MXTP_INVOKE__ = (async (command: string) => {
        expect(command).toBe("load_cd_projects");
        return stored;
      }) as typeof window.__MXTP_INVOKE__;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const projects = await loadCdProjects();

      expect(projects.map((project) => project.id)).toEqual([good.id, partial.id]);
      expect(projects[1].research?.lyricsByTrack).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("6");
    });
  });
});
