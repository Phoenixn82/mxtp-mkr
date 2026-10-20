import { fireEvent, render, screen } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { JewelCaseControls } from "../case3d/JewelCaseExact";
import { Preview3D } from "./Preview3D";

const mocks = vi.hoisted(() => ({
  webgl: vi.fn(() => false),
  jewel: vi.fn((_props: Record<string, unknown>) => null as unknown),
  stage: vi.fn((_props: Record<string, unknown>) => null as unknown)
}));

vi.mock("../case3d", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../case3d")>()),
  canUseWebgl: mocks.webgl,
  JewelCaseExact: (props: Record<string, unknown>) => mocks.jewel(props),
  CaseStage: (props: Record<string, unknown>) => mocks.stage(props)
}));

const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
const art = [
  { slotId: "front", imageRef: "e2e/fixtures/art-front.png", transform },
  { slotId: "tray", imageRef: "e2e/fixtures/art-tray.png", transform },
  { slotId: "disc", imageRef: "e2e/fixtures/art-disc.png", transform }
];

describe("3D preview", () => {
  afterEach(() => {
    mocks.webgl.mockReset().mockReturnValue(false);
    mocks.jewel.mockReset().mockReturnValue(null);
    mocks.stage.mockReset().mockReturnValue(null);
    vi.restoreAllMocks();
  });

  it("wires assigned artwork to the right case surfaces", () => {
    render(<Preview3D formatId="jewelcase" art={art} />);

    const scene = screen.getByTestId("case-scene");
    expect(scene).toHaveAttribute("data-front", "e2e/fixtures/art-front.png");
    expect(scene).toHaveAttribute("data-back", "e2e/fixtures/art-tray.png");
    expect(scene).toHaveAttribute("data-disc", "e2e/fixtures/art-disc.png");
    expect(scene).toHaveAttribute("data-case-state", "closed");
    expect(scene).toHaveAttribute("data-open", "false");
    expect(scene).toHaveAttribute("data-ejected", "false");
  });

  it("shows the flat cover and a note when WebGL is unavailable", () => {
    render(<Preview3D formatId="dvdcase" art={art} />);
    expect(screen.getByTestId("case-front-cover")).toHaveAttribute("src", "e2e/fixtures/art-front.png");
    expect(screen.getByText("3D preview unavailable")).toHaveClass("canvas-fallback");
  });

  it("passes tray and disc art to the jewel case and draws no flat overlay over the 3D model", () => {
    mocks.webgl.mockReturnValue(true);
    render(<Preview3D formatId="jewelcase" art={art} />);
    expect(mocks.jewel).toHaveBeenCalledWith(
      expect.objectContaining({
        interactive: true,
        frontArtUrl: "e2e/fixtures/art-front.png",
        backArtUrl: "e2e/fixtures/art-tray.png",
        discArtUrl: "e2e/fixtures/art-disc.png"
      })
    );
    expect(screen.queryByTestId("case-front-cover")).not.toBeInTheDocument();
    expect(screen.queryByText("3D preview unavailable")).not.toBeInTheDocument();
  });

  it("keeps a failing 3D jewel case inside the panel and shows the 2D fallback", () => {
    expectCaughtRenderError();
    mocks.webgl.mockReturnValue(true);
    mocks.jewel.mockImplementation(() => {
      throw new Error("WebGL context could not be created");
    });
    render(<Preview3D formatId="jewelcase" art={art} />);
    expect(screen.getByTestId("case-front-cover")).toBeInTheDocument();
    expect(screen.getByText("3D preview unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
    // The keyboard affordances belong to the 3D case, so they leave with it.
    expect(screen.getByTestId("case-scene")).not.toHaveAttribute("tabindex");
    expect(screen.queryByTestId("preview-hint")).not.toBeInTheDocument();
  });

  it("keeps a failing non-jewel case (bad texture) inside the panel", () => {
    expectCaughtRenderError();
    mocks.webgl.mockReturnValue(true);
    mocks.stage.mockImplementation(() => {
      throw new Error("Could not load art-front.png");
    });
    render(<Preview3D formatId="cassette" art={art} />);
    expect(screen.getByTestId("case-front-cover")).toBeInTheDocument();
    expect(screen.getByText("3D preview unavailable")).toBeInTheDocument();
    // Rotate and Flip would do nothing over the flat fallback.
    expect(screen.queryByTestId("rotate-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("flip-booklet")).not.toBeInTheDocument();
  });

  it("offers only Rotate and Flip for non-jewel cases", () => {
    mocks.webgl.mockReturnValue(true);
    render(<Preview3D formatId="dvdcase" art={art} />);
    expect(screen.getByTestId("rotate-preview")).toHaveTextContent("Rotate");
    expect(screen.getByTestId("flip-booklet")).toHaveTextContent("Flip");
    expect(screen.queryByTestId("open-lid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spin-disc")).not.toBeInTheDocument();
    expect(screen.queryByTestId("case-front-cover")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-scene")).not.toHaveAttribute("tabindex");
  });

  it("opens and ejects the jewel case from the keyboard", () => {
    mocks.webgl.mockReturnValue(true);
    const controls: JewelCaseControls = { toggleOpen: vi.fn(), toggleEject: vi.fn() };
    mocks.jewel.mockImplementation((props) => {
      (props.controls as MutableRefObject<JewelCaseControls | null>).current = controls;
      return null;
    });
    render(<Preview3D formatId="jewelcase" art={art} />);
    const scene = screen.getByRole("group", { name: /Jewel case 3D preview/ });
    expect(scene).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("preview-hint")).toHaveTextContent("press Enter to open");
    fireEvent.keyDown(scene, { key: "Enter" });
    fireEvent.keyDown(scene, { key: " " });
    expect(controls.toggleOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(scene, { key: "e" });
    expect(controls.toggleEject).toHaveBeenCalledTimes(1);
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
