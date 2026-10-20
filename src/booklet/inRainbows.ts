import { impose } from "../geometry/imposition";
import { foldedReadingOrderFromImposition, renderBookletPdf, type RenderBookletPdfResult } from "../print/bookletPdf";
import { generateFittedArtwork, type FittedArtwork } from "../print/imageFit";
import { paginate, type PaginatedBooklet } from "./pagination";

export const IN_RAINBOWS_TRACKS = [
  "15 Step",
  "Bodysnatchers",
  "Nude",
  "Weird Fishes / Arpeggi",
  "All I Need",
  "Faust Arp",
  "Reckoner",
  "House of Cards",
  "Jigsaw Falling Into Place",
  "Videotape"
];

export interface InRainbowsProof {
  booklet: PaginatedBooklet;
  coverArt: FittedArtwork;
  lyricsSpreadArt: FittedArtwork;
  impositionTable: InRainbowsImpositionRow[];
  readingOrder: number[];
  pdf: RenderBookletPdfResult;
}

export interface InRainbowsImpositionRow {
  sheet: number;
  outer: string;
  inner: string;
}

export async function buildInRainbowsProof(): Promise<InRainbowsProof> {
  const coverArt = await generateFittedArtwork({
    prompt: "In Rainbows front cover proof art",
    targetComponentId: "CD1600R"
  });
  const lyricsSpreadArt = await generateFittedArtwork({
    prompt: "In Rainbows lyrics spread proof art",
    targetComponentId: "CD1600R"
  });
  const booklet = paginate(IN_RAINBOWS_TRACKS, mockLyrics(), { fontSizePt: 8, leadingPt: 10, marginIn: 0.08 }, "CD1600R");
  const imposed = impose(booklet.pages.length);
  const pdf = await renderBookletPdf({
    componentId: "CD1600R",
    pageCount: booklet.pages.length,
    pages: booklet.pages.map((page) => ({
      pageNumber: page.pageNumber,
      title: page.title,
      color: colorForPage(page.kind)
    }))
  });

  return {
    booklet,
    coverArt,
    lyricsSpreadArt,
    impositionTable: impositionTable(imposed),
    readingOrder: foldedReadingOrderFromImposition(imposed),
    pdf
  };
}

export function expectedInRainbowsImpositionTable(): InRainbowsImpositionRow[] {
  return [
    { sheet: 1, outer: "16|1", inner: "2|15" },
    { sheet: 2, outer: "14|3", inner: "4|13" },
    { sheet: 3, outer: "12|5", inner: "6|11" },
    { sheet: 4, outer: "10|7", inner: "8|9" }
  ];
}

function impositionTable(spreads: ReturnType<typeof impose>): InRainbowsImpositionRow[] {
  const rows: InRainbowsImpositionRow[] = [];
  for (let sheet = 0; sheet < spreads.length / 2; sheet += 1) {
    const outer = spreads.find((spread) => spread.sheet === sheet && spread.face === "outer")!;
    const inner = spreads.find((spread) => spread.sheet === sheet && spread.face === "inner")!;
    rows.push({
      sheet: sheet + 1,
      outer: `${outer.left}|${outer.right}`,
      inner: `${inner.left}|${inner.right}`
    });
  }
  return rows;
}

function mockLyrics(): Record<string, string> {
  return Object.fromEntries(
    IN_RAINBOWS_TRACKS.map((track, index) => [
      track,
      [
        `${track} proof lyric line ${index + 1}.1`,
        `${track} proof lyric line ${index + 1}.2`,
        `${track} proof lyric line ${index + 1}.3`
      ].join("\n")
    ])
  );
}

function colorForPage(kind: string): [number, number, number] {
  if (kind === "cover" || kind === "back") return [0.12, 0.12, 0.12];
  if (kind === "lyrics") return [0.86, 0.9, 0.88];
  if (kind === "art") return [0.82, 0.86, 0.94];
  return [0.93, 0.9, 0.84];
}
