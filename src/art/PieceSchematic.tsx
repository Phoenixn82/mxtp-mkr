import { useMemo } from "react";
import type { InsertSpec } from "../geometry";
import {
  componentForInsertSpec,
  guideBoxOnMedia,
  guideStyle,
  impositionPreviewRows,
  printTarget
} from "../print/componentMap";
import type { BoxDims, ComponentDim } from "../print/dimensions";
import { resolveArtSrc, type SlotArt } from "./editor";

interface PieceSchematicProps {
  spec: InsertSpec;
  art?: SlotArt;
  lyricText?: string;
}

type GuideKind = "bleed" | "trim" | "safety";

function coverImage(art?: SlotArt): string | undefined {
  const ref = art?.imageRef;
  if (!ref || !/\.(png|jpe?g)$/i.test(ref)) {
    return undefined;
  }
  return resolveArtSrc(art);
}

/**
 * The page count is chosen once, in the Booklet panel; this schematic only
 * shows the piece it is given. `lyricText` is accepted for compatibility.
 */
export function PieceSchematic({ spec, art }: PieceSchematicProps) {
  const cover = coverImage(art);
  const component = componentForInsertSpec(spec);
  const impositionRows = useMemo(
    () => (spec.binding === "saddle" ? impositionPreviewRows(spec.pages) : []),
    [spec.pages, spec.binding]
  );

  return (
    <figure className="piece" data-testid="piece-schematic" data-kind={pieceKind(spec)}>
      <PrintDimensionGuide component={component} cover={cover} label={spec.label} />
      {renderPhysicalPiece(spec, cover)}
      <PrintSpecReadout spec={spec} />
      <BookletPrintControls spec={spec} rows={impositionRows} />
      <figcaption className="piece-caption">{captionForSpec(spec)}</figcaption>
    </figure>
  );
}

function PrintDimensionGuide({ component, cover, label }: { component?: ComponentDim; cover?: string; label: string }) {
  if (!hasGuideGeometry(component)) {
    return (
      <div className="print-guide print-guide--empty" data-testid="print-guide-empty">
        No print template for this piece.
      </div>
    );
  }

  const media = component.media;
  const guides: Array<{ kind: GuideKind; box: BoxDims }> = [
    { kind: "bleed", box: component.bleed },
    { kind: "trim", box: component.trim },
    { kind: "safety", box: component.safety }
  ];

  return (
    <div
      className="print-guide"
      data-testid="print-guide-media"
      data-component-id={component.id}
      data-w-in={media.in.w}
      data-h-in={media.in.h}
      style={{ aspectRatio: `${media.in.w} / ${media.in.h}` }}
    >
      <div className="print-guide-art">{cover ? <img src={cover} alt="" /> : <span>{label}</span>}</div>
      {guides.map(({ kind, box }) => {
        const guide = guideBoxOnMedia(media, box);
        return (
          <span
            key={kind}
            className={`print-guide-box print-guide-box--${kind}`}
            data-testid={`print-guide-${kind}`}
            data-x-in={guide.x}
            data-y-in={guide.y}
            data-w-in={guide.w}
            data-h-in={guide.h}
            style={guideStyle(media, guide)}
          />
        );
      })}
      {component.foldLines.map((line) => (
        <span
          key={line}
          className="print-guide-fold"
          data-testid="print-guide-fold"
          data-x-in={line}
          style={{ left: `${(line / media.in.w) * 100}%` }}
        />
      ))}
    </div>
  );
}

function PrintSpecReadout({ spec }: { spec: InsertSpec }) {
  const { px } = printTarget(spec);
  return (
    <p className="print-spec-readout" data-testid="print-spec-readout">
      Image at least {px.w} × {px.h} px (300 dpi)
    </p>
  );
}

function BookletPrintControls({ spec, rows }: { spec: InsertSpec; rows: ReturnType<typeof impositionPreviewRows> }) {
  if (spec.binding !== "saddle") {
    return null;
  }

  return (
    <div className="booklet-print-controls" data-testid="booklet-page-control" data-pages={spec.pages}>
      <table className="imposition-preview" data-testid="imposition-preview">
        <caption>
          How {spec.pages} pages print on {spec.pages / 4} {spec.pages === 4 ? "sheet" : "sheets"}
        </caption>
        <thead>
          <tr>
            <th>sheet</th>
            <th>face</th>
            <th>left</th>
            <th>right</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sheet}-${row.face}`} data-testid="imposition-row">
              <td>{row.sheet + 1}</td>
              <td>{row.face}</td>
              <td>{row.left}</td>
              <td>{row.right}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderPhysicalPiece(spec: InsertSpec, cover?: string) {
  if (spec.id === "disc") {
    return (
      <div className="disc-face">
        {cover ? <img src={cover} alt="" /> : null}
        <span className="disc-ring" />
        <span className="disc-hole" />
      </div>
    );
  }

  if (spec.id === "tray") {
    return (
      <div className="tray-card">
        <span className="tray-flap" title="Spine flap" />
        <div className="tray-main">{cover ? <img src={cover} alt="" /> : <span>Tray back</span>}</div>
        <span className="tray-flap" title="Spine flap" />
      </div>
    );
  }

  if (spec.binding === "saddle") {
    const pages = Array.from({ length: spec.pages }, (_, index) => index + 1);
    return (
      <div className="booklet-pages">
        {pages.map((page) => (
          <div key={page} className={page === 1 ? "page page--cover" : "page"}>
            {page === 1 && cover ? <img src={cover} alt="" /> : <span className="page-num">{page}</span>}
          </div>
        ))}
      </div>
    );
  }

  const panelCount = Math.max(1, Math.round(spec.pages / 2));
  const panels = Array.from({ length: panelCount }, (_, index) => index);
  return (
    <div className="fold-panels">
      {panels.map((index) => (
        <div key={index} className={index === 0 ? "fold-panel fold-panel--cover" : "fold-panel"}>
          {index === 0 && cover ? <img src={cover} alt="" /> : <span>{index === 0 ? "Front" : `P${index + 1}`}</span>}
        </div>
      ))}
    </div>
  );
}

function captionForSpec(spec: InsertSpec): string {
  if (spec.id === "disc") {
    return "Disc face";
  }
  if (spec.id === "tray") {
    return "Tray card with 2 spine flaps";
  }
  if (spec.binding === "saddle") {
    const sheets = spec.pages / 4;
    return `${spec.pages}-page booklet · ${sheets} ${sheets === 1 ? "print sheet" : "print sheets"}`;
  }
  const panelCount = Math.max(1, Math.round(spec.pages / 2));
  return panelCount === 1 ? "Single panel" : `${panelCount} panels, folds to one CD panel`;
}

function pieceKind(spec: InsertSpec): string {
  if (spec.id === "disc") return "disc";
  if (spec.id === "tray") return "tray";
  if (spec.binding === "saddle") return "booklet";
  return "fold";
}

function hasGuideGeometry(component?: ComponentDim): component is ComponentDim & {
  media: BoxDims;
  bleed: BoxDims;
  trim: BoxDims;
  safety: BoxDims;
} {
  return Boolean(component?.machineReadable && component.media && component.bleed && component.trim && component.safety);
}
