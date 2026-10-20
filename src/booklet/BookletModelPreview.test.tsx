import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { composeBookletPages } from "./bookletExport";
import { BookletModelPreview, pageDataForBooklet } from "./BookletModelPreview";

const mocks = vi.hoisted(() => ({
  webgl: vi.fn(() => false),
  canvas: vi.fn((_props: Record<string, unknown>) => null as unknown)
}));

vi.mock("../case3d", () => ({
  Booklet3D: () => null,
  canUseWebgl: mocks.webgl
}));

vi.mock("@react-three/fiber", () => ({
  Canvas: (props: Record<string, unknown>) => mocks.canvas(props)
}));

describe("BookletModelPreview", () => {
  afterEach(() => {
    mocks.webgl.mockReset().mockReturnValue(false);
    mocks.canvas.mockReset().mockReturnValue(null);
    vi.restoreAllMocks();
  });

  it.each([
    ["CD800R", 8],
    ["CD1200R", 12],
    ["CD1600R", 16],
    ["CD2000R", 20],
    ["CD2400R", 24]
  ])("maps every reader face of the physical %s booklet", (componentId, pages) => {
    const composed = composeBookletPages({
      componentId,
      tracks: [],
      design: { artist: "Nova", album: "Current", tags: ["electronic"] }
    });
    const data = pageDataForBooklet(composed, "data:image/png;base64,cover");

    expect(data).toHaveLength(pages);
    expect(data.map((page) => page.pageNumber)).toEqual(Array.from({ length: pages }, (_, index) => index + 1));
    expect(data[0].image).toBe("data:image/png;base64,cover");
    expect(data[0].text).toContain("Current");
    expect(data.every((page) => page.background && page.foreground)).toBe(true);
    expect(new Set(data.map((page) => page.text)).size).toBeGreaterThan(3);
  });

  it("renders an honest physical-stack fallback when WebGL is unavailable", () => {
    const composed = composeBookletPages({ componentId: "CD1600R", tracks: [] });
    render(<BookletModelPreview composed={composed} />);

    expect(screen.getByTestId("booklet-model-preview")).toHaveAccessibleName("16-page printed booklet model");
    expect(screen.getByRole("img", { name: "16-page printed booklet model" })).toBeInTheDocument();
    expect(screen.getByTestId("booklet-model-page")).toHaveTextContent("Reader page 1");
  });

  it("falls back to the paper stack when the 3D booklet fails, without crashing the studio", () => {
    expectCaughtRenderError();
    mocks.webgl.mockReturnValue(true);
    mocks.canvas.mockImplementation(() => {
      throw new Error("Could not load cover.jpg");
    });
    const composed = composeBookletPages({ componentId: "CD1600R", tracks: [] });
    render(<BookletModelPreview composed={composed} coverPreviewUrl="asset://missing/cover.jpg" />);

    expect(screen.getByRole("img", { name: "16-page printed booklet model" })).toHaveClass("booklet-model-fallback");
    expect(screen.getByText("3D preview unavailable")).toHaveClass("canvas-fallback");
    expect(screen.getByTestId("booklet-model-page")).toHaveTextContent("Reader page 1");
  });
});

/** The 3D child is meant to throw here: keep React's dev rethrow and the boundary's warning out of the log. */
function expectCaughtRenderError() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const quiet = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", quiet);
  onTestFinished(() => window.removeEventListener("error", quiet));
}
