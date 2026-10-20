import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { composeBookletPages } from "./bookletExport";
import { BookletPreview } from "./BookletPreview";

function booklet() {
  return composeBookletPages({
    componentId: "CD1600R",
    tracks: [{ title: "Glass Current" }],
    lyricsByTrack: [{ title: "Glass Current", lyrics: "Blue light on the water\nA signal in the tide" }],
    design: {
      artist: "Nova Memory",
      album: "Soft Circuit",
      year: 2001,
      tags: ["electronic"],
      palette: ["#06182b", "#35d7ff", "#b7ff63"]
    }
  });
}

describe("BookletPreview", () => {
  it("renders the same semantic pages and album-derived design as the print composition", () => {
    const composed = booklet();
    render(<BookletPreview composed={composed} coverPreviewUrl="data:image/png;base64,cover" />);

    const preview = screen.getByTestId("booklet-preview");
    expect(preview).toHaveAttribute("data-design", "liquid-chrome");
    expect(preview).toHaveAttribute("aria-label", "Liquid chrome 16-page booklet preview");
    expect(screen.getAllByRole("figure")).toHaveLength(16);

    const cover = screen.getByTestId("bp-page-1");
    expect(cover).toHaveAttribute("data-kind", "cover");
    expect(cover).toHaveAttribute("data-layout", "cover");
    expect(within(cover).getByAltText("Front cover artwork")).toBeInTheDocument();

    const lyrics = composed.pages.find((page) => page.kind === "lyrics")!;
    const lyricFigure = screen.getByTestId(`bp-page-${lyrics.pageNumber}`);
    expect(lyricFigure).toHaveAttribute("data-layout", "number-rail");
    expect(within(lyricFigure).getByText("TRACK 01")).toBeInTheDocument();
    expect(within(lyricFigure).getByText(/Blue light on the water/)).toBeInTheDocument();
    expect(within(lyricFigure).getByText(/LIQUID CHROME/i)).toBeInTheDocument();
  });

  it("renders a designed typographic cover when no raster artwork exists", () => {
    const composed = booklet();
    render(<BookletPreview composed={composed} />);

    const cover = screen.getByTestId("bp-page-1");
    expect(within(cover).getAllByText("Soft Circuit")).toHaveLength(2);
    expect(within(cover).getByText("Nova Memory")).toBeInTheDocument();
    expect(within(cover).queryByRole("img")).not.toBeInTheDocument();
    expect(cover.querySelector(".bp-face")).toHaveStyle({ "--bp-paper": composed.design.colors.paper });
  });

  it("washes text pages with the cover like the PDF does, even without cover bytes", () => {
    const composed = booklet();
    expect(composed.pages.every((page) => !page.backgroundImageBytes)).toBe(true);
    render(<BookletPreview composed={composed} coverPreviewUrl="data:image/png;base64,cover" />);

    const tracklist = screen.getByTestId("bp-page-2");
    expect(tracklist).toHaveAttribute("data-kind", "tracklist");
    expect(tracklist.querySelector("img.bp-bg")).toHaveAttribute("src", "data:image/png;base64,cover");
    // The cover page shows the art itself, never a wash.
    expect(screen.getByTestId("bp-page-1").querySelector("img.bp-bg")).toBeNull();
  });

  it("is a labelled group, and spare pages carry no words", () => {
    const composed = booklet();
    render(<BookletPreview composed={composed} coverPreviewUrl="data:image/png;base64,cover" />);

    expect(screen.getByRole("group", { name: "Liquid chrome 16-page booklet preview" })).toBeInTheDocument();
    const spare = composed.pages.find((page) => page.kind === "blank")!;
    const figure = screen.getByTestId(`bp-page-${spare.pageNumber}`);
    expect(figure.querySelector(".bp-editorial-head")).toBeNull();
    expect(figure.querySelector(".bp-folio")).toBeNull();
    expect(within(figure).getByText("Spare page")).toHaveClass("bp-caption");
    expect(screen.queryByText(/^blank$/i)).not.toBeInTheDocument();
  });
});
