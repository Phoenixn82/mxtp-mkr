// WP5 on the real release app: album lookup feedback (busy, no real cover,
// failed cover download, unreachable MusicBrainz), the Booklet panel's one
// page-count control and wordless spare pages, and the Artwork slot's print
// size readout, too-small warning and Remove art. Offline: a local stub
// serves MusicBrainz and Cover Art Archive; everything else hits a dead proxy.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pageErrors } from "../helpers.mjs";
import {
  artPaths,
  attrOf,
  buttonByText,
  click,
  dataUri,
  exists,
  find,
  openProject,
  projectJson,
  readProject,
  scrollTo,
  seedProject,
  selectValue,
  startStubServer,
  textOf,
  typeInto,
  waitFor,
  waitForText,
  writePng
} from "../lib/art.mjs";
import { rustCacheKey, seedLyricsCacheHashed, startAppPatient, tourWp5 } from "../lib/wp5.mjs";

const ARTIST = "Signal Theory";
const PAPER = {
  id: "rel-wp5-paper",
  artist: ARTIST,
  title: "Paper Tones",
  date: "1999-04-12",
  label: "E2E Records",
  tracks: ["Opening Hum", "Static Bloom", "Paper Moon Drive", "Last Carrier"],
  genres: [{ name: "electronic", count: 5 }],
  cover: "ok"
};
const NO_SLEEVE = { id: "rel-wp5-none", artist: ARTIST, title: "No Sleeve", date: "2002-02-02", label: "E2E Records", tracks: ["Bare One"], cover: "none" };
const BROKEN = { id: "rel-wp5-broken", artist: ARTIST, title: "Broken Scan", date: "2003-03-03", label: "E2E Records", tracks: ["Torn Edge"], cover: "broken" };
const SLOW = { id: "rel-wp5-slow", artist: ARTIST, title: "Slow Archive", date: "2005-05-05", label: "E2E Records", tracks: ["Waiting Room"], cover: "ok", delayMs: 15_000 };

const RESEARCH_ID = "e2e-wp5-research";
const BOOKLET_ID = "e2e-wp5-booklet";
const RESEARCH = 'section[aria-labelledby="research-heading"]';
const BOOKLET = 'section[aria-labelledby="booklet-heading"]';
const ARTWORK = 'section[aria-labelledby="art-heading"]';
const MOCK_LABEL = "Placeholder artwork · mock adapter (not AI-generated)";
const TRACKS = ["Opening Hum", "Static Bloom", "Paper Moon Drive", "Last Carrier", "Quiet Index", "Outro Fold"];
// Five of six tracks have lyrics: 9 content pages, so 8 pages is too few and
// "Static Bloom" shows that a track without lyrics gets no page.
const LYRICS = [
  { title: "Opening Hum", lyrics: "First line of the hum\nSecond line of the hum\nThird line hums along" },
  { title: "Paper Moon Drive", lyrics: "Paper moon over the drive\nFold it twice and keep it" },
  { title: "Last Carrier", lyrics: "Last carrier home\nSignal fading slow" },
  { title: "Quiet Index", lyrics: "Index the quiet\nFile it under morning" },
  { title: "Outro Fold", lyrics: "Fold the outro\nInto the sleeve" }
];

function seedBookletProject(home) {
  const covers = artPaths(home).covers;
  const coverPath = writePng(path.join(covers, "wp5-real-cover.png"), 1600, 1600, [200, 40, 60], [20, 60, 200]);
  const trayPath = writePng(path.join(covers, "wp5-tray-small.png"), 1600, 1600, [240, 200, 40], [40, 20, 90]);
  const previewPath = writePng(path.join(home, "wp5-preview.png"), 256, 256, [200, 40, 60], [20, 60, 200]);
  const cover = { imagePath: coverPath, previewUrl: dataUri(previewPath), prompt: "real album cover", palette: ["#c8283c", "#143cc8"], adapter: "real" };
  const album = { artist: ARTIST, album: "Paper Index", year: 1999, label: "E2E Records", tracks: TRACKS, coverArtUrls: [], tags: ["electronic"] };
  const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
  seedProject(
    home,
    projectJson({
      id: BOOKLET_ID,
      artist: ARTIST,
      album: "Paper Index",
      research: { album, cover, lyricsByTrack: LYRICS },
      bookletPages: 16,
      art: [
        { slotId: "front", imageRef: coverPath, previewRef: cover.previewUrl, imageSource: "research", transform },
        { slotId: "tray", imageRef: trayPath, imageSource: "manual", transform }
      ]
    })
  );
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function lookup(driver, album) {
  await typeInto(driver, '[data-testid="album-input"]', album);
  await click(driver, '[data-testid="run-research"]');
}

async function waitForLookupIdle(driver, timeout = 90_000) {
  await waitFor(driver, `const b = document.querySelector('[data-testid="run-research"]'); return b && !b.disabled && b.textContent === "Look up album";`, {
    timeout,
    message: "Look up album enabled again"
  });
}

async function waitForSaved(home, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = readProject(home, BOOKLET_ID);
      if (predicate(last)) return last;
    } catch {
      // being replaced atomically
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`saved project never matched (art=${JSON.stringify(last?.art)})`);
}

describe("WP5: research feedback, one booklet page count, artwork slot checks", () => {
  let stub;
  let app;
  let driver;
  let home;

  before(async () => {
    stub = await startStubServer();
    for (const album of [PAPER, NO_SLEEVE, BROKEN, SLOW]) stub.addAlbum(album);
    app = await startAppPatient({
      stub,
      seed(_dirs, tempHome) {
        seedProject(tempHome, projectJson({ id: RESEARCH_ID, artist: ARTIST, album: PAPER.title }));
        seedLyricsCacheHashed(tempHome, ARTIST, "Opening Hum", "First line of the hum\nSecond line of the hum");
        seedBookletProject(tempHome);
      }
    });
    driver = app.driver;
    home = app.home;
  });

  after(async () => {
    await app?.close();
    await stub?.close();
  });

  it("lookup reads the lyrics cache under its hashed key", async () => {
    await openProject(driver, RESEARCH_ID);
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Paper Tones (1999)", { timeout: 90_000 });
    await waitForText(driver, '[data-testid="lyrics-coverage"]', "Lyrics: 1/4 tracks", { timeout: 90_000 });
    await waitForLookupIdle(driver);
    assert.ok(existsSync(path.join(artPaths(home).cache, "album", `${rustCacheKey(`${ARTIST}-${PAPER.title}`)}.json`)), "album cache file is slug + hash");
    assert.match(await textOf(driver, '[data-testid="lyrics-note"]'), /Lyrics not found for 3 tracks\.$/);
  });

  it("lookup shows it is working: Looking up…, aria-busy and a stage line", async () => {
    await lookup(driver, SLOW.title);
    await waitForText(driver, '[data-testid="run-research"]', "Looking up…", { timeout: 10_000 });
    assert.equal(await attrOf(driver, RESEARCH, "aria-busy"), "true");
    assert.equal(await attrOf(driver, '[data-testid="research-stage"]', "role"), "status");
    assert.match(await textOf(driver, '[data-testid="research-stage"]'), /^(Finding the release…|Downloading the real cover…|Lyrics \d+ of \d+…)$/);
    await tourWp5(driver, "research-busy", RESEARCH, ["desktop-light"]);
    await waitForLookupIdle(driver);
    // One slow lookup per remaining mode, so every screenshot shows the busy state.
    for (const mode of ["desktop-dark", "narrow-light"]) {
      await lookup(driver, SLOW.title);
      await waitForText(driver, '[data-testid="run-research"]', "Looking up…", { timeout: 10_000 });
      await tourWp5(driver, "research-busy", RESEARCH, [mode]);
      await waitForLookupIdle(driver);
    }
    assert.equal(await attrOf(driver, RESEARCH, "aria-busy"), "false");
    // The live region stays mounted (so screen readers hear the next lookup) but goes quiet.
    assert.equal((await textOf(driver, '[data-testid="research-stage"]')).trim(), "");
  });

  it("no real cover on Cover Art Archive: says so and generates nothing", async () => {
    const generatedBefore = filesIn(artPaths(home).imagegen).length;
    await lookup(driver, NO_SLEEVE.title);
    await waitForText(driver, '[data-testid="research-result"] strong', /No Sleeve/, { timeout: 90_000 });
    await waitForLookupIdle(driver);
    assert.equal(await textOf(driver, '[data-testid="real-cover-note"]'), "No real cover on Cover Art Archive for this release.");
    assert.equal(await attrOf(driver, '[data-testid="real-cover-note"]', "role"), "status");
    assert.notEqual(await textOf(driver, '[data-testid="cover-provider"]'), MOCK_LABEL, "no placeholder art was generated");
    assert.equal(filesIn(artPaths(home).imagegen).length, generatedBefore, "no image generation ran");
    assert.equal(await driver.executeScript(`return document.querySelector('${RESEARCH} details.cover-concept-actions').open`), true, "concept options are opened, not run");
    const realButton = await find(driver, '[data-testid="use-real-cover"]');
    assert.equal(await realButton.isEnabled(), false);
    assert.equal(await realButton.getAttribute("aria-describedby"), "real-cover-note");
    await tourWp5(driver, "research-no-real-cover", RESEARCH);
  });

  it("a real cover that fails to download is reported with Retry, never replaced by generated art", async () => {
    const generatedBefore = filesIn(artPaths(home).imagegen).length;
    await lookup(driver, BROKEN.title);
    await waitForText(driver, '[data-testid="research-result"] strong', /Broken Scan/, { timeout: 90_000 });
    await waitForLookupIdle(driver);
    await waitForText(driver, '[data-testid="real-cover-note"]', /^Real cover download failed: /);
    assert.equal(await attrOf(driver, '[data-testid="real-cover-note"]', "role"), "alert");
    assert.equal((await textOf(driver, '[data-testid="use-real-cover"]')).trim(), "Retry");
    assert.equal(filesIn(artPaths(home).imagegen).length, generatedBefore, "no image generation ran");
    await tourWp5(driver, "research-cover-failed", RESEARCH);
  });

  it("an unreachable MusicBrainz reads plainly, keeps the raw error in details, and clears the old result", async () => {
    stub.state.mbStatus = 503;
    try {
      await lookup(driver, "Never Cached");
      const message = await waitForText(driver, '[data-testid="research-error"]', /Couldn't reach MusicBrainz/, { timeout: 90_000 });
      assert.equal(message, "Couldn't reach MusicBrainz. Check your internet connection, then click Look up album again.");
      assert.equal(await attrOf(driver, '[data-testid="research-error"]', "role"), "alert");
      assert.doesNotMatch(message, /https?:\/\//, "no URL in the visible error");
      assert.match(await textOf(driver, '[data-testid="research-error-details"]'), /HTTP 503/);
      assert.equal(await exists(driver, '[data-testid="research-result"]'), false, "the previous album is not left on screen");
      await tourWp5(driver, "research-offline", RESEARCH);
    } finally {
      stub.state.mbStatus = 200;
    }
    await waitForLookupIdle(driver);
  });

  it("Booklet panel owns the page count: printable sizes as one segmented control", async () => {
    await click(driver, '[data-testid="catalog-button"]');
    await openProject(driver, BOOKLET_ID);
    await scrollTo(driver, BOOKLET, "start");
    const buttons = await driver.executeScript(
      `return [...document.querySelectorAll(arguments[0] + ' [data-testid="layout-options"] button')].map((b) => ({ text: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed") }))`,
      BOOKLET
    );
    assert.deepEqual(
      buttons.map((button) => button.text),
      ["8 pages, 2 print sheets", "12 pages, 3 print sheets", "16 pages, 4 print sheets", "20 pages, 5 print sheets", "24 pages, 6 print sheets"]
    );
    assert.equal(buttons.find((button) => button.pressed === "true")?.text, "16 pages, 4 print sheets");
    assert.equal(await exists(driver, `${BOOKLET} select`), false, "no binding select");
    assert.equal(await exists(driver, `${BOOKLET} .stepper`), false, "no Add/Remove stepper");
    assert.equal(await exists(driver, '[data-testid="valid-counts"]'), false, "no Valid: line");
    await tourWp5(driver, "booklet-page-count", BOOKLET);
  });

  it("spare pages are plain paper: no heading or folio, captioned Spare page", async () => {
    const spare = await driver.executeScript(`
      return [...document.querySelectorAll('[data-testid="booklet-preview"] figure.bp-page[data-kind="blank"]')].map((figure) => ({
        id: figure.dataset.testid,
        head: Boolean(figure.querySelector(".bp-editorial-head")),
        folio: Boolean(figure.querySelector(".bp-folio")),
        caption: figure.querySelector(".bp-caption").textContent
      }));
    `);
    assert.ok(spare.length > 0, "a 16-page booklet with 5 lyric tracks has spare pages");
    for (const page of spare) {
      assert.equal(page.head, false, `${page.id} has no heading`);
      assert.equal(page.folio, false, `${page.id} has no folio`);
      assert.match(page.caption, /Spare page$/);
    }
    const lyricPages = await driver.executeScript(`return document.querySelectorAll('[data-testid="booklet-preview"] figure.bp-page[data-kind="lyrics"]').length`);
    assert.equal(lyricPages, LYRICS.length, "only tracks with lyrics get lyric pages");
    await tourWp5(driver, "booklet-spare-page", `[data-testid="${spare[0].id}"]`);
  });

  it("too few pages: the alert names the fix and the export button points at it", async () => {
    const layoutButton = (count) =>
      driver.executeScript(
        `return [...document.querySelectorAll(arguments[0] + ' [data-testid="layout-options"] button')].find((b) => b.querySelector("strong").textContent === arguments[1])`,
        BOOKLET,
        String(count)
      );
    await click(driver, await layoutButton(8));
    await waitForText(driver, '[data-testid="booklet-pages"]', "8 pages");
    await waitForText(driver, "#booklet-validation-text", /^Your lyrics need 9 pages; this booklet has 8\. Choose 12 pages\.$/);
    assert.equal(await attrOf(driver, '[data-testid="booklet-validation"]', "role"), "alert");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="export-booklet"]').disabled`), true);
    assert.equal(await attrOf(driver, '[data-testid="export-booklet"]', "aria-describedby"), "booklet-validation-text");
    assert.equal(await attrOf(driver, '[data-testid="export-booklet"]', "title"), null);
    await tourWp5(driver, "booklet-too-few-pages", BOOKLET);
    await click(driver, await buttonByText(driver, "Use 12 pages", '[data-testid="booklet-validation"]'));
    await waitForText(driver, '[data-testid="booklet-pages"]', "12 pages");
    assert.equal(await exists(driver, '[data-testid="booklet-validation"]'), false);
    assert.equal(await (await layoutButton(12)).getAttribute("aria-pressed"), "true");
    await click(driver, await layoutButton(16));
    await waitForText(driver, '[data-testid="booklet-pages"]', "16 pages");
  });

  it("Artwork reads print size in inches and lists only printable booklet sizes", async () => {
    await scrollTo(driver, ARTWORK, "start");
    await waitForText(driver, '[data-testid="guide-readout"]', /^Print size [\d.]+ × [\d.]+ in · with bleed [\d.]+ × [\d.]+ in$/);
    assert.doesNotMatch(await textOf(driver, '[data-testid="guide-readout"]'), /mm|CD\d|UD\d/);
    assert.match(await textOf(driver, '[data-testid="print-spec-readout"]'), /^Image at least \d+ × \d+ px \(300 dpi\)$/);
    const ids = await driver.executeScript(`return [...document.querySelectorAll('[data-testid="insert-select"] option')].map((o) => o.value)`);
    assert.deepEqual(ids.filter((id) => id.startsWith("saddle-")), ["saddle-8", "saddle-12", "saddle-16", "saddle-20", "saddle-24"]);
    assert.equal((await textOf(driver, '[data-testid="pick-image"]')).trim(), "Choose image…");
  });

  it("a 1600 px tray image warns it is too small; the album cover is blocked with a visible reason", async () => {
    await selectValue(driver, '[data-testid="insert-select"]', "tray");
    const warning = await waitForText(driver, '[data-testid="slot-size-warning"]', /^Too small for this piece \(needs \d+ × \d+ px\)\.$/);
    const [needW] = warning.match(/\d+/g).map(Number);
    assert.ok(needW > 1600, `tray needs more than 1600 px wide (${warning})`);
    const useCover = await find(driver, '[data-testid="use-researched-cover"]');
    assert.equal((await useCover.getText()).trim(), "Use album cover from Look up");
    await waitFor(driver, `return document.querySelector('[data-testid="use-researched-cover"]').disabled`, { message: "album cover blocked for the tray" });
    assert.equal(await useCover.getAttribute("aria-describedby"), "use-researched-cover-reason");
    assert.match(await textOf(driver, "#use-researched-cover-reason"), /^The album cover is 1600 × 1600 px, too small for this piece \(needs \d+ × \d+ px\)\.$/);
    await tourWp5(driver, "artwork-too-small", '[data-testid="guide-readout"]');
  });

  it("Remove art clears the slot and the saved project", async () => {
    await click(driver, await buttonByText(driver, "Remove art", ARTWORK));
    await waitFor(driver, `return !document.querySelector('[data-testid="slot-size-warning"]')`, { message: "warning gone" });
    assert.equal(await attrOf(driver, '[data-testid="slot-stage"]', "data-filled"), "false");
    assert.equal(await exists(driver, '[data-testid="remove-art"]'), false);
    await waitForSaved(home, (project) => {
      const tray = project.art.find((item) => item.slotId === "tray");
      return !tray || (!tray.imageRef && !tray.previewRef);
    });
    await tourWp5(driver, "artwork-removed", '[data-testid="guide-readout"]');
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
