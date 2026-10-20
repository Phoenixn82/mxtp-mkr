import { beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { buildBookletPdf } from "./bookletExport";
import { bookletComponentId, exportBooklet } from "./exportBooklet";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("./bookletExport", () => ({ buildBookletPdf: vi.fn() }));

const pdfBytes = Uint8Array.from([37, 80, 68, 70]);

describe("bookletComponentId", () => {
  it("maps saddle page counts to Disc Makers booklet components", () => {
    expect(bookletComponentId(8)).toBe("CD800R");
    expect(bookletComponentId(12)).toBe("CD1200R");
    expect(bookletComponentId(16)).toBe("CD1600R");
    expect(bookletComponentId(24)).toBe("CD2400R");
    expect(bookletComponentId(4)).toBeUndefined();
    expect(bookletComponentId(28)).toBeUndefined();
  });
});

describe("exportBooklet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildBookletPdf).mockResolvedValue(pdfBytes);
    vi.mocked(save).mockResolvedValue("C:/out/booklet-CD1600R.pdf");
  });

  it("maps state into buildBookletPdf and writes the saved file", async () => {
    const cover = Uint8Array.from([9, 9]);
    const result = await exportBooklet({
      pages: 16,
      coverBytes: cover,
      tracks: [{ title: "Alpha" }, { title: "Beta" }],
      lyricsByTrack: [{ title: "Alpha", lyrics: "line one" }],
      credits: "Produced by MXTP",
      design: { artist: "A", album: "B", tags: ["jazz"] }
    });

    expect(buildBookletPdf).toHaveBeenCalledWith({
      componentId: "CD1600R",
      coverImage: cover,
      tracks: [{ title: "Alpha" }, { title: "Beta" }],
      lyricsByTrack: [{ title: "Alpha", lyrics: "line one" }],
      credits: "Produced by MXTP",
      design: { artist: "A", album: "B", tags: ["jazz"] }
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "PDF", extensions: ["pdf"] }] })
    );
    expect(writeFile).toHaveBeenCalledWith("C:/out/booklet-CD1600R.pdf", pdfBytes);
    expect(result).toEqual({ ok: true, path: "C:/out/booklet-CD1600R.pdf" });
  });

  it("follows the selected page count into the component id", async () => {
    await exportBooklet({ pages: 8, tracks: [{ title: "Only" }] });
    expect(buildBookletPdf).toHaveBeenCalledWith(expect.objectContaining({ componentId: "CD800R" }));

    await exportBooklet({ pages: 20, tracks: [{ title: "Only" }] });
    expect(buildBookletPdf).toHaveBeenLastCalledWith(expect.objectContaining({ componentId: "CD2000R" }));
  });

  it("reads cover bytes from the front-slot imageRef via the fs plugin", async () => {
    vi.mocked(readFile).mockResolvedValue(Uint8Array.from([7, 7, 7]));
    await exportBooklet({
      pages: 16,
      coverImageRef: "C:/covers/front.png",
      tracks: [{ title: "Alpha" }]
    });
    expect(readFile).toHaveBeenCalledWith("C:/covers/front.png");
    expect(buildBookletPdf).toHaveBeenCalledWith(
      expect.objectContaining({ coverImage: Uint8Array.from([7, 7, 7]) })
    );
  });

  it("falls back to the preview URL when the file read fails", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("no tauri"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([5, 5]).buffer
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await exportBooklet({
        pages: 16,
        coverImageRef: "C:/covers/front.png",
        coverPreviewRef: "http://localhost/front.png",
        tracks: [{ title: "Alpha" }]
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost/front.png");
      expect(buildBookletPdf).toHaveBeenCalledWith(
        expect.objectContaining({ coverImage: Uint8Array.from([5, 5]) })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a cancelled save dialog without writing", async () => {
    vi.mocked(save).mockResolvedValue(null);
    const result = await exportBooklet({ pages: 16, tracks: [{ title: "Alpha" }] });
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects page counts with no print component before building", async () => {
    const result = await exportBooklet({ pages: 4, tracks: [{ title: "Alpha" }] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No print template for 4 pages");
    expect(buildBookletPdf).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("surfaces build and write failures instead of throwing", async () => {
    vi.mocked(buildBookletPdf).mockRejectedValue(new Error("render exploded"));
    const result = await exportBooklet({ pages: 16, tracks: [{ title: "Alpha" }] });
    expect(result).toEqual({ ok: false, error: "render exploded" });

    vi.mocked(buildBookletPdf).mockResolvedValue(pdfBytes);
    vi.mocked(writeFile).mockRejectedValue(new Error("disk full"));
    const writeResult = await exportBooklet({ pages: 16, tracks: [{ title: "Alpha" }] });
    expect(writeResult).toEqual({ ok: false, error: "disk full" });
  });
});
