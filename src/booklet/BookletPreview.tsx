import type { CSSProperties } from "react";
import type { ComposedBooklet } from "./bookletExport";

interface BookletPreviewProps {
  composed: ComposedBooklet;
  /** Data URI of the researched/generated front cover, shown on page 1. */
  coverPreviewUrl?: string;
  /** Palette derived from the cover art — accents the preview chrome. */
  palette?: string[];
}

/**
 * In-app booklet preview: the same reader-order pages the PDF renders, drawn
 * as page thumbnails. Text blocks are positioned by their real pagination
 * geometry (inches within the page safety box), and text pages carry the
 * cover art as the same washed background the print output uses (the same
 * rule as mapPage: every non-cover page with text, plus art plates).
 */
export function BookletPreview({ composed, coverPreviewUrl, palette }: BookletPreviewProps) {
  return (
    <div
      className="booklet-preview"
      role="group"
      data-testid="booklet-preview"
      data-design={composed.design.id}
      aria-label={`${composed.design.label} ${composed.pageCount}-page booklet preview`}
    >
      {composed.pages.map((page) => {
        const visual = page.visual!;
        const isCover = page.kind === "cover";
        const isArtPlate = page.kind === "art";
        // Spare and art-plate pages print with no words on them.
        const wordless = page.kind === "blank" || isArtPlate;
        const washed = Boolean(coverPreviewUrl) && !isCover && ((page.blocks?.length ?? 0) > 0 || isArtPlate);
        const faceStyle = {
          "--bp-paper": visual.colors.paper,
          "--bp-ink": visual.colors.ink,
          "--bp-accent": palette?.[0] ?? visual.colors.accent,
          "--bp-highlight": visual.colors.highlight,
          "--bp-muted": visual.colors.muted,
          "--bp-wash": String(isArtPlate ? Math.min(0.38, visual.washOpacity * 2.6) : visual.washOpacity)
        } as CSSProperties;
        return (
          <figure
            key={page.pageNumber}
            className={`bp-page bp-kind-${page.kind ?? "blank"}`}
            data-testid={`bp-page-${page.pageNumber}`}
            data-kind={page.kind}
            data-layout={visual.layout}
          >
            <div className={`bp-face bp-motif-${visual.motif}`} style={faceStyle}>
              <span className="bp-motif" aria-hidden="true" />
              {isCover && coverPreviewUrl ? (
                <img className="bp-cover" src={coverPreviewUrl} alt="Front cover artwork" />
              ) : null}
              {washed ? <img className="bp-bg" src={coverPreviewUrl} alt="" aria-hidden="true" /> : null}
              {!isCover && !wordless ? (
                <header className="bp-editorial-head">
                  <span className="bp-eyebrow">
                    {visual.eyebrow}
                    {page.partCount && page.partCount > 1 ? ` / ${page.part} OF ${page.partCount}` : ""}
                  </span>
                  {page.title ? <strong>{page.title}</strong> : null}
                </header>
              ) : !coverPreviewUrl ? (
                <div className="bp-cover-type">
                  <span>{visual.designLabel}</span>
                  <strong>{page.title}</strong>
                  <small>{page.subtitle}</small>
                </div>
              ) : null}
              {!isCover
                ? (page.blocks ?? []).map((block, index) => (
                    <div
                      key={index}
                      className="bp-block"
                      title={block.text}
                      style={{
                        left: `${(block.xIn / composed.safety.wIn) * 100}%`,
                        top: `${(block.yIn / composed.safety.hIn) * 100}%`,
                        width: `${(block.wIn / composed.safety.wIn) * 100}%`,
                        height: `${(block.hIn / composed.safety.hIn) * 100}%`,
                        columnCount: block.columns,
                        columnGap: block.columns === 2 ? "5px" : undefined,
                        fontSize: block.fontSizePt ? `${Math.max(2.2, (block.fontSizePt / 8.25) * 3.5)}px` : undefined,
                        lineHeight:
                          block.fontSizePt && block.leadingPt ? String(block.leadingPt / block.fontSizePt) : undefined,
                        whiteSpace: "pre-line"
                      }}
                    >
                      {block.text}
                    </div>
                  ))
                : null}
              {!isCover && !wordless ? (
                <span className="bp-folio">
                  {visual.folio} / {visual.designLabel}
                </span>
              ) : null}
            </div>
            <figcaption className="bp-caption" title={page.title}>
              <span className="bp-num">{visual.folio}</span>
              {page.title || "Spare page"}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
