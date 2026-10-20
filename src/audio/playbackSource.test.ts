import { readFile } from "@tauri-apps/plugin-fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlaybackSource } from "./playbackSource";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

describe("local audio playback sources", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reads downloaded Opus audio into a typed object URL and releases it", async () => {
    vi.mocked(readFile).mockResolvedValue(Uint8Array.from([79, 103, 103, 83]));
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mxtp-opus");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const source = await loadPlaybackSource({
      id: "guidance-1",
      title: "Asa",
      durationSec: 427,
      path: "/music/Guidance/001 - Asa.opus",
      url: "asset://localhost/music/Guidance/001%20-%20Asa.opus"
    });

    expect(readFile).toHaveBeenCalledWith("/music/Guidance/001 - Asa.opus");
    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/ogg; codecs=opus");
    expect(source.src).toBe("blob:mxtp-opus");

    source.release();
    source.release();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:mxtp-opus");
  });

  it("keeps browser-provided object URLs without reading or revoking them", async () => {
    const source = await loadPlaybackSource({
      id: "upload",
      title: "Upload",
      durationSec: 10,
      url: "blob:browser-upload"
    });

    expect(source.src).toBe("blob:browser-upload");
    expect(readFile).not.toHaveBeenCalled();
    source.release();
  });
});
