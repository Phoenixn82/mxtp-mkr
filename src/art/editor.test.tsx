import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { insertSpecs } from "../geometry";
import { impose } from "../geometry/imposition";
import { guideBoxOnMedia } from "../print/componentMap";
import { getDimension, type BoxDims } from "../print/dimensions";
import { PieceSchematic } from "./PieceSchematic";
import { SlotEditor } from "./SlotEditor";
import { clampToSafe, guidePixels, type SlotArt } from "./editor";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

describe("slot editor", () => {
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it("renders front-cover trim at screen dpi", () => {
    const guides = guidePixels({ x: 0, y: 0, w: 120, h: 120 }, 96);
    expect(guides.trim.w).toBeCloseTo(453.54, 2);
  });

  it("clamps transforms into the safe area", () => {
    expect(clampToSafe({ x: -2, y: 200, scale: 1, rotation: 0 }, { x: 3, y: 3, w: 10, h: 10 })).toMatchObject({
      x: 3,
      y: 13
    });
  });

  it("assigns fixture art to the selected slot only under the e2e invoke mock", async () => {
    window.__MXTP_INVOKE__ = async () => ({}) as never;
    const user = userEvent.setup();
    const changes: SlotArt[][] = [];
    render(<ControlledSlotEditor onArtChange={(art) => changes.push(art)} />);
    await user.click(screen.getByTestId("assign-art"));
    expect(screen.getByTestId("slot-stage")).toHaveAttribute("data-filled", "true");
    expect(changes[0][0].imageRef).toMatch(/e2e\/fixtures\/art-(front|tray|disc)\.png$/);
    expect(changes[0][0].imageRef).not.toContain("placeholder");
  });

  it("hides the fixture assign button outside the e2e invoke mock", () => {
    render(<SlotEditor onArtChange={() => undefined} />);
    expect(screen.queryByTestId("assign-art")).not.toBeInTheDocument();
  });

  it("assigns the researched cover to the selected slot", async () => {
    const user = userEvent.setup();
    const changes: SlotArt[][] = [];
    render(
      <ControlledSlotEditor
        onArtChange={(art) => changes.push(art)}
        researchedCover={{ imageRef: "C:/covers/discovery.png", previewRef: "http://localhost/discovery.png" }}
      />
    );
    await user.click(screen.getByTestId("use-researched-cover"));
    expect(screen.getByTestId("slot-stage")).toHaveAttribute("data-filled", "true");
    expect(changes[0][0]).toMatchObject({
      imageRef: "C:/covers/discovery.png",
      previewRef: "http://localhost/discovery.png"
    });
  });

  it("disables the researched-cover action until research produces a cover, with a visible reason", () => {
    render(<SlotEditor onArtChange={() => undefined} />);
    const button = screen.getByRole("button", { name: "Use album cover from Look up" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("title");
    const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent("Run Look up album to load the album's real cover.");
  });

  it("warns when a slot's image is too small for the tray and blocks a too-small album cover", async () => {
    stubImageSize(1600, 1600);
    render(
      <SlotEditor
        initialSelected="tray"
        art={[{ slotId: "tray", imageRef: "C:/covers/small.png", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }]}
        researchedCover={{ imageRef: "C:/covers/album.png", previewRef: "data:image/png;base64,AAAA" }}
        onArtChange={() => undefined}
      />
    );
    expect(await screen.findByTestId("slot-size-warning")).toHaveTextContent(
      /^Too small for this piece \(needs 18\d\d × 14\d\d px\)\.$/
    );
    const button = screen.getByRole("button", { name: "Use album cover from Look up" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent(
      "The album cover is 1600 × 1600 px, too small for this piece"
    );
  });

  it("shows no size warning for an image big enough for the tray", async () => {
    stubImageSize(3000, 3000);
    render(
      <SlotEditor
        initialSelected="tray"
        art={[{ slotId: "tray", imageRef: "C:/covers/big.png", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }]}
        researchedCover={{ imageRef: "C:/covers/album.png" }}
        onArtChange={() => undefined}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Use album cover from Look up" })).toBeEnabled());
    expect(screen.queryByTestId("slot-size-warning")).not.toBeInTheDocument();
  });

  it("Remove art empties the slot's image fields", async () => {
    const user = userEvent.setup();
    const changes: SlotArt[][] = [];
    render(
      <SlotEditor
        initialSelected="front"
        art={[
          {
            slotId: "front",
            imageRef: "C:/covers/front.png",
            previewRef: "data:image/png;base64,AAAA",
            imageSource: "research",
            transform: { x: 3, y: 3, scale: 1, rotation: 0 }
          }
        ]}
        onArtChange={(art) => changes.push(art)}
      />
    );
    await user.click(screen.getByRole("button", { name: "Remove art" }));
    expect(changes[0][0]).toMatchObject({ slotId: "front", transform: { x: 3, y: 3, scale: 1, rotation: 0 } });
    expect(changes[0][0].imageRef).toBeUndefined();
    expect(changes[0][0].previewRef).toBeUndefined();
    expect(changes[0][0].imageSource).toBeUndefined();
  });

  it("hides Remove art on an empty slot", () => {
    render(<SlotEditor onArtChange={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Remove art" })).not.toBeInTheDocument();
  });

  it("reads print size in inches with no mm and no template code", () => {
    render(<SlotEditor initialSelected="disc" onArtChange={() => undefined} />);
    const readout = screen.getByTestId("guide-readout").textContent!;
    expect(readout).toMatch(/^Print size [\d.]+ × [\d.]+ in · with bleed [\d.]+ × [\d.]+ in$/);
    expect(readout).not.toMatch(/mm|UD100|CD\d/);
    expect(screen.getByTestId("print-spec-readout").textContent).not.toMatch(/mm|UD100|CD\d/);
  });

  it("offers only the printable booklet sizes as insert types", () => {
    render(<SlotEditor onArtChange={() => undefined} />);
    const ids = Array.from((screen.getByTestId("insert-select") as HTMLSelectElement).options).map((option) => option.value);
    expect(ids.filter((id) => id.startsWith("saddle-"))).toEqual(["saddle-8", "saddle-12", "saddle-16", "saddle-20", "saddle-24"]);
  });

  it("shows a visible error when the picked file cannot be copied into the project", async () => {
    vi.mocked(open).mockResolvedValue("/home/user/gone.png");
    window.__MXTP_INVOKE__ = async () => {
      throw new Error("Could not read /home/user/gone.png");
    };
    const user = userEvent.setup();
    const changes: SlotArt[][] = [];
    render(<SlotEditor onArtChange={(art) => changes.push(art)} />);
    await user.click(screen.getByTestId("pick-image"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't add that image: Could not read /home/user/gone.png");
    expect(changes).toEqual([]);
  });

  it("copies a picked file into the project and stores the copy's path", async () => {
    vi.mocked(open).mockResolvedValue("C:/pics/custom-front.png");
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return "/data/projects/p1/covers/picked/custom-front.png" as never;
    };
    const user = userEvent.setup();
    const changes: SlotArt[][] = [];
    render(<ControlledSlotEditor onArtChange={(art) => changes.push(art)} />);
    await user.click(screen.getByRole("button", { name: "Choose image…" }));
    await waitFor(() => expect(changes.length).toBeGreaterThan(0));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] })
    );
    expect(calls).toEqual([{ command: "copy_art_file", args: { path: "C:/pics/custom-front.png" } }]);
    expect(changes[0][0].imageRef).toBe("/data/projects/p1/covers/picked/custom-front.png");
    expect(screen.getByTestId("slot-stage")).toHaveAttribute("data-filled", "true");
  });

  it("renders registry-true print guide geometry for the front insert", () => {
    const spec = insertSpecs().find((item) => item.id === "front")!;
    const dimension = getDimension("CD100")!;
    render(<PieceSchematic spec={spec} />);

    expect(Number(screen.getByTestId("print-guide-media").getAttribute("data-w-in"))).toBeCloseTo(
      dimension.media!.in.w,
      4
    );
    expectGuide("print-guide-bleed", dimension.media!, dimension.bleed!);
    expectGuide("print-guide-trim", dimension.media!, dimension.trim!);
    expectGuide("print-guide-safety", dimension.media!, dimension.safety!);
    expect(screen.getByTestId("print-spec-readout")).toHaveTextContent("Image at least 1500 × 1500 px (300 dpi)");
  });

  it("renders registry fold guides for the tray card", () => {
    const spec = insertSpecs().find((item) => item.id === "tray")!;
    const dimension = getDimension("CDT100")!;
    render(<PieceSchematic spec={spec} />);

    const folds = screen.getAllByTestId("print-guide-fold").map((fold) => Number(fold.getAttribute("data-x-in")));
    expect(folds).toHaveLength(dimension.foldLines.length);
    folds.forEach((fold, index) => expect(Math.abs(fold - dimension.foldLines[index])).toBeLessThanOrEqual(0.01));
  });

  it("previews impose(N) for the piece's own page count, with no page-count control of its own", () => {
    const spec = insertSpecs().find((item) => item.id === "saddle-16")!;
    const lyricText = Array.from({ length: 84 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<PieceSchematic spec={spec} lyricText={lyricText} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const rowValues = screen.getAllByTestId("imposition-row").map((row) => {
      const cells = within(row).getAllByRole("cell");
      return {
        sheet: Number(cells[0].textContent) - 1,
        face: cells[1].textContent,
        left: Number(cells[2].textContent),
        right: Number(cells[3].textContent)
      };
    });
    expect(rowValues).toEqual(impose(16));
    expect(screen.getByText("16-page booklet · 4 print sheets")).toBeInTheDocument();
  });

  it("names the piece, not a template code, when no image is assigned", () => {
    const spec = insertSpecs().find((item) => item.id === "front")!;
    render(<PieceSchematic spec={spec} />);
    expect(screen.getByTestId("print-guide-media")).toHaveTextContent("Front insert");
    expect(screen.getByTestId("print-guide-media")).not.toHaveTextContent(/CD100/);
  });
});

function ControlledSlotEditor(props: Omit<React.ComponentProps<typeof SlotEditor>, "art">) {
  const [art, setArt] = useState<SlotArt[]>([]);
  return (
    <SlotEditor
      {...props}
      art={art}
      onArtChange={(updates) => {
        setArt((current) => {
          const slots = new Map(current.map((item) => [item.slotId, item]));
          updates.forEach((item) => slots.set(item.slotId, item));
          return [...slots.values()];
        });
        props.onArtChange(updates);
      }}
    />
  );
}

function expectGuide(testId: string, media: BoxDims, box: BoxDims) {
  const expected = guideBoxOnMedia(media, box);
  const element = screen.getByTestId(testId);
  expect(Math.abs(Number(element.getAttribute("data-x-in")) - expected.x)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(Number(element.getAttribute("data-y-in")) - expected.y)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(Number(element.getAttribute("data-w-in")) - expected.w)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(Number(element.getAttribute("data-h-in")) - expected.h)).toBeLessThanOrEqual(0.01);
}

/** jsdom never decodes images: report a fixed natural size on load. */
function stubImageSize(width: number, height: number) {
  class SizedImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", SizedImage);
}
