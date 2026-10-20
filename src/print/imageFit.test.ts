import { afterEach, describe, expect, it, vi } from "vitest";
import { getDimension } from "./dimensions";
import { generateFittedArtwork, resolveArtworkTarget } from "./imageFit";

const originalMode = process.env.MXTP_MKR_IMAGEGEN;

describe("print image fit", () => {
  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.MXTP_MKR_IMAGEGEN;
    } else {
      process.env.MXTP_MKR_IMAGEGEN = originalMode;
    }
  });

  it("resolves image targets from registry bleed px@300", () => {
    const cd100 = resolveArtworkTarget("CD100");
    const cd1600 = resolveArtworkTarget("CD1600R");
    const cdt100 = resolveArtworkTarget("CDT100");

    expect(cd100.widthPx).toBe(1500);
    expect(cd100.heightPx).toBe(1500);
    expect(cd1600.widthPx).toBe(getDimension("CD1600R")!.pageBleed!.px300.w);
    expect(cd1600.heightPx).toBe(getDimension("CD1600R")!.pageBleed!.px300.h);
    expect(cdt100.widthPx).toBe(getDimension("CDT100")!.bleed!.px300.w);
    expect(cdt100.heightPx).toBe(getDimension("CDT100")!.bleed!.px300.h);
  });

  it("uses the mock adapter without spending image quota", async () => {
    process.env.MXTP_MKR_IMAGEGEN = "mock";
    const generator = vi.fn();

    const art = await generateFittedArtwork(
      { prompt: "In Rainbows cover", targetComponentId: "CD100" },
      generator
    );

    expect(generator).not.toHaveBeenCalled();
    expect(art).toMatchObject({
      componentId: "CD100_in",
      imagePath: "mock://CD100_in/1500x1500.png",
      widthPx: 1500,
      heightPx: 1500,
      mock: true
    });
    expect(art.prompt).toContain("exactly 1500x1500px");
    expect(art.prompt).toContain("safety");
  });

  it("passes exact target dimensions to the real adapter prompt", async () => {
    delete process.env.MXTP_MKR_IMAGEGEN;
    const generator = vi.fn(async (prompt: string) => ({
      imagePath: "C:/tmp/codex-cover.png",
      prompt,
      palette: ["#000000"]
    }));

    const art = await generateFittedArtwork(
      { prompt: "Tray back art", targetComponentId: "CDT100" },
      generator
    );

    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0][0]).toContain("1847x1463px");
    expect(art.widthPx).toBe(1847);
    expect(art.heightPx).toBe(1463);
    expect(art.mock).toBe(false);
  });
});
