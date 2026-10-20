import zlib from "node:zlib";
import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveBookletDesign, visualForPage } from "../booklet/design";
import { impose } from "../geometry/imposition";
import { bookletFacePlan, coverFitRect, foldedReadingOrderFromImposition, renderBookletPdf } from "./bookletPdf";

describe("booklet PDF export", () => {
  it.each([4, 8, 12, 16, 20, 24])("folds imposed %i-page booklets into reader order", (pageCount) => {
    expect(foldedReadingOrderFromImposition(impose(pageCount))).toEqual(
      Array.from({ length: pageCount }, (_, index) => index + 1)
    );
  });

  it("plans CD1600R faces at exact media size with the registry fold line", () => {
    const faces = bookletFacePlan("CD1600R", 16);

    expect(faces).toHaveLength(8);
    expect(faces[0].media).toMatchObject({ wIn: 11, hIn: 6.25, wPt: 792, hPt: 450 });
    expect(faces.every((face) => face.foldLines.some((line) => line.xIn === 5.5 && line.xPt === 396))).toBe(true);
  });

  it("exports one PDF page per printed face", async () => {
    const result = await renderBookletPdf({ componentId: "CD1600R", pageCount: 16 });
    const pdf = await PDFDocument.load(result.bytes);
    const size = pdf.getPage(0).getSize();

    expect(pdf.getPageCount()).toBe(8);
    expect(size.width).toBeCloseTo(792, 4);
    expect(size.height).toBeCloseTo(450, 4);
    expect(result.faces[0].foldLines[0]).toEqual({ xIn: 5.5, xPt: 396 });

    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("embeds a real image XObject when a page carries imageBytes", async () => {
    const empty = await renderBookletPdf({ componentId: "CD1600R", pageCount: 4 });
    const withImage = await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [{ pageNumber: 1, title: "Front cover", imageBytes: tinyPng() }]
    });

    // pdf-lib records embedded images as /Image XObjects in the content stream.
    const loaded = await PDFDocument.load(withImage.bytes);
    expect(loaded.getPageCount()).toBe(2);

    const emptyText = Buffer.from(empty.bytes).toString("latin1");
    const withImageText = Buffer.from(withImage.bytes).toString("latin1");
    expect(emptyText).not.toContain("/Subtype /Image");
    expect(withImageText).toContain("/Subtype /Image");
    // Embedding a raster asset materially inflates the byte length.
    expect(withImage.bytes.length).toBeGreaterThan(empty.bytes.length + 200);
  });

  it("renders text blocks inside the safety box when a page carries blocks", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");

    const withBlocks = await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 1,
          title: "Tracklist",
          blocks: [{ text: "UNIQUEMARKER track one line two", xIn: 0.08, yIn: 0.08, wIn: 2, hIn: 4 }]
        }
      ]
    });

    const loaded = await PDFDocument.load(withBlocks.bytes);
    expect(loaded.getPageCount()).toBe(2);

    // The block text is drawn (wrapped) inside the safety box, not the fallback.
    const drawn = drawTextSpy.mock.calls.map((call) => String(call[0])).join(" ");
    expect(drawn).toContain("UNIQUEMARKER");
  });

  // Regression: live Genius lyrics carried Korean glyphs ("한") and the export died with
  // "WinAnsi cannot encode". Unencodable characters must degrade to "?", never throw.
  it("degrades non-WinAnsi characters to ? instead of failing the export", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");

    const result = await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 1,
          title: "한국어 title — kept dash",
          blocks: [{ text: "SANEMARKER 한국어 lyric — em-dash stays", xIn: 0.08, yIn: 0.08, wIn: 3, hIn: 4 }]
        }
      ]
    });

    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getPageCount()).toBe(2);

    const drawn = drawTextSpy.mock.calls.map((call) => String(call[0])).join(" ");
    expect(drawn).toContain("SANEMARKER");
    expect(drawn).toContain("???"); // the three Korean glyphs degraded
    expect(drawn).toContain("—"); // WinAnsi-legal em-dash passed through untouched
    expect(drawn).not.toContain("한");
  });

  // Regression: newlines are not WinAnsi-encodable; they must stay line breaks,
  // never degrade to "?" (the first sanitizer pass broke tracklist formatting).
  it("keeps newlines as line breaks when sanitizing", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 1,
          blocks: [{ text: "LINEONE alpha\nLINETWO beta", xIn: 0.08, yIn: 0.08, wIn: 3, hIn: 4 }]
        }
      ]
    });

    const drawnLines = drawTextSpy.mock.calls.map((call) => String(call[0]));
    expect(drawnLines).toContain("LINEONE alpha");
    expect(drawnLines).toContain("LINETWO beta");
    expect(drawnLines.join(" ")).not.toContain("?");
  });

  it("renders the selected editorial motif, hierarchy, continuation label, and folio", async () => {
    const drawCircleSpy = vi.spyOn(PDFPage.prototype, "drawCircle");
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const design = deriveBookletDesign({ artist: "Nova", album: "Current", tags: ["electronic"] });
    const visual = visualForPage(design, "lyrics", 3, 0);

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 3,
          title: "Glass Current",
          kind: "lyrics",
          part: 2,
          partCount: 3,
          visual,
          blocks: [{ text: "A line in the tide", xIn: 0.12, yIn: 0.72, wIn: 4.2, hIn: 2 }]
        }
      ]
    });

    const drawn = drawTextSpy.mock.calls.map((call) => String(call[0])).join(" ");
    expect(drawCircleSpy).toHaveBeenCalled();
    expect(drawn).toContain("TRACK 01 / 2 OF 3");
    expect(drawn).toContain("Glass Current");
    expect(drawn).toContain("03  /  LIQUID CHROME");
  });

  it("breaks a word wider than the text box without losing characters", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const marker = "WIDEMARKER".repeat(24);

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 1,
          blocks: [{ text: marker, xIn: 0.08, yIn: 0.08, wIn: 0.75, hIn: 4 }]
        }
      ]
    });

    const fragments = drawTextSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => /^[WIDEMARK]+$/.test(line));
    expect(fragments.join("")).toBe(marker);
  });

  it("cover-fits a wide picture: a 3000x1600 image keeps its 1.875 aspect ratio and fills the page", async () => {
    const drawImageSpy = vi.spyOn(PDFPage.prototype, "drawImage");
    const pushSpy = vi.spyOn(PDFPage.prototype, "pushOperators");

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [{ pageNumber: 1, title: "Front cover", imageBytes: rgbPng(3000, 1600) }]
    });

    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const options = drawImageSpy.mock.calls[0][1]!;
    expect(options.width! / options.height!).toBeCloseTo(1.875, 3);
    // Drawn inside a clip: q, re, W n ... Q around the image.
    const operators = pushSpy.mock.calls.flatMap((call) => call.map((operator) => operator.toString()));
    expect(operators.some((operator) => operator.startsWith("W"))).toBe(true);
    expect(operators.some((operator) => operator.startsWith("Q"))).toBe(true);
  });

  it("coverFitRect fills the box on both axes and centres the overflow", () => {
    const box = { x: 10, y: 20, w: 351, h: 360 };
    const rect = coverFitRect(3000, 1600, box);
    expect(rect.width / rect.height).toBeCloseTo(1.875, 6);
    expect(rect.height).toBeCloseTo(360, 6);
    expect(rect.width).toBeGreaterThanOrEqual(351);
    expect(rect.x + rect.width / 2).toBeCloseTo(box.x + box.w / 2, 6);
    expect(rect.y).toBeCloseTo(20, 6);
  });

  it("keeps a 90-character track title on one line clear of the rule and the lyrics", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const drawLineSpy = vi.spyOn(PDFPage.prototype, "drawLine");
    const design = deriveBookletDesign({ artist: "Nova", album: "Current", tags: ["electronic"] });
    const title = "An Extremely Long Track Title (feat. Several Guest Artists) [2026 Remaster] Extended Mix!!";
    expect(title).toHaveLength(90);

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        {
          pageNumber: 3,
          title,
          kind: "lyrics",
          visual: visualForPage(design, "lyrics", 3, 0),
          blocks: [{ text: "BODYMARKER first lyric line", xIn: 0.12, yIn: 0.74, wIn: 4.2, hIn: 2 }]
        }
      ]
    });

    const titleCall = drawTextSpy.mock.calls.find((call) => String(call[0]).startsWith("An Extremely"))!;
    const text = String(titleCall[0]);
    const options = titleCall[1]!;
    expect(text.endsWith("…")).toBe(true);
    expect(options.maxWidth).toBeUndefined();
    const descent = options.font!.heightAtSize(options.size!, { descender: true }) - options.font!.heightAtSize(options.size!, { descender: false });
    const titleBottom = options.y! - Math.abs(descent);
    const rule = drawLineSpy.mock.calls
      .map((call) => call[0])
      .find((line) => line.start.y === line.end.y && line.start.x === options.x && (line.thickness === 0.65 || line.thickness === 2.3))!;
    const body = drawTextSpy.mock.calls.find((call) => String(call[0]).startsWith("BODYMARKER"))!;
    expect(titleBottom).toBeGreaterThan(rule.start.y);
    expect(options.y!).toBeGreaterThan(body[1]!.y! + body[1]!.size!);
  });

  it("caps a long cover title at two lines and moves the rule and artist below them", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const drawLineSpy = vi.spyOn(PDFPage.prototype, "drawLine");
    const design = deriveBookletDesign({ artist: "Nova", album: "Current", tags: ["electronic"] });
    const title = "The Very Long Name Of An Album That Goes On And On Across The Whole Front Cover Forever";

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [{ pageNumber: 1, title, subtitle: "Nova", kind: "cover", visual: visualForPage(design, "cover", 1, 0) }]
    });

    const titleCalls = drawTextSpy.mock.calls.filter((call) => {
      const text = String(call[0]).replace(/…$/, "").trim();
      return text.length > 3 && title.includes(text);
    });
    expect(titleCalls.length).toBeGreaterThanOrEqual(1);
    expect(titleCalls.length).toBeLessThanOrEqual(2);
    const lowest = Math.min(...titleCalls.map((call) => call[1]!.y!));
    const rule = drawLineSpy.mock.calls
      .map((call) => call[0])
      .find((line) => line.thickness === 2 && line.start.x === titleCalls[0][1]!.x)!;
    const artist = drawTextSpy.mock.calls.find((call) => String(call[0]) === "NOVA")!;
    expect(lowest - titleCalls[0][1]!.size! * 0.25).toBeGreaterThan(rule.start.y);
    expect(rule.start.y).toBeGreaterThan(artist[1]!.y! + artist[1]!.size!);
  });

  it("prints spare pages and art plates with no words on them", async () => {
    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const design = deriveBookletDesign({ artist: "Nova", album: "Current", tags: ["electronic"] });

    await renderBookletPdf({
      componentId: "CD1600R",
      pageCount: 4,
      pages: [
        { pageNumber: 2, title: "", kind: "blank", visual: visualForPage(design, "blank", 2, 0) },
        { pageNumber: 3, title: "Art plate", kind: "art", visual: visualForPage(design, "art", 3, 0) }
      ]
    });

    const drawn = drawTextSpy.mock.calls.map((call) => String(call[0]));
    expect(drawn.filter((text) => /blank|art plate|LIQUID CHROME/i.test(text))).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal valid 1x1 opaque PNG (RGBA), enough for pdf.embedPng. */
function tinyPng(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
}

/** A solid RGB PNG of any size (stdlib zlib), for aspect-ratio checks. */
function rgbPng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height, 90);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0))
    ])
  );
}
