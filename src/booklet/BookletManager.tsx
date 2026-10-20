import { useState, type ReactNode } from "react";
import { PRINTABLE_BOOKLET_PAGE_COUNTS } from "./bookletExport";
import { bookletComponentId, type ExportBookletResult } from "./exportBooklet";

interface BookletManagerProps {
  pages: number;
  onPagesChange: (pages: number) => void;
  onExport?: () => Promise<ExportBookletResult>;
  /** Live page-layout preview (rendered between the page count and export). */
  preview?: ReactNode;
  validationError?: string;
  recommendedPages?: number;
}

type ExportTone = "saved" | "cancelled" | "failed";

/**
 * The one place the booklet page count is chosen: saddle-stitched booklets in
 * the printable counts only. Fold inserts are separate Artwork pieces.
 */
export function BookletManager({
  pages,
  onPagesChange,
  onExport,
  preview,
  validationError,
  recommendedPages
}: BookletManagerProps) {
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportTone, setExportTone] = useState<ExportTone>("saved");
  const noTemplate = !bookletComponentId(pages);
  // The validation alert already explains itself; a page count without a print
  // template gets its own visible reason next to the export button.
  const exportReasonId = validationError ? "booklet-validation-text" : noTemplate ? "booklet-export-reason" : undefined;

  async function exportPdf() {
    if (!onExport) {
      return;
    }
    setExporting(true);
    setExportTone("saved");
    setExportMessage("Exporting booklet PDF…");
    const result = await onExport();
    if (result.ok) {
      setExportTone("saved");
      setExportMessage(`Saved ${result.path}`);
    } else if (result.cancelled) {
      setExportTone("cancelled");
      setExportMessage("Export cancelled.");
    } else {
      setExportTone("failed");
      setExportMessage(`Export failed: ${result.error}`);
    }
    setExporting(false);
  }

  return (
    <section className="panel" aria-labelledby="booklet-heading">
      <div className="panel-head">
        <h2 id="booklet-heading">Booklet</h2>
        <output data-testid="booklet-pages">{pages} pages</output>
      </div>
      <div className="layout-options" data-testid="layout-options" role="group" aria-label="Booklet pages">
        {PRINTABLE_BOOKLET_PAGE_COUNTS.map((count) => (
          <button
            key={count}
            type="button"
            className={count === pages ? "active" : ""}
            onClick={() => onPagesChange(count)}
            aria-pressed={count === pages}
            aria-label={`${count} pages, ${count / 4} print sheets`}
          >
            <strong>{count}</strong>
            <span>pages</span>
            <small>{count / 4} print sheets</small>
          </button>
        ))}
      </div>
      {validationError ? (
        <div className="booklet-validation" role="alert" data-testid="booklet-validation">
          <span id="booklet-validation-text">{validationError}</span>
          {recommendedPages && (PRINTABLE_BOOKLET_PAGE_COUNTS as readonly number[]).includes(recommendedPages) ? (
            <button type="button" onClick={() => onPagesChange(recommendedPages)}>
              Use {recommendedPages} pages
            </button>
          ) : null}
        </div>
      ) : null}
      {preview}
      <button
        type="button"
        onClick={() => void exportPdf()}
        disabled={!onExport || exporting || Boolean(validationError) || noTemplate}
        aria-describedby={exportReasonId}
        data-testid="export-booklet"
      >
        {exporting ? "Exporting…" : "Export booklet PDF"}
      </button>
      {!validationError && noTemplate ? (
        <p className="panel-message" id="booklet-export-reason" data-testid="booklet-export-reason">
          No print template for {pages} pages. Choose a page count above.
        </p>
      ) : null}
      {exportMessage ? (
        <p
          className={exportTone === "failed" ? "error" : "panel-message"}
          role="status"
          aria-live="polite"
          data-testid="export-message"
        >
          {exportMessage}
        </p>
      ) : null}
    </section>
  );
}
