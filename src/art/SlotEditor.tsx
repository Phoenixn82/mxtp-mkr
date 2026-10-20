import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PRINTABLE_BOOKLET_PAGE_COUNTS } from "../booklet/bookletExport";
import { boxes, insertSpecs } from "../geometry";
import { printSizeText, printTarget } from "../print/componentMap";
import { invokeCommand } from "../tauriClient";
import { resolveArtSrc, type SlotArt } from "./editor";
import { PieceSchematic } from "./PieceSchematic";

interface SlotEditorProps {
  art?: SlotArt[];
  /** Emits only changed slots; the owner merges them into canonical project state. */
  onArtChange: (art: SlotArt[]) => void;
  initialSelected?: string;
  /** Front cover produced by album research, assignable to any slot. */
  researchedCover?: { imageRef: string; previewRef?: string };
}

export function SlotEditor({ art = [], onArtChange, initialSelected, researchedCover }: SlotEditorProps) {
  // Saddle booklets only in the counts that have a print template (8 to 24).
  const specs = useMemo(
    () =>
      insertSpecs().filter(
        (item) =>
          item.binding !== "saddle" || (PRINTABLE_BOOKLET_PAGE_COUNTS as readonly number[]).includes(item.pages)
      ),
    []
  );
  const [selected, setSelected] = useState(() =>
    specs.some((item) => item.id === initialSelected) ? initialSelected! : specs[0].id
  );
  const assigned = useMemo(() => Object.fromEntries(art.map((item) => [item.slotId, item])), [art]);
  const spec = specs.find((item) => item.id === selected) ?? specs[0];
  const target = printTarget(spec);
  const boxSet = boxes(spec.sheetFlat);
  const current = assigned[selected];
  const hasImage = Boolean(current?.imageRef || current?.previewRef);
  const filled = hasImage || Boolean(current?.textContent);
  const [pickError, setPickError] = useState("");
  // Natural sizes come from the full image, never the preview thumbnail.
  const slotSize = useNaturalSize(current?.imageRef ? resolveArtSrc({ imageRef: current.imageRef }) : undefined);
  const coverSize = useNaturalSize(
    researchedCover?.imageRef ? resolveArtSrc({ imageRef: researchedCover.imageRef }) : undefined
  );
  const tooSmall = (size?: NaturalSize) => Boolean(size && (size.w < target.px.w || size.h < target.px.h));
  const needs = `${target.px.w} × ${target.px.h} px`;
  const coverReason = !researchedCover
    ? "Run Look up album to load the album's real cover."
    : tooSmall(coverSize)
      ? `The album cover is ${coverSize!.w} × ${coverSize!.h} px, too small for this piece (needs ${needs}).`
      : "";
  // Deterministic fixture stamping exists only for tests: the vitest invoke
  // mock, or the real-shell e2e harness (which sets __MXTP_MKR_E2E__ because
  // it uses the real Tauri invoke and can't drive a native file picker).
  const mockMode =
    typeof window !== "undefined" && Boolean(window.__MXTP_INVOKE__ || window.__MXTP_MKR_E2E__);

  function assignRef(imageRef: string, previewRef?: string) {
    onArtChange([
      {
        slotId: selected,
        imageRef,
        previewRef,
        imageSource: "manual",
        transform: { x: boxSet.safe.x, y: boxSet.safe.y, scale: 1, rotation: 0 }
      }
    ]);
  }

  function assignArt() {
    assignRef(fixtureForSlot(selected));
  }

  function useResearchedCover() {
    if (researchedCover) {
      assignRef(researchedCover.imageRef, researchedCover.previewRef);
    }
  }

  function removeArt() {
    onArtChange([
      {
        ...current,
        slotId: selected,
        imageRef: undefined,
        previewRef: undefined,
        imageSource: undefined,
        transform: current?.transform ?? { x: boxSet.safe.x, y: boxSet.safe.y, scale: 1, rotation: 0 }
      }
    ]);
  }

  async function pickImage() {
    setPickError("");
    try {
      const chosen = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }]
      });
      const path = Array.isArray(chosen) ? chosen[0] : chosen;
      if (!path) {
        return;
      }
      // The project keeps its own copy, so the art survives the original file moving.
      assignRef(await invokeCommand<string>("copy_art_file", { path }));
    } catch (error) {
      setPickError(`Couldn't add that image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <section className="panel" aria-labelledby="art-heading">
      <div className="panel-head">
        <h2 id="art-heading">Artwork</h2>
        <select
          aria-label="Insert type"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setPickError("");
          }}
          data-testid="insert-select"
        >
          {specs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="slot-stage" data-testid="slot-stage" data-filled={filled ? "true" : "false"}>
        <PieceSchematic spec={spec} art={assigned[selected]} />
      </div>
      <div className="guide-readout" data-testid="guide-readout">
        {printSizeText(target)}
      </div>
      {hasImage && tooSmall(slotSize) ? (
        <p className="slot-size-warning" role="status" data-testid="slot-size-warning">
          Too small for this piece (needs {needs}).
        </p>
      ) : null}
      <div className="slot-actions">
        <button
          type="button"
          onClick={useResearchedCover}
          disabled={Boolean(coverReason)}
          aria-describedby={coverReason ? "use-researched-cover-reason" : undefined}
          data-testid="use-researched-cover"
        >
          Use album cover from Look up
        </button>
        <button type="button" onClick={() => void pickImage()} data-testid="pick-image">
          Choose image…
        </button>
        {hasImage ? (
          <button type="button" onClick={removeArt} data-testid="remove-art">
            Remove art
          </button>
        ) : null}
        {mockMode ? (
          <button type="button" onClick={assignArt} data-testid="assign-art">
            Assign art
          </button>
        ) : null}
      </div>
      {coverReason ? (
        <p className="panel-message" id="use-researched-cover-reason" data-testid="use-researched-cover-reason">
          {coverReason}
        </p>
      ) : null}
      {pickError ? (
        <p className="error" role="alert" data-testid="pick-image-error">
          {pickError}
        </p>
      ) : null}
    </section>
  );
}

interface NaturalSize {
  src: string;
  w: number;
  h: number;
}

/** The pixel size of an image, once it loads. Unknown (undefined) never warns. */
function useNaturalSize(src?: string): NaturalSize | undefined {
  const [size, setSize] = useState<NaturalSize>();
  useEffect(() => {
    if (!src) {
      return;
    }
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live && image.naturalWidth > 0) {
        setSize({ src, w: image.naturalWidth, h: image.naturalHeight });
      }
    };
    image.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return size?.src === src ? size : undefined;
}

function fixtureForSlot(slotId: string): string {
  if (slotId === "tray") {
    return "e2e/fixtures/art-tray.png";
  }
  if (slotId === "disc") {
    return "e2e/fixtures/art-disc.png";
  }
  return "e2e/fixtures/art-front.png";
}
