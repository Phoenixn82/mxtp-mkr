import { Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artSlots, buildCase, loadArt, resolveJewelCaseExactClickTarget } from "./JewelCaseExact";

describe("exact jewel case interaction", () => {
  it("opens a closed case even when the ray also passes through the seated disc", () => {
    expect(resolveJewelCaseExactClickTarget(false, true, true)).toBe("case");
  });

  it("allows disc ejection only after the case is open", () => {
    expect(resolveJewelCaseExactClickTarget(true, true, true)).toBe("disc");
    expect(resolveJewelCaseExactClickTarget(false, true, false)).toBeNull();
  });
});

describe("exact jewel case art", () => {
  afterEach(() => vi.restoreAllMocks());

  // jsdom has no 2D canvas; buildCase only needs one for the tray's grain texture.
  function buildWithoutCanvas() {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => undefined
    } as unknown as CanvasRenderingContext2D);
    return buildCase();
  }

  function paint(art: Parameters<typeof artSlots>[1]) {
    const parts = buildWithoutCanvas();
    const textures = new Map<string, Texture>();
    const loader = {
      load: vi.fn((url: string, onLoad?: (texture: Texture) => void) => {
        const texture = new Texture();
        textures.set(url, texture);
        onLoad?.(texture);
        return texture;
      })
    };
    for (const [mesh, url] of artSlots(parts, art)) loadArt(mesh, url, loader as never);
    return { parts, textures, loader };
  }

  it("prints the disc art on the disc label, which travels with the disc", () => {
    const { parts, textures } = paint({ discArtUrl: "disc.png" });
    expect(parts.discLabel.material.map).toBe(textures.get("disc.png"));
    expect(parts.discLabel.visible).toBe(true);
    expect(parts.discPivot.getObjectById(parts.discLabel.id)).toBe(parts.discLabel);
    expect(parts.trayCard.visible).toBe(false);
    expect(parts.insert.visible).toBe(false);
  });

  it("puts the tray art on the back of the tray and the front art inside the lid", () => {
    const { parts, textures } = paint({ frontArtUrl: "front.png", backArtUrl: "tray.png" });
    expect(parts.trayCard.material.map).toBe(textures.get("tray.png"));
    expect(parts.tray.getObjectById(parts.trayCard.id)).toBe(parts.trayCard);
    expect(parts.insert.material.map).toBe(textures.get("front.png"));
    expect(parts.lidPivot.getObjectById(parts.insert.id)).toBe(parts.insert);
    expect(parts.discLabel.visible).toBe(false);
  });

  it("drops a texture that finishes loading after the art changed", () => {
    const parts = buildWithoutCanvas();
    let finish: ((texture: Texture) => void) | undefined;
    const cancel = loadArt(parts.discLabel, "old.png", { load: (_url: string, onLoad: (texture: Texture) => void) => ((finish = onLoad), new Texture()) } as never);
    cancel();
    const late = new Texture();
    const dispose = vi.spyOn(late, "dispose");
    finish?.(late);
    expect(parts.discLabel.material.map).toBeNull();
    expect(dispose).toHaveBeenCalled();
  });
});
