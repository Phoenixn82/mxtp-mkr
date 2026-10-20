import { render, screen } from "@testing-library/react";
import { Group } from "three";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { prefersReducedMotion } from "../case3d/shared";
import { CaseModelCanvas, floatFrame } from "./CaseModelCanvas";

const mocks = vi.hoisted(() => ({
  webgl: vi.fn(() => false),
  jewel: vi.fn((_props: Record<string, unknown>) => null as unknown)
}));

vi.mock("../case3d", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../case3d")>()),
  canUseWebgl: mocks.webgl,
  JewelCaseExact: (props: Record<string, unknown>) => mocks.jewel(props)
}));

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query }));
}

describe("landing case model", () => {
  afterEach(() => {
    mocks.webgl.mockReset().mockReturnValue(false);
    mocks.jewel.mockReset().mockReturnValue(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("holds the case still when the person prefers reduced motion", () => {
    mockReducedMotion(true);
    const group = new Group();
    group.rotation.set(-0.12, -0.16, 0);
    floatFrame(group, 3.2, prefersReducedMotion());
    expect([group.rotation.x, group.rotation.y, group.position.y]).toEqual([-0.12, -0.16, 0]);
  });

  it("sways the case otherwise", () => {
    mockReducedMotion(false);
    const group = new Group();
    floatFrame(group, 3.2, prefersReducedMotion());
    expect(group.rotation.y).not.toBe(0);
    expect(group.position.y).not.toBe(0);
  });

  it("names the format instead of a blank canvas when WebGL is unavailable", () => {
    render(<CaseModelCanvas modelId="vinyl" />);
    expect(screen.getByTestId("landing-case-model")).toHaveTextContent("Vinyl: 3D preview unavailable");
    expect(screen.getByTestId("landing-case-model").querySelector("canvas")).toBeNull();
  });

  it("falls back to the format label when the 3D case fails", () => {
    expectCaughtRenderError();
    mocks.webgl.mockReturnValue(true);
    mocks.jewel.mockImplementation(() => {
      throw new Error("WebGL context lost");
    });
    render(<CaseModelCanvas modelId="jewelcase" />);
    expect(screen.getByText("Jewel case: 3D preview unavailable")).toHaveClass("canvas-fallback");
  });

  it("renders unknown formats with the procedural jewel case", () => {
    mocks.webgl.mockReturnValue(true);
    render(<CaseModelCanvas modelId="not-a-format" />);
    expect(mocks.jewel).toHaveBeenCalledWith(expect.objectContaining({ autoOpen: true }));
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
