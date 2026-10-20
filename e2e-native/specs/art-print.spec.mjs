// Print output on the real release app: GO composes the front / tray /
// booklet PDFs in Rust (compose_pdf) next to a simulated burn, and the booklet
// export renders artwork without distortion. PDFs are parsed and measured.
// Burn is simulate-only (runGo always passes drive "simulate").
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pageErrors } from "../helpers.mjs";
import {
  answerFileDialog,
  artPaths,
  click,
  dataUri,
  imagePlacements,
  openProject,
  pdfPages,
  pdfSummary,
  pdfText,
  projectJson,
  scrollTo,
  seedProject,
  selectValue,
  startApp,
  textOf,
  tour,
  waitFor,
  waitForText,
  writePng,
  writeSineWav
} from "../lib/art.mjs";

const ID = "e2e-art-print";
const ARTIST = "Signal Theory";
const ALBUM = "Café Tones";
const TRACKS = ["Señal", "Paper Moon Drive"];
const LYRICS = [
  { title: "Señal", lyrics: "Lyric line alpha\nLyric line beta" },
  { title: "Paper Moon Drive", lyrics: "Paper moon over the drive\nFold it twice and keep it" }
];
const PT_PER_MM = 72 / 25.4;
const STATUS = "details.status-band";

function seedPrintProject(home) {
  const audio = TRACKS.map((title, index) => ({
    id: `e2e-track-${index + 1}`,
    title,
    artist: ARTIST,
    album: ALBUM,
    durationSec: 5,
    // Red Book needs >= 4 s per track; synthetic tones only.
    path: writeSineWav(path.join(home, "audio", `tone-${index + 1}.wav`), { seconds: 5, hz: 440 + index * 110 }),
    sampleRate: 44_100,
    channels: 2
  }));
  // Square front art at 1600 px: enough for 120 mm at 300 DPI.
  const coverPath = writePng(path.join(artPaths(home).covers, "print-front.png"), 1600, 1600, [180, 30, 50], [250, 220, 120]);
  const previewPath = writePng(path.join(home, "print-preview.png"), 200, 200, [180, 30, 50], [250, 220, 120]);
  // A wide picture (not square) the user may pick for the front.
  writePng(path.join(artPaths(home).out, "wide-front.png"), 3000, 1600, [20, 120, 200], [250, 250, 250]);
  // Big enough for the front, too small for the tray (1847 px across at 300 dpi).
  writePng(path.join(artPaths(home).out, "tray-small.png"), 1600, 1600, [90, 160, 60], [240, 240, 200]);
  const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
  const cover = { imagePath: coverPath, previewUrl: dataUri(previewPath), prompt: "real album cover", palette: ["#b41e32"], adapter: "real" };
  const lyricLines = LYRICS.flatMap((entry, index) => {
    const header = `${index + 1}. ${entry.title}`;
    return index === 0 ? [header, ...entry.lyrics.split("\n")] : ["", header, ...entry.lyrics.split("\n")];
  });
  seedProject(
    home,
    projectJson({
      id: ID,
      artist: ARTIST,
      album: ALBUM,
      tracks: audio,
      research: {
        album: { artist: ARTIST, album: ALBUM, year: 2001, label: "E2E Records", tracks: TRACKS, coverArtUrls: [], tags: [] },
        cover,
        lyricsByTrack: LYRICS
      },
      art: [
        { slotId: "front", imageRef: coverPath, previewRef: cover.previewUrl, imageSource: "research", transform },
        {
          slotId: "tray",
          textContent: { title: `${ARTIST} - ${ALBUM}`, lines: TRACKS.map((title, index) => `${index + 1}. ${title}`) },
          textSource: "research",
          transform
        },
        { slotId: "saddle-16", textContent: { title: `${ALBUM} lyrics`, lines: lyricLines }, textSource: "research", transform }
      ]
    })
  );
}

async function runGo(driver) {
  const startedAt = Date.now();
  await click(driver, '[data-testid="go-button"]');
  await waitFor(
    driver,
    `const progress = document.querySelector('[data-testid="burn-progress"]').textContent;
     const error = document.querySelector('[data-testid="go-error"]');
     return error ? "error: " + error.textContent : progress === "Test burn: 100%" ? progress : false;`,
    { timeout: 120_000, message: "GO finished (100% or go-error)" }
  );
  return startedAt;
}

describe("GO: composed print PDFs and booklet artwork fit", () => {
  let app;
  let driver;
  let home;
  let pages;

  before(async () => {
    app = await startApp({ seed: (_dirs, tempHome) => seedPrintProject(tempHome) });
    driver = app.driver;
    home = app.home;
    await openProject(driver, ID);
    await click(driver, "details.status-band > summary");
  });

  after(async () => {
    await app?.close();
  });

  it("GO composes front, tray and booklet PDFs and finishes the simulated burn", async () => {
    assert.equal(await textOf(driver, '[data-testid="export-list"]'), "Exports: none");
    const startedAt = await runGo(driver);
    assert.equal(await textOf(driver, '[data-testid="go-error"]'), null, "GO reported no error");
    const exportsText = await textOf(driver, '[data-testid="export-list"]');
    const listed = exportsText.replace(/^Exports:\s*/, "").split(" | ").map((item) => item.trim());
    assert.equal(listed.length, 2, "GO exports front and tray; the booklet has its own export");
    const expected = ["front.pdf", "tray.pdf"].map((name) => listed.find((file) => path.basename(file) === name));
    for (const file of expected) {
      assert.ok(file && file.startsWith(home), `export list names a PDF inside the person's data: ${exportsText}`);
      assert.ok(existsSync(file) && statSync(file).mtimeMs >= startedAt - 2_000, `${file} freshly written`);
    }

    const front = await pdfSummary(expected[0]);
    assert.equal(front.pageCount, 1);
    assert.deepEqual(front.pages[0], { wMm: 126.35, hMm: 126.35 }, "front media = 120 mm trim + 3.175 mm bleed each side");
    assert.equal(front.imageCount, 1, "front art embedded once");
    const tray = await pdfSummary(expected[1]);
    assert.equal(tray.pageCount, 1);
    assert.deepEqual(tray.pages[0], { wMm: 156.35, hMm: 124.35 });
    assert.match(pdfText(tray.streams), /Paper Moon Drive/, "tray lists the tracks");
    const bookletFile = path.join(artPaths(home).out, "saddle-16.pdf");
    const save = answerFileDialog("save", bookletFile);
    await click(driver, '[data-testid="export-booklet"]');
    await save;
    await waitForText(driver, '[data-testid="export-message"]', `Saved ${bookletFile}`, { timeout: 60_000 });
    const booklet = await pdfSummary(bookletFile);
    pages = { front: await pdfPages(expected[0]), tray: await pdfPages(expected[1]), booklet: await pdfPages(bookletFile) };
    assert.equal(booklet.pageCount, 8, "16-page saddle booklet = 8 imposed spreads");
    assert.deepEqual(booklet.pages, Array.from({ length: 8 }, () => ({ wMm: 279.4, hMm: 158.75 })), "every face uses the CD1600R template's 11 × 6.25 inch media");
    assert.match(pdfText(booklet.streams), /Lyric line alpha/);
    await tour(driver, "go-exports", STATUS);
  });

  it("tray PDF keeps accented characters from the album data", () => {
    const text = pdfText([{ bytes: Buffer.from(pages.tray[0].content, "latin1"), subtype: "" }]);
    assert.ok(text.includes("Café Tones") && text.includes("Señal"), `tray text was: ${JSON.stringify(text.slice(0, 120))}`);
  });

  it("front artwork covers the whole trim box (no white edge after cutting)", () => {
    const [placement] = imagePlacements(pages.front[0].content);
    assert.ok(placement, "front image placement found");
    const trimLo = 3.175 * PT_PER_MM;
    const trimHi = 123.175 * PT_PER_MM;
    assert.ok(
      placement.e <= trimLo + 0.01 && placement.f <= trimLo + 0.01 && placement.e + placement.a >= trimHi - 0.01 && placement.f + placement.d >= trimHi - 0.01,
      `image spans x ${placement.e.toFixed(1)}..${(placement.e + placement.a).toFixed(1)} pt, y ${placement.f.toFixed(1)}..${(placement.f + placement.d).toFixed(1)} pt; trim is ${trimLo.toFixed(1)}..${trimHi.toFixed(1)} pt`
    );
  });

  it("booklet lyrics are not printed on the front and back cover spread", () => {
    const coverSpread = pages.booklet[0].content;
    assert.doesNotMatch(coverSpread, /Lyric line alpha|Paper moon over the drive/, "lyric text found on spread 1 (pages 16|1)");
  });

  it("GO explains when tray art is below 300 DPI", async () => {
    const previousExports = await textOf(driver, '[data-testid="export-list"]');
    await scrollTo(driver, 'section[aria-labelledby="art-heading"]', "start");
    await selectValue(driver, '[data-testid="insert-select"]', "tray");
    // The Artwork panel already blocks the 1600 px album cover for the tray, with a visible reason.
    await waitFor(driver, `return document.querySelector('[data-testid="use-researched-cover"]').disabled`, { message: "album cover blocked for the tray" });
    assert.match(await textOf(driver, "#use-researched-cover-reason"), /too small for this piece/);
    // A picked picture that is too small gets the inline warning, and GO names the piece and the sizes.
    const dialog = answerFileDialog("open", path.join(artPaths(home).out, "tray-small.png"));
    await click(driver, '[data-testid="pick-image"]');
    await dialog;
    await waitForText(driver, '[data-testid="slot-size-warning"]', /^Too small for this piece \(needs \d+ × \d+ px\)\.$/, { timeout: 30_000 });
    await click(driver, '[data-testid="go-button"]');
    const error = await waitForText(driver, '[data-testid="go-error"]', /^Export stopped\. Tray card: The Tray card image is too small to print sharply \(1600×1600 px; it needs \d+×\d+\)\.$/, { timeout: 120_000 });
    assert.doesNotMatch(error, /\/tmp\/|\.png/, "the error names the piece, not a file path");
    assert.equal(await textOf(driver, '[data-testid="export-list"]'), previousExports, "a failed GO keeps the last successful exports");
    await tour(driver, "go-error", STATUS);
  });

  it("a wide picture picked for the front is not stretched in the booklet PDF", async () => {
    // Put the tray back to text-only so GO is not the subject here.
    await selectValue(driver, '[data-testid="insert-select"]', "front");
    const wide = path.join(artPaths(home).out, "wide-front.png");
    const dialog = answerFileDialog("open", wide);
    await click(driver, '[data-testid="pick-image"]');
    await dialog;
    // Picked pictures are copied into app data under a content hash.
    await waitForText(driver, '[data-testid="composed-inserts"]', /front [0-9a-f]{16}\.png/, { timeout: 30_000 });
    const target = path.join(artPaths(home).out, "wide-booklet.pdf");
    const save = answerFileDialog("save", target);
    await click(driver, '[data-testid="export-booklet"]');
    await save;
    await waitForText(driver, '[data-testid="export-message"]', `Saved ${target}`, { timeout: 60_000 });
    const bookletPages = await pdfPages(target);
    const distorted = [];
    for (const [index, page] of bookletPages.entries()) {
      for (const placement of imagePlacements(page.content)) {
        const image = page.xobjects[placement.name];
        if (!image) continue;
        const drawn = placement.a / placement.d;
        const real = image.width / image.height;
        if (Math.abs(drawn - real) / real > 0.02 && !/\sW\s+n\b/.test(page.content)) {
          distorted.push(`face ${index + 1}: ${image.width}x${image.height} drawn ${placement.a.toFixed(1)}x${placement.d.toFixed(1)} pt`);
        }
      }
    }
    assert.deepEqual(distorted, [], "artwork drawn with a different aspect ratio and no clip");
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
