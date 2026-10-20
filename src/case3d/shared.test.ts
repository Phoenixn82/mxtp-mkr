import { afterEach, describe, expect, it, vi } from "vitest";
import { canUseWebgl, resetWebglProbe } from "./shared";

describe("WebGL probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetWebglProbe();
  });

  it("is false when the WebGL constructor exists but no context can be created", () => {
    vi.stubGlobal("WebGLRenderingContext", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(canUseWebgl()).toBe(false);
  });

  it("is true when a context is created, releases the probe context, and probes once", () => {
    vi.stubGlobal("WebGLRenderingContext", class {});
    const loseContext = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ getExtension: () => ({ loseContext }) } as unknown as RenderingContext);
    expect(canUseWebgl()).toBe(true);
    expect(canUseWebgl()).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith("webgl2");
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("is false without the WebGL constructor, without touching a canvas", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    expect(canUseWebgl()).toBe(false);
    expect(getContext).not.toHaveBeenCalled();
  });
});
