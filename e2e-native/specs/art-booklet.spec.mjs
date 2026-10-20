// Booklet layout, pagination, live preview, PDF export (through the real GTK
// save dialog) and the Artwork slot editor on the real release app, plus
// persistence of booklet + artwork choices across a relaunch.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { SIZES, pageErrors, setWindowSize } from "../helpers.mjs";
import {
  answerFileDialog,
  artPaths,
  attrOf,
  buttonByText,
  click,
  dataUri,
  exists,
  find,
  horizontalOverflow,
  openProject,
  pdfSummary,
  pdfText,
  projectJson,
  readProject,
  scrollTo,
  seedProject,
  selectValue,
  startApp,
  textOf,
  tour,
  waitFor,
  waitForText,
  writePng
} from "../lib/art.mjs";

const ID = "e2e-art-booklet";
const ARTIST = "Signal Theory";
const ALBUM = "Paper Tones";
const TRACKS = ["Opening Hum", "Static Bloom", "Paper Moon Drive", "Last Carrier", "Quiet Index", "Outro Fold"];
const LYRICS = [
  { title: "Opening Hum", lyrics: "First line of the hum\nSecond line of the hum\nThird line hums along\nFourth line fades" },
  { title: "Paper Moon Drive", lyrics: "Paper moon over the drive\nFold it twice and keep it\nCrease the night in half" },
  { title: "Quiet Index", lyrics: "Index the quiet\nFile it under morning" }
];
const BOOKLET = 'section[aria-labelledby="booklet-heading"]';
const ARTWORK = 'section[aria-labelledby="art-heading"]';

function seedBookletProject(home) {
  const coverPath = writePng(path.join(artPaths(home).covers, "seed-real-cover.png"), 1900, 1900, [200, 40, 60], [20, 60, 200]);
  const previewPath = writePng(path.join(home, "seed-preview.png"), 256, 256, [200, 40, 60], [20, 60, 200]);
  const cover = {
    imagePath: coverPath,
    previewUrl: dataUri(previewPath),
    prompt: "real album cover",
    palette: ["#c8283c", "#143cc8"],
    adapter: "real"
  };
  const album = { artist: ARTIST, album: ALBUM, year: 1999, label: "E2E Records", tracks: TRACKS, coverArtUrls: [], tags: ["electronic"] };
  const lyricLines = LYRICS.flatMap((entry, index) => {
    const header = `${TRACKS.indexOf(entry.title) + 1}. ${entry.title}`;
    const lines = entry.lyrics.split("\n");
    return index === 0 ? [header, ...lines] : ["", header, ...lines];
  });
  const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
  seedProject(
    home,
    projectJson({
      id: ID,
      artist: ARTIST,
      album: ALBUM,
      research: { album, cover, lyricsByTrack: LYRICS },
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
  // A picture the user keeps outside the app's folders, for "Choose image…".
  writePng(path.join(artPaths(home).out, "disc-art.png"), 1536, 1536, [250, 200, 40], [40, 20, 90]);
}

async function layoutButton(driver, pages) {
  return driver.executeScript(
    `return [...document.querySelectorAll(arguments[1] + ' [data-testid="layout-options"] button')].find((b) => b.querySelector("strong").textContent === arguments[0])`,
    String(pages),
    BOOKLET
  );
}


async function previewPages(driver) {
  return driver.executeScript(`
    return [...document.querySelectorAll('[data-testid="booklet-preview"] figure.bp-page')].map((figure) => ({
      id: figure.dataset.testid,
      kind: figure.dataset.kind,
      blocks: [...figure.querySelectorAll('.bp-block')].map((block) => block.textContent),
      caption: figure.querySelector('.bp-caption').textContent
    }));
  `);
}

async function waitForSaved(home, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = readProject(home, ID);
      if (predicate(last)) return last;
    } catch {
      // mid-replace
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`saved project never matched (bookletPages=${last?.bookletPages}, art=${last?.art?.map((a) => a.slotId)})`);
}

describe("booklet layout, preview, PDF export and artwork slots", () => {
  let app;
  let driver;
  let home;
  let exportedText;

  before(async () => {
    app = await startApp({ seed: (_dirs, tempHome) => seedBookletProject(tempHome), keepHome: true });
    driver = app.driver;
    home = app.home;
    await openProject(driver, ID);
  });

  after(async () => {
    await app?.close();
  });

  it("shows the 16-page saddle booklet with a page-by-page live preview", async () => {
    await scrollTo(driver, BOOKLET, "start");
    assert.equal(await textOf(driver, '[data-testid="booklet-pages"]'), "16 pages");
    assert.equal(await exists(driver, '[data-testid="booklet-validation"]'), false);
    assert.match(await attrOf(driver, '[data-testid="booklet-preview"]', "aria-label"), / 16-page booklet preview$/);
    const pages = await previewPages(driver);
    assert.equal(pages.length, 16, "one preview figure per reader page");
    assert.equal(pages[0].kind, "cover");
    await waitFor(driver, `const img = document.querySelector('[data-testid="bp-page-1"] img.bp-cover'); return Boolean(img && img.complete && img.naturalWidth > 0);`, { message: "cover art on page 1" });
    assert.equal(pages[1].kind, "tracklist");
    for (const [index, title] of TRACKS.entries()) assert.ok(pages[1].blocks.join("\n").includes(`${index + 1}. ${title}`), `tracklist lists ${title}`);
    const lyricText = pages.filter((page) => page.kind === "lyrics").flatMap((page) => page.blocks).join("\n");
    for (const entry of LYRICS) assert.ok(lyricText.includes(entry.lyrics.split("\n")[0]), `lyrics of ${entry.title} are laid out`);
    assert.equal(pages.at(-1).kind, "back");
    assert.equal(await textOf(driver, '[data-testid="booklet-model-page"]'), "Reader page 1");
    assert.ok(await exists(driver, '[data-testid="booklet-model-preview"] canvas'), "printed-object 3D preview renders a canvas");
    const pressed = await layoutButton(driver, 16);
    assert.equal(await pressed.getAttribute("aria-pressed"), "true");
    const counts = await driver.executeScript("return [...document.querySelectorAll('[aria-labelledby=booklet-heading] [data-testid=layout-options] button strong')].map((node) => Number(node.textContent))");
    assert.deepEqual(counts, [8, 12, 16, 20, 24], "only printable booklet counts are offered");
    assert.equal(pages.filter((page) => page.kind === "lyrics").length, 3, "three saved lyric tracks have reader pages");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="export-booklet"]').disabled`), false);
    await tour(driver, "booklet-16-pages", BOOKLET, ["desktop-light", "desktop-dark", "narrow-light", "narrow-dark"]);
    await tour(driver, "booklet-preview", '[data-testid="booklet-preview"]');
  });

  it("tracks without lyrics do not each consume an empty lyrics page", async () => {
    const empty = (await previewPages(driver)).filter((page) => page.kind === "lyrics" && page.blocks.join("").trim() === "");
    assert.deepEqual(empty.map((page) => page.caption), [], "lyric pages with no lyrics");
  });

  it("clicking the paper model turns a leaf", async () => {
    const canvas = await find(driver, '[data-testid="booklet-model-preview"] canvas');
    await driver.executeScript(`arguments[0].scrollIntoView({ block: "center" });`, canvas);
    await canvas.click();
    await waitFor(driver, `return document.querySelector('[data-testid="booklet-model-page"]').textContent !== "Reader page 1"`, {
      timeout: 20_000,
      message: "reader page changes after clicking the model"
    });
    assert.match(await textOf(driver, '[data-testid="booklet-model-page"]'), /^Reader page \d+$/);
  });

  it("8 pages holds three lyric tracks: tracks without lyrics take no page", async () => {
    // The too-few-pages alert and its "Use 12 pages" fix are covered in art-wp5-flows.spec.mjs.
    await click(driver, await layoutButton(driver, 8));
    await waitForText(driver, '[data-testid="booklet-pages"]', "8 pages");
    assert.equal(await exists(driver, '[data-testid="booklet-validation"]'), false);
    assert.equal((await previewPages(driver)).length, 8);
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="export-booklet"]').disabled`), false);
    await tour(driver, "booklet-8-pages", BOOKLET);
    await click(driver, await layoutButton(driver, 16));
    await waitForText(driver, '[data-testid="booklet-pages"]', "16 pages");
  });

  it("exports the booklet PDF through the native save dialog", async () => {
    const target = path.join(artPaths(home).out, "paper-tones-booklet.pdf");
    const dialog = answerFileDialog("save", target);
    await click(driver, '[data-testid="export-booklet"]');
    console.log(await dialog);
    await waitForText(driver, '[data-testid="export-message"]', `Saved ${target}`, { timeout: 60_000 });
    assert.equal(await attrOf(driver, '[data-testid="export-message"]', "class"), "panel-message");
    assert.ok(existsSync(target) && statSync(target).size > 10_000, "PDF written where the user chose");

    const summary = await pdfSummary(target);
    assert.equal(summary.pageCount, 8, "16 reader pages impose onto 8 printed faces");
    assert.ok(summary.pages.every((page) => page.wMm === summary.pages[0].wMm && page.hMm === summary.pages[0].hMm), "every face has the same media size");
    assert.ok(summary.pages[0].wMm > summary.pages[0].hMm, `faces are landscape spreads (${summary.pages[0].wMm}x${summary.pages[0].hMm} mm)`);
    assert.ok(summary.imageCount >= 1, "the cover artwork is embedded");
    const text = pdfText(summary.streams);
    exportedText = text;
    for (const needle of ["Opening Hum", "Outro Fold", "Paper moon over the drive"]) assert.ok(text.includes(needle), `PDF text includes "${needle}"`);
    await tour(driver, "booklet-export-saved", BOOKLET);
  });

  it("padding pages print as blank paper, not with a 'Blank' heading", () => {
    assert.ok(exportedText, "booklet PDF text captured");
    const headings = exportedText.split("\n").filter((line) => /^blank$/i.test(line.trim()));
    assert.deepEqual(headings, [], "printed booklet contains 'Blank' headings");
  });

  it("cancelling the save dialog writes nothing and says it was cancelled", async () => {
    const dialog = answerFileDialog("cancel");
    await click(driver, '[data-testid="export-booklet"]');
    await dialog;
    await waitForText(driver, '[data-testid="export-message"]', /cancel/i, { timeout: 30_000 });
    await tour(driver, "booklet-export-cancelled", '[data-testid="export-booklet"]', ["desktop-light", "narrow-light"]);
  });

  it("Artwork: lists every insert type and shows the front cover on its print guide", async () => {
    await scrollTo(driver, ARTWORK, "start");
    const labels = await driver.executeScript(`return [...document.querySelectorAll('[data-testid="insert-select"] option')].map((o) => o.textContent)`);
    assert.deepEqual(labels, [
      "Front insert",
      "Bi-fold insert",
      "Tri-fold insert",
      "8-page folder",
      "8-page saddle booklet",
      "12-page saddle booklet",
      "16-page saddle booklet",
      "20-page saddle booklet",
      "24-page saddle booklet",
      "Tray card",
      "Disc face"
    ]);
    assert.equal(await attrOf(driver, '[data-testid="slot-stage"]', "data-filled"), "true");
    assert.ok(await attrOf(driver, '[data-testid="print-guide-media"]', "data-component-id"), "front has template geometry");
    for (const guide of ["bleed", "trim", "safety"]) assert.ok(await exists(driver, `[data-testid="print-guide-${guide}"]`), `${guide} guide drawn`);
    await waitFor(driver, `const img = document.querySelector('.print-guide-art img'); return Boolean(img && img.complete && img.naturalWidth > 0);`, { message: "front art on the print guide" });
    assert.match(await textOf(driver, '[data-testid="print-spec-readout"]'), /^Image at least \d+ × \d+ px \(300 dpi\)$/);
    assert.match(await textOf(driver, '[data-testid="guide-readout"]'), /^Print size [\d.]+ × [\d.]+ in · with bleed [\d.]+ × [\d.]+ in$/);
    await tour(driver, "artwork-front", ARTWORK);
  });

  it("Artwork: the researched cover can be placed on the tray card", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "tray");
    assert.equal(await attrOf(driver, '[data-testid="piece-schematic"]', "data-kind"), "tray");
    assert.equal(await exists(driver, ".tray-card img"), false, "tray starts without art");
    await click(driver, '[data-testid="use-researched-cover"]');
    await waitFor(driver, `const img = document.querySelector('.tray-card img'); return Boolean(img && img.complete && img.naturalWidth > 0);`, { message: "tray art renders" });
    await tour(driver, "artwork-tray", ARTWORK);
  });

  it("Artwork: Choose image… copies a file chosen in the native dialog onto the disc", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "disc");
    assert.equal(await attrOf(driver, '[data-testid="slot-stage"]', "data-filled"), "false");
    assert.equal(await attrOf(driver, '[data-testid="assigned-strip"] .assigned-chip:nth-child(3)', "data-filled"), "false");
    await tour(driver, "artwork-disc-empty", ARTWORK, ["desktop-light", "narrow-light"]);
    const file = path.join(artPaths(home).out, "disc-art.png");
    const dialog = answerFileDialog("open", file);
    await click(driver, '[data-testid="pick-image"]');
    console.log(await dialog);
    await waitFor(driver, `return document.querySelector('[data-testid="slot-stage"]').dataset.filled === "true"`, { timeout: 30_000, message: "disc slot filled" });
    await waitFor(driver, `const img = document.querySelector('.disc-face img'); return Boolean(img && img.complete && img.naturalWidth > 0);`, { message: "picked disc art renders (asset protocol scope)" });
    assert.equal(await attrOf(driver, '[data-testid="assigned-strip"] .assigned-chip:nth-child(3)', "data-filled"), "true");
    await tour(driver, "artwork-disc", ARTWORK);
  });

  it("Artwork: a saddle booklet shows its imposition", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "saddle-16");
    assert.equal(await attrOf(driver, '[data-testid="piece-schematic"]', "data-kind"), "booklet");
    assert.ok(await exists(driver, '[data-testid="booklet-page-control"]'));
    assert.equal(await driver.executeScript(`return document.querySelectorAll('[data-testid="imposition-row"]').length`), 8, "16 pages = 4 sheets x 2 faces");
    await tour(driver, "artwork-saddle-16", ARTWORK);
    // The page count is chosen in the Booklet panel only: no 4- or 28-page piece, no local select.
    assert.equal(await exists(driver, '[data-testid="booklet-page-control"] select'), false);
    assert.equal(await textOf(driver, '[data-testid="imposition-preview"] caption'), "How 16 pages print on 4 sheets");
  });

  it("Artwork has no page count of its own: each booklet piece shows its own imposition", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "saddle-24");
    assert.equal(await exists(driver, '[data-testid="booklet-page-control"] select'), false);
    assert.equal(await driver.executeScript(`return document.querySelectorAll('[data-testid="imposition-row"]').length`), 12);
    await scrollTo(driver, BOOKLET, "start");
    assert.equal(await exists(driver, `${BOOKLET} select`), false, "no binding select in the Booklet panel");
    assert.equal(await (await layoutButton(driver, 16)).getAttribute("aria-pressed"), "true");
  });

  it("the studio rail fits a narrow 420 px window without horizontal scrolling", async () => {
    await setWindowSize(driver, SIZES.narrow);
    await scrollTo(driver, BOOKLET, "start");
    const overflow = await horizontalOverflow(driver, '[data-testid="detail-view"]');
    await setWindowSize(driver, SIZES.desktop);
    assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, `page is ${overflow.scrollWidth}px wide in a ${overflow.innerWidth}px window; starts at ${overflow.culprits.join(", ")}`);
  });

  it("booklet size and artwork choices are saved and come back after a relaunch", async () => {
    await click(driver, await layoutButton(driver, 20));
    await waitForText(driver, '[data-testid="booklet-pages"]', "20 pages");
    const saved = await waitForSaved(home, (project) => project.bookletPages === 20 && project.art.some((item) => item.slotId === "disc" && item.imageRef));
    // The project keeps its own copy of a picked picture (copy_art_file).
    const discRef = saved.art.find((item) => item.slotId === "disc").imageRef;
    assert.ok(discRef.startsWith(path.join(artPaths(home).appData, "covers", "picked")), `picked art copied into app data (${discRef})`);
    assert.match(path.basename(discRef), /^[0-9a-f]{16}\.png$/);
    assert.ok(saved.art.some((item) => item.slotId === "saddle-20"), "booklet lyrics recomposed for 20 pages");
    assert.deepEqual(await pageErrors(driver), [], "no page errors before relaunch");
    await app.close();

    app = await startApp({ home, keepHome: true });
    driver = app.driver;
    await openProject(driver, ID);
    await scrollTo(driver, BOOKLET, "start");
    assert.equal(await textOf(driver, '[data-testid="booklet-pages"]'), "20 pages");
    assert.equal((await previewPages(driver)).length, 20);
    assert.equal(await attrOf(driver, '[data-testid="assigned-strip"] .assigned-chip:nth-child(3)', "data-filled"), "true");
  });

  it("a picture picked from outside the app still renders after a relaunch", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "disc");
    assert.equal(await attrOf(driver, '[data-testid="slot-stage"]', "data-filled"), "true");
    let state;
    try {
      await waitFor(driver, `const img = document.querySelector('.disc-face img'); return Boolean(img && img.complete && img.naturalWidth > 0);`, { timeout: 15_000 });
    } catch {
      state = await driver.executeScript(`const img = document.querySelector('.disc-face img'); return img && { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth };`);
    }
    assert.equal(state, undefined, `disc art did not render after relaunch: ${JSON.stringify(state)}`);
  });

  it("a project saved with a page count that has no print template reopens on a printable one", async () => {
    await app.close();
    const stored = readProject(home, ID);
    seedProject(home, { ...stored, bookletPages: 2 });
    app = await startApp({ home, keepHome: false });
    driver = app.driver;
    await openProject(driver, ID);
    await scrollTo(driver, BOOKLET, "start");
    const pages = Number((await textOf(driver, '[data-testid="booklet-pages"]')).split(" ")[0]);
    assert.ok([8, 12, 16, 20, 24].includes(pages), `reopened on ${pages} pages`);
    assert.equal(await (await layoutButton(driver, pages)).getAttribute("aria-pressed"), "true");
    assert.equal(await exists(driver, '[data-testid="booklet-export-reason"]'), false);
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
