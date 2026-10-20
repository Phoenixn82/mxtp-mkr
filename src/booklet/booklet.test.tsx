import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BookletManager } from "./BookletManager";
import { canUsePageCount, nextPageCount } from "./booklet";
import type { ExportBookletResult } from "./exportBooklet";

interface HarnessProps {
  initialPages?: number;
  onExport?: () => Promise<ExportBookletResult>;
  onPages?: (pages: number) => void;
  validationError?: string;
  recommendedPages?: number;
}

function Harness({ initialPages = 16, onExport, onPages, validationError, recommendedPages }: HarnessProps) {
  const [pages, setPages] = useState(initialPages);
  return (
    <>
      <BookletManager
        pages={pages}
        onPagesChange={(next) => {
          setPages(next);
          onPages?.(next);
        }}
        onExport={onExport}
        validationError={validationError}
        recommendedPages={recommendedPages}
      />
      <output data-testid="parent-pages">{pages}</output>
    </>
  );
}

describe("booklet rules", () => {
  it("does not allow 10 saddle pages", () => {
    expect(canUsePageCount("saddle", 10)).toBe(false);
    expect(nextPageCount("saddle", 8, 1)).toBe(12);
  });

  it("offers only the printable saddle counts as one segmented control", () => {
    render(<Harness initialPages={16} />);
    const group = screen.getByRole("group", { name: "Booklet pages" });
    expect(group).toHaveAttribute("data-testid", "layout-options");
    expect(group).toHaveClass("layout-options");
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.querySelector("strong")?.textContent)).toEqual(["8", "12", "16", "20", "24"]);
    expect(buttons[2]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[2]).toHaveTextContent("16pages4 print sheets");
    expect(buttons[2]).toHaveAccessibleName("16 pages, 4 print sheets");
    // The old binding select, stepper and raw "Valid:" line are gone.
    expect(screen.queryByLabelText("Booklet binding")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("valid-counts")).not.toBeInTheDocument();
  });

  it("propagates the selected page count to the owner", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    render(<Harness initialPages={16} onPages={(pages) => seen.push(pages)} />);
    const group = screen.getByRole("group", { name: "Booklet pages" });
    await user.click(within(group).getByRole("button", { name: /^12/ }));
    await user.click(within(group).getByRole("button", { name: /^8/ }));
    expect(screen.getByTestId("booklet-pages")).toHaveTextContent("8 pages");
    expect(screen.getByTestId("parent-pages")).toHaveTextContent("8");
    expect(seen).toEqual([12, 8]);
    expect(within(group).getByRole("button", { name: /^8/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains a page count with no print template next to the disabled export", () => {
    render(<Harness initialPages={2} onExport={() => Promise.resolve({ ok: true, path: "x" })} />);
    const button = screen.getByTestId("export-booklet");
    expect(button).toBeDisabled();
    const reason = screen.getByTestId("booklet-export-reason");
    expect(reason).toHaveTextContent("No print template for 2 pages. Choose a page count above.");
    expect(button).toHaveAttribute("aria-describedby", reason.id);
    expect(button).not.toHaveAttribute("title");
  });

  it("enables export on a printable count", () => {
    render(<Harness initialPages={8} onExport={() => Promise.resolve({ ok: true, path: "x" })} />);
    expect(screen.getByTestId("export-booklet")).toBeEnabled();
    expect(screen.queryByTestId("booklet-export-reason")).not.toBeInTheDocument();
  });

  it("blocks export on overflow and applies the recommended real template", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialPages={8}
        onExport={() => Promise.resolve({ ok: true })}
        validationError="Your lyrics need 11 pages; this booklet has 8. Choose 12 pages."
        recommendedPages={12}
      />
    );
    expect(screen.getByTestId("booklet-validation")).toHaveTextContent("Your lyrics need 11 pages");
    expect(screen.getByTestId("export-booklet")).toBeDisabled();
    expect(screen.getByTestId("export-booklet")).toHaveAttribute("aria-describedby", "booklet-validation-text");
    await user.click(screen.getByRole("button", { name: "Use 12 pages" }));
    expect(screen.getByTestId("parent-pages")).toHaveTextContent("12");
  });

  it("shows the saved path after a successful export", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn<() => Promise<ExportBookletResult>>().mockResolvedValue({
      ok: true,
      path: "C:/out/booklet-CD1600R.pdf"
    });
    render(<Harness initialPages={16} onExport={onExport} />);
    await user.click(screen.getByTestId("export-booklet"));
    await waitFor(() =>
      expect(screen.getByTestId("export-message")).toHaveTextContent("Saved C:/out/booklet-CD1600R.pdf")
    );
    expect(screen.getByTestId("export-message")).toHaveAttribute("role", "status");
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("shows the export failure inline instead of staying silent", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn<() => Promise<ExportBookletResult>>().mockResolvedValue({
      ok: false,
      error: "disk full"
    });
    render(<Harness initialPages={16} onExport={onExport} />);
    await user.click(screen.getByTestId("export-booklet"));
    await waitFor(() => expect(screen.getByTestId("export-message")).toHaveTextContent("Export failed: disk full"));
    expect(screen.getByTestId("export-message")).toHaveClass("error");
  });

  it("shows a cancelled save dialog as a neutral note, not an error", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn<() => Promise<ExportBookletResult>>().mockResolvedValue({ ok: false, cancelled: true });
    render(<Harness initialPages={16} onExport={onExport} />);
    await user.click(screen.getByTestId("export-booklet"));
    await waitFor(() => expect(screen.getByTestId("export-message")).toHaveTextContent("Export cancelled."));
    expect(screen.getByTestId("export-message")).toHaveClass("panel-message");
    expect(screen.getByTestId("export-message")).not.toHaveClass("error");
    expect(screen.getByTestId("export-message")).not.toHaveTextContent("failed");
  });
});
