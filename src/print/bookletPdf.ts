import {
  type PDFImage,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb
} from "pdf-lib";
import { hexToRgb01, mixHex, type BookletPageVisual } from "../booklet/design";
import { type BookletPageKind, type TextBlock, DEFAULT_TYPE_SCALE } from "../booklet/pagination";
import { impose, type ImposedSpread } from "../geometry/imposition";
import { getDimension, type ComponentDim } from "./dimensions";

const PT_PER_IN = 72;

export interface BookletPdfPage {
  pageNumber: number;
  title?: string;
  subtitle?: string;
  kind?: BookletPageKind;
  trackIndex?: number;
  part?: number;
  partCount?: number;
  visual?: BookletPageVisual;
  color?: [number, number, number];
  /** Full-bleed artwork for this page (PNG or JPEG bytes). */
  imageBytes?: Uint8Array;
  /** Washed full-bleed artwork drawn UNDER text blocks (album art style). */
  backgroundImageBytes?: Uint8Array;
  /** Text blocks (from pagination) drawn inside the safety box. */
  blocks?: TextBlock[];
}

export interface BookletFacePlan {
  sheet: number;
  face: "outer" | "inner";
  leftPage: number;
  rightPage: number;
  media: { wIn: number; hIn: number; wPt: number; hPt: number };
  foldLines: Array<{ xIn: number; xPt: number }>;
}

export interface RenderBookletPdfInput {
  componentId: string;
  pageCount: number;
  pages?: BookletPdfPage[];
}

export interface RenderBookletPdfResult {
  bytes: Uint8Array;
  faces: BookletFacePlan[];
}

interface FontSet {
  body: PDFFont;
  sans: PDFFont;
  serif: PDFFont;
  mono: PDFFont;
}

export function bookletFacePlan(componentId: string, pageCount: number): BookletFacePlan[] {
  const component = requireBookletComponent(componentId);
  return impose(pageCount).map((spread) => facePlan(component, spread));
}

export function foldedReadingOrderFromImposition(spreads: ImposedSpread[]): number[] {
  const sheetCount = spreads.length / 2;
  const bySheet = new Map<number, { outer: ImposedSpread; inner: ImposedSpread }>();
  for (const spread of spreads) {
    const entry = bySheet.get(spread.sheet) ?? ({} as { outer: ImposedSpread; inner: ImposedSpread });
    entry[spread.face] = spread;
    bySheet.set(spread.sheet, entry);
  }

  const order: number[] = [];
  for (let sheet = 0; sheet < sheetCount; sheet += 1) {
    const pair = bySheet.get(sheet);
    if (!pair) throw new Error(`Missing sheet ${sheet}.`);
    order.push(pair.outer.right, pair.inner.left);
  }
  for (let sheet = sheetCount - 1; sheet >= 0; sheet -= 1) {
    const pair = bySheet.get(sheet);
    if (!pair) throw new Error(`Missing sheet ${sheet}.`);
    order.push(pair.inner.right, pair.outer.left);
  }
  return order;
}

export async function renderBookletPdf(input: RenderBookletPdfInput): Promise<RenderBookletPdfResult> {
  const component = requireBookletComponent(input.componentId);
  const faces = bookletFacePlan(input.componentId, input.pageCount);
  const pdf = await PDFDocument.create();
  const fonts: FontSet = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    sans: await pdf.embedFont(StandardFonts.HelveticaBold),
    serif: await pdf.embedFont(StandardFonts.TimesRomanBold),
    mono: await pdf.embedFont(StandardFonts.CourierBold)
  };
  const pageMap = new Map((input.pages ?? []).map((page) => [page.pageNumber, page]));
  const media = component.media!;
  const widthPt = media.in.w * PT_PER_IN;
  const heightPt = media.in.h * PT_PER_IN;
  const foldXPt = component.foldLines[0] * PT_PER_IN;
  const bleed = component.bleed!;
  const trim = component.trim!;
  const pageBleed = component.pageBleed ?? bleed;
  const bleedXPt = (bleed.insets?.left ?? (media.in.w - bleed.in.w) / 2) * PT_PER_IN;
  const bleedYPt = (bleed.insets?.top ?? (media.in.h - pageBleed.in.h) / 2) * PT_PER_IN;
  const pageBleedWPt = pageBleed.in.w * PT_PER_IN;
  const pageBleedHPt = pageBleed.in.h * PT_PER_IN;
  const pageSafety = component.pageSafety ?? component.safety!;
  const safetyWPt = pageSafety.in.w * PT_PER_IN;
  const safetyHPt = pageSafety.in.h * PT_PER_IN;

  for (const face of faces) {
    const page = pdf.addPage([widthPt, heightPt]);
    drawCropMarks(page, component);
    for (const fold of face.foldLines) {
      page.drawLine({
        start: { x: fold.xPt, y: 0.25 * PT_PER_IN },
        end: { x: fold.xPt, y: heightPt - 0.25 * PT_PER_IN },
        thickness: 0.6,
        color: rgb(0.15, 0.15, 0.15),
        dashArray: [4, 3]
      });
    }

    await drawPageSlot(page, {
      pdf,
      x: bleedXPt,
      y: bleedYPt,
      w: pageBleedWPt,
      h: pageBleedHPt,
      safetyWPt,
      safetyHPt,
      page: pageMap.get(face.leftPage) ?? { pageNumber: face.leftPage },
      fonts
    });
    await drawPageSlot(page, {
      pdf,
      x: foldXPt,
      y: bleedYPt,
      w: pageBleedWPt,
      h: pageBleedHPt,
      safetyWPt,
      safetyHPt,
      page: pageMap.get(face.rightPage) ?? { pageNumber: face.rightPage },
      fonts
    });

    page.drawText(`sheet ${face.sheet + 1} ${face.face}`, {
      x: (trim.insets?.left ?? (media.in.w - trim.in.w) / 2) * PT_PER_IN,
      y: heightPt - 0.35 * PT_PER_IN,
      size: 7,
      font: fonts.body,
      color: rgb(0.25, 0.25, 0.25)
    });
  }

  return { bytes: await pdf.save({ useObjectStreams: false }), faces };
}

function facePlan(component: ComponentDim, spread: ImposedSpread): BookletFacePlan {
  const media = component.media!;
  return {
    sheet: spread.sheet,
    face: spread.face,
    leftPage: spread.left,
    rightPage: spread.right,
    media: {
      wIn: media.in.w,
      hIn: media.in.h,
      wPt: media.in.w * PT_PER_IN,
      hPt: media.in.h * PT_PER_IN
    },
    foldLines: component.foldLines.map((xIn) => ({ xIn, xPt: xIn * PT_PER_IN }))
  };
}

async function drawPageSlot(
  pdfPage: PDFPage,
  input: {
    pdf: PDFDocument;
    x: number;
    y: number;
    w: number;
    h: number;
    safetyWPt: number;
    safetyHPt: number;
    page: BookletPdfPage;
    fonts: FontSet;
  }
) {
  const { page } = input;

  // Full-bleed artwork: embed and cover the entire page bleed rect.
  if (page.imageBytes && page.imageBytes.length) {
    const image = await embedImage(input.pdf, page.imageBytes);
    drawImageCover(pdfPage, image, input);
    return;
  }

  const safetyX = input.x + (input.w - input.safetyWPt) / 2;
  const safetyY = input.y + (input.h - input.safetyHPt) / 2;
  if (page.visual) {
    drawStyledBackground(pdfPage, page.visual, input.x, input.y, input.w, input.h);
  }
  if (page.backgroundImageBytes && page.backgroundImageBytes.length) {
    const image = await embedImageCached(input.pdf, page.backgroundImageBytes);
    drawImageCover(
      pdfPage,
      image,
      input,
      page.kind === "art" ? Math.min(0.34, (page.visual?.washOpacity ?? 0.14) * 2.6) : (page.visual?.washOpacity ?? 0.14)
    );
  }

  // Spare pages and art plates print with no words on them.
  if (page.visual && (page.kind === "blank" || page.kind === "art")) {
    return;
  }

  if (page.visual && page.kind === "cover") {
    drawTypographicCover(pdfPage, page, input, input.fonts);
    return;
  }

  if (page.blocks && page.blocks.length) {
    if (page.visual) {
      drawEditorialHeader(pdfPage, page, safetyX, safetyY, input.safetyWPt, input.safetyHPt, input.fonts);
    }
    drawTextBlocks(pdfPage, page.blocks, {
      safetyX,
      safetyY,
      safetyWPt: input.safetyWPt,
      safetyHPt: input.safetyHPt,
      font: input.fonts.body,
      color: page.visual?.colors.ink,
      layout: page.visual?.layout
    });
    if (page.visual) drawFolio(pdfPage, page.visual, safetyX, safetyY, input.safetyWPt, input.fonts.mono);
    return;
  }

  if (page.visual) {
    drawQuietPage(pdfPage, page, input, input.fonts);
    return;
  }

  // Fallback: colored rect + page number (geometry proof).
  const color = page.color ?? [0.9, 0.9, 0.88];
  pdfPage.drawRectangle({
    x: input.x,
    y: input.y,
    width: input.w,
    height: input.h,
    color: rgb(color[0], color[1], color[2]),
    borderColor: rgb(0.1, 0.1, 0.1),
    borderWidth: 0.4
  });
  pdfPage.drawText(String(page.pageNumber), {
    x: input.x + input.w / 2 - 6,
    y: input.y + input.h / 2 - 8,
    size: 18,
    font: input.fonts.body,
    color: rgb(0.08, 0.08, 0.08)
  });
  if (page.title) {
    pdfPage.drawText(sanitizeForFont(page.title.slice(0, 36), input.fonts.body), {
      x: input.x + 12,
      y: input.y + 12,
      size: 8,
      font: input.fonts.body,
      color: rgb(0.12, 0.12, 0.12)
    });
  }
}

/**
 * Cover-fit: scale the image to fill the box on both axes, keep its aspect
 * ratio, centre it and clip whatever spills past the box (the fold, the
 * neighbouring page).
 */
export function coverFitRect(
  imageW: number,
  imageH: number,
  box: { x: number; y: number; w: number; h: number }
): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(box.w / imageW, box.h / imageH);
  const width = imageW * scale;
  const height = imageH * scale;
  return { x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, width, height };
}

function drawImageCover(
  pdfPage: PDFPage,
  image: PDFImage,
  box: { x: number; y: number; w: number; h: number },
  opacity?: number
) {
  pdfPage.pushOperators(pushGraphicsState(), rectangle(box.x, box.y, box.w, box.h), clip(), endPath());
  pdfPage.drawImage(image, { ...coverFitRect(image.width, image.height, box), opacity });
  pdfPage.pushOperators(popGraphicsState());
}

/** One embedded XObject per distinct byte buffer (the wash repeats on many pages). */
const embedCache = new WeakMap<PDFDocument, Map<Uint8Array, PDFImage>>();

async function embedImageCached(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  let cache = embedCache.get(pdf);
  if (!cache) {
    cache = new Map();
    embedCache.set(pdf, cache);
  }
  const hit = cache.get(bytes);
  if (hit) {
    return hit;
  }
  const image = await embedImage(pdf, bytes);
  cache.set(bytes, image);
  return image;
}

/** Sniff PNG magic bytes vs JPEG and embed with the matching decoder. */
async function embedImage(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  return isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

/**
 * Draw wrapped text blocks inside the safety box using the default type scale.
 * Coordinates in each block are inches within the safety box (origin top-left,
 * matching pagination); we flip to PDF's bottom-left origin here.
 */
function drawTextBlocks(
  pdfPage: PDFPage,
  blocks: TextBlock[],
  ctx: {
    safetyX: number;
    safetyY: number;
    safetyWPt: number;
    safetyHPt: number;
    font: PDFFont;
    color?: string;
    layout?: BookletPageVisual["layout"];
  }
) {
  for (const block of blocks) {
    const blockXPt = ctx.safetyX + block.xIn * PT_PER_IN;
    const blockTopPt = ctx.safetyY + ctx.safetyHPt - block.yIn * PT_PER_IN;
    const blockWPt = Math.min(block.wIn * PT_PER_IN, ctx.safetyWPt);
    const blockHPt = Math.min(block.hIn * PT_PER_IN, ctx.safetyHPt);
    const columns = block.columns ?? (ctx.layout === "split" && blockWPt > 180 ? 2 : 1);
    const gap = columns === 2 ? 12 : 0;
    const columnW = (blockWPt - gap * (columns - 1)) / columns;
    let size = block.fontSizePt ?? DEFAULT_TYPE_SCALE.fontSizePt;
    const leadingRatio = (block.leadingPt ?? DEFAULT_TYPE_SCALE.leadingPt) / size;
    let leading = block.leadingPt ?? DEFAULT_TYPE_SCALE.leadingPt;
    let lines = wrapToWidth(block.text, ctx.font, size, columnW);
    let perColumn = Math.ceil(lines.length / columns);
    let maxLines = Math.max(1, Math.floor(blockHPt / leading));

    // The paginator uses conservative character metrics. Recheck with the
    // actual embedded font and tighten only if a rare wide line reflows.
    while (perColumn > maxLines && size > 4.75) {
      size -= 0.25;
      leading = size * leadingRatio;
      lines = wrapToWidth(block.text, ctx.font, size, columnW);
      perColumn = Math.ceil(lines.length / columns);
      maxLines = Math.max(1, Math.floor(blockHPt / leading));
    }
    if (perColumn > maxLines) {
      leading = blockHPt / perColumn;
      size = Math.min(size, leading * 0.84);
    }

    for (let column = 0; column < columns; column += 1) {
      drawLines(pdfPage, lines.slice(column * perColumn, (column + 1) * perColumn), {
        x: blockXPt + column * (columnW + gap),
        top: blockTopPt,
        bottom: ctx.safetyY,
        size,
        leading,
        font: ctx.font,
        color: ctx.color
      });
    }
  }
}

function drawLines(
  pdfPage: PDFPage,
  lines: string[],
  ctx: { x: number; top: number; bottom: number; size: number; leading: number; font: PDFFont; color?: string }
) {
  let baseline = ctx.top - ctx.size;
  for (const line of lines) {
    if (baseline < ctx.bottom) break;
    pdfPage.drawText(line, {
      x: ctx.x,
      y: baseline,
      size: ctx.size,
      font: ctx.font,
      color: pdfColor(ctx.color ?? "#14181d")
    });
    baseline -= ctx.leading;
  }
}

function drawStyledBackground(
  page: PDFPage,
  visual: BookletPageVisual,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const { colors } = visual;
  page.drawRectangle({ x, y, width, height, color: pdfColor(colors.paper) });

  switch (visual.motif) {
    case "orb": {
      const translucentAccent = mixHex(colors.accent, colors.paper, 0.22);
      page.drawCircle({
        x: x + width * 0.88,
        y: y + height * 0.84,
        size: width * 0.28,
        color: pdfColor(translucentAccent),
        opacity: 0.5
      });
      page.drawCircle({
        x: x + width * 0.04,
        y: y + height * 0.06,
        size: width * 0.2,
        color: pdfColor(colors.highlight),
        opacity: 0.18
      });
      break;
    }
    case "signal": {
      page.drawRectangle({
        x,
        y: y + height * 0.76,
        width: width * 0.54,
        height: height * 0.045,
        color: pdfColor(colors.accent),
        opacity: 0.78
      });
      page.drawRectangle({
        x: x + width * 0.83,
        y,
        width: width * 0.035,
        height,
        color: pdfColor(colors.highlight),
        opacity: 0.36
      });
      break;
    }
    case "frame": {
      const inset = 13;
      page.drawRectangle({
        x: x + inset,
        y: y + inset,
        width: width - inset * 2,
        height: height - inset * 2,
        borderColor: pdfColor(colors.accent),
        borderWidth: 1.1,
        opacity: 0.7
      });
      page.drawRectangle({
        x: x + inset + 4,
        y: y + inset + 4,
        width: width - (inset + 4) * 2,
        height: height - (inset + 4) * 2,
        borderColor: pdfColor(colors.highlight),
        borderWidth: 0.35,
        opacity: 0.48
      });
      break;
    }
    case "field": {
      for (let index = 1; index < 8; index += 1) {
        page.drawLine({
          start: { x, y: y + (height * index) / 8 },
          end: { x: x + width, y: y + (height * index) / 8 },
          thickness: index === 4 ? 0.65 : 0.25,
          color: pdfColor(index === 4 ? colors.accent : colors.muted),
          opacity: index === 4 ? 0.42 : 0.18
        });
      }
      break;
    }
    case "grid": {
      for (let index = 1; index < 8; index += 1) {
        page.drawLine({
          start: { x: x + (width * index) / 8, y },
          end: { x: x + (width * index) / 8, y: y + height },
          thickness: 0.25,
          color: pdfColor(colors.muted),
          opacity: 0.16
        });
        page.drawLine({
          start: { x, y: y + (height * index) / 8 },
          end: { x: x + width, y: y + (height * index) / 8 },
          thickness: 0.25,
          color: pdfColor(colors.muted),
          opacity: 0.16
        });
      }
      break;
    }
  }
}

function drawTypographicCover(
  pdfPage: PDFPage,
  page: BookletPdfPage,
  input: { x: number; y: number; w: number; h: number; safetyWPt: number; safetyHPt: number },
  fonts: FontSet
) {
  const visual = page.visual!;
  const title = sanitizeForFont(page.title?.trim() || "UNTITLED", displayFont(visual, fonts));
  const subtitle = sanitizeForFont(page.subtitle?.trim() || "UNKNOWN ARTIST", fonts.mono);
  const display = displayFont(visual, fonts);
  const margin = (input.w - input.safetyWPt) / 2;
  const left = input.x + margin;
  const bottom = input.y + (input.h - input.safetyHPt) / 2;
  const maxWidth = input.safetyWPt;
  const titleSize = fitTextSize(title, display, Math.min(34, input.w * 0.1), 17, maxWidth);
  const lineHeight = titleSize * 1.02;
  const titleLines = clampLines(wrapToWidth(title, display, titleSize, maxWidth), 2, display, titleSize, maxWidth);
  // A second title line pushes the rule and the artist down by the same amount.
  const shift = (titleLines.length - 1) * lineHeight;

  pdfPage.drawText(sanitizeForFont(visual.designLabel.toUpperCase(), fonts.mono), {
    x: left,
    y: bottom + input.safetyHPt - 10,
    size: 6.2,
    font: fonts.mono,
    color: pdfColor(visual.colors.accent)
  });
  titleLines.forEach((line, index) => {
    pdfPage.drawText(line, {
      x: left,
      y: bottom + input.safetyHPt * 0.47 - index * lineHeight,
      size: titleSize,
      font: display,
      color: pdfColor(visual.colors.ink)
    });
  });
  pdfPage.drawLine({
    start: { x: left, y: bottom + input.safetyHPt * 0.39 - shift },
    end: { x: left + maxWidth * 0.42, y: bottom + input.safetyHPt * 0.39 - shift },
    thickness: 2,
    color: pdfColor(visual.colors.accent)
  });
  pdfPage.drawText(ellipsize(subtitle.toUpperCase(), fonts.mono, 8.5, maxWidth), {
    x: left,
    y: bottom + input.safetyHPt * 0.31 - shift,
    size: 8.5,
    font: fonts.mono,
    color: pdfColor(visual.colors.ink)
  });
  drawFolio(pdfPage, visual, left, bottom, maxWidth, fonts.mono);
}

function drawEditorialHeader(
  pdfPage: PDFPage,
  page: BookletPdfPage,
  safetyX: number,
  safetyY: number,
  safetyWPt: number,
  safetyHPt: number,
  fonts: FontSet
) {
  const visual = page.visual!;
  const display = displayFont(visual, fonts);
  const title = sanitizeForFont(page.title?.trim() || visual.eyebrow, display);
  const continuation = page.partCount && page.partCount > 1 ? ` / ${page.part} OF ${page.partCount}` : "";
  const eyebrow = sanitizeForFont(`${visual.eyebrow}${continuation}`, fonts.mono);
  const top = safetyY + safetyHPt;
  const titleSize = fitTextSize(title, display, 17, 11, safetyWPt * 0.92);
  // One line only: a title that still does not fit at the minimum size is
  // ellipsized, so it can never wrap into the rule or the lyric block.
  const titleLine = ellipsize(title, display, titleSize, safetyWPt * 0.92);

  pdfPage.drawText(eyebrow, {
    x: safetyX,
    y: top - 7,
    size: 5.8,
    font: fonts.mono,
    color: pdfColor(visual.colors.accent)
  });
  pdfPage.drawText(titleLine, {
    x: safetyX,
    y: top - 29,
    size: titleSize,
    font: display,
    color: pdfColor(visual.colors.ink)
  });
  pdfPage.drawLine({
    start: { x: safetyX, y: top - 36 },
    end: {
      x: safetyX + (visual.layout === "number-rail" ? safetyWPt * 0.18 : safetyWPt),
      y: top - 36
    },
    thickness: visual.layout === "number-rail" ? 2.3 : 0.65,
    color: pdfColor(visual.colors.accent),
    opacity: 0.85
  });
}

function drawFolio(
  page: PDFPage,
  visual: BookletPageVisual,
  safetyX: number,
  safetyY: number,
  safetyWPt: number,
  font: PDFFont
) {
  const label = sanitizeForFont(`${visual.folio}  /  ${visual.designLabel.toUpperCase()}`, font);
  const size = 5.6;
  page.drawText(label, {
    x: safetyX + safetyWPt - font.widthOfTextAtSize(label, size),
    y: safetyY + 2,
    size,
    font,
    color: pdfColor(visual.colors.muted)
  });
}

function drawQuietPage(
  pdfPage: PDFPage,
  page: BookletPdfPage,
  input: { x: number; y: number; w: number; h: number; safetyWPt: number; safetyHPt: number },
  fonts: FontSet
) {
  const visual = page.visual!;
  const display = displayFont(visual, fonts);
  const left = input.x + (input.w - input.safetyWPt) / 2;
  const bottom = input.y + (input.h - input.safetyHPt) / 2;
  const title = sanitizeForFont(page.title?.trim() || visual.eyebrow, display);
  const subtitle = page.subtitle ? sanitizeForFont(page.subtitle, fonts.mono) : undefined;

  const titleSize = fitTextSize(title, display, page.kind === "back" ? 22 : 15, 10, input.safetyWPt);
  pdfPage.drawText(ellipsize(title, display, titleSize, input.safetyWPt), {
    x: left,
    y: bottom + input.safetyHPt * 0.47,
    size: titleSize,
    font: display,
    color: pdfColor(visual.colors.ink)
  });
  if (subtitle) {
    pdfPage.drawText(ellipsize(subtitle.toUpperCase(), fonts.mono, 7, input.safetyWPt), {
      x: left,
      y: bottom + input.safetyHPt * 0.4,
      size: 7,
      font: fonts.mono,
      color: pdfColor(visual.colors.accent)
    });
  }
  drawFolio(pdfPage, visual, left, bottom, input.safetyWPt, fonts.mono);
}

function displayFont(visual: BookletPageVisual, fonts: FontSet): PDFFont {
  if (visual.displayFace === "serif") return fonts.serif;
  if (visual.displayFace === "mono") return fonts.mono;
  return fonts.sans;
}

function fitTextSize(text: string, font: PDFFont, preferred: number, minimum: number, maxWidth: number): number {
  let size = preferred;
  while (size > minimum && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

/** Shorten text with a trailing "…" until it fits maxWidth at this size. */
function ellipsize(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const characters = Array.from(text);
  while (characters.length > 1 && font.widthOfTextAtSize(`${characters.join("").trimEnd()}…`, size) > maxWidth) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}…`;
}

/** Keep at most `max` wrapped lines; the last kept line absorbs the rest and is ellipsized. */
function clampLines(lines: string[], max: number, font: PDFFont, size: number, maxWidth: number): string[] {
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length <= max) return nonEmpty.length ? nonEmpty : [""];
  const kept = nonEmpty.slice(0, max - 1);
  kept.push(ellipsize(nonEmpty.slice(max - 1).join(" "), font, size, maxWidth));
  return kept;
}

function pdfColor(hex: string) {
  const [red, green, blue] = hexToRgb01(hex);
  return rgb(red, green, blue);
}

/**
 * Replace characters the standard WinAnsi font cannot encode with "?" so a stray
 * glyph (e.g. Korean in scraped lyrics) degrades that character, not the export.
 * Probes with the font's own encoder, so legitimate WinAnsi characters
 * (em-dashes, accented Latin) pass through untouched.
 */
function sanitizeForFont(text: string, font: PDFFont): string {
  try {
    font.widthOfTextAtSize(text, 1); // cheap probe: encodes every char
    return text;
  } catch {
    return Array.from(text, (ch) => {
      try {
        font.widthOfTextAtSize(ch, 1);
        return ch;
      } catch {
        return "?";
      }
    }).join("");
  }
}

/** Greedy word-wrap using the font's real advance widths; keeps explicit newlines. */
function wrapToWidth(text: string, font: PDFFont, size: number, maxWidthPt: number): string[] {
  const out: string[] = [];
  // Sanitize per paragraph, AFTER splitting: newlines themselves are not
  // WinAnsi-encodable and must stay line breaks, not degrade to "?".
  for (const rawParagraph of text.split(/\r?\n/)) {
    const paragraph = sanitizeForFont(rawParagraph, font);
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (font.widthOfTextAtSize(word, size) > maxWidthPt) {
        if (line) {
          out.push(line);
          line = "";
        }
        const fragments = breakWordByWidth(word, font, size, maxWidthPt);
        out.push(...fragments.slice(0, -1));
        line = fragments.at(-1) ?? "";
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > maxWidthPt && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function breakWordByWidth(word: string, font: PDFFont, size: number, maxWidthPt: number): string[] {
  const fragments: string[] = [];
  let fragment = "";
  for (const character of word) {
    const next = fragment + character;
    if (fragment && font.widthOfTextAtSize(next, size) > maxWidthPt) {
      fragments.push(fragment);
      fragment = character;
    } else {
      fragment = next;
    }
  }
  if (fragment) fragments.push(fragment);
  return fragments.length ? fragments : [word];
}

function drawCropMarks(pdfPage: PDFPage, component: ComponentDim) {
  const media = component.media!;
  const trim = component.trim!;
  const x = (trim.insets?.left ?? (media.in.w - trim.in.w) / 2) * PT_PER_IN;
  const y = (trim.insets?.top ?? (media.in.h - trim.in.h) / 2) * PT_PER_IN;
  const w = trim.in.w * PT_PER_IN;
  const h = trim.in.h * PT_PER_IN;
  const mark = 0.14 * PT_PER_IN;
  const bottom = media.in.h * PT_PER_IN - y - h;
  const top = bottom + h;
  const left = x;
  const right = x + w;

  for (const [start, end] of [
    [{ x: left - mark, y: bottom }, { x: left, y: bottom }],
    [{ x: left, y: bottom - mark }, { x: left, y: bottom }],
    [{ x: right, y: bottom }, { x: right + mark, y: bottom }],
    [{ x: right, y: bottom - mark }, { x: right, y: bottom }],
    [{ x: left - mark, y: top }, { x: left, y: top }],
    [{ x: left, y: top }, { x: left, y: top + mark }],
    [{ x: right, y: top }, { x: right + mark, y: top }],
    [{ x: right, y: top }, { x: right, y: top + mark }]
  ] as const) {
    pdfPage.drawLine({ start, end, thickness: 0.5, color: rgb(0, 0, 0) });
  }
}

function requireBookletComponent(componentId: string): ComponentDim {
  const component = getDimension(componentId);
  if (!component?.machineReadable || component.kind !== "saddle-booklet" || !component.media || !component.foldLines.length) {
    throw new Error(`${componentId} is not a machine-readable saddle booklet.`);
  }
  return component;
}
