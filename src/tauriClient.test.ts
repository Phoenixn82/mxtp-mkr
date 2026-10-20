import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeCommand } from "./tauriClient";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

describe("Tauri command bridge", () => {
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    vi.mocked(tauriInvoke).mockReset();
  });

  it("routes through the deterministic harness when one is installed", async () => {
    const harness = vi.fn(async () => ({ drives: ["D:"] }));
    window.__MXTP_INVOKE__ = harness as typeof window.__MXTP_INVOKE__;

    await expect(invokeCommand("list_burners", { includeVirtual: false })).resolves.toEqual({ drives: ["D:"] });
    expect(harness).toHaveBeenCalledWith("list_burners", { includeVirtual: false });
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it("routes through native Tauri invoke when no harness is installed", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ path: "C:/export/front.pdf" });

    await expect(invokeCommand("compose_pdf", { piece: { pieceId: "front" } })).resolves.toEqual({
      path: "C:/export/front.pdf"
    });
    expect(tauriInvoke).toHaveBeenCalledWith("compose_pdf", { piece: { pieceId: "front" } });
  });

  it("preserves native invoke failures for command-level handling", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce(new Error("native bridge offline"));

    await expect(invokeCommand("list_burners")).rejects.toThrow("native bridge offline");
    expect(tauriInvoke).toHaveBeenCalledWith("list_burners", undefined);
  });
});
