import { setFieldValue as typeInto } from "../helpers.mjs";
// Album research and cover art on the real release app: auto-lookup on open,
// real Cover Art Archive artwork + learned theme, lyrics coverage, cover
// direction, Cover chat edits (Cloudflare stub), separate concept (mock image
// adapter), placeholder fallback, busy/error states and the offline cache.
// MusicBrainz/CAA/Cloudflare/FreeLLMAPI are a local stub; other network is a
// dead proxy, so lyrics come from the app's cache (see e2e-native/lib/art.mjs).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { pageErrors, screenshot } from "../helpers.mjs";
import {
  artPaths,
  attrOf,
  click,
  exists,
  find,
  openProject,
  pngSize,
  projectJson,
  readProject,
  rustCacheKey,
  rustSlug,
  scrollTo,
  seedAlbumCache,
  seedLyricsCache,
  seedProject,
  selectValue,
  startApp,
  startStubServer,
  textOf,
  tour,
  waitFor,
  waitForText
} from "../lib/art.mjs";

const ARTIST = "Signal Theory";
const PAPER = {
  id: "rel-paper-tones",
  artist: ARTIST,
  title: "Paper Tones",
  date: "1999-04-12",
  label: "E2E Records",
  tracks: ["Opening Hum", "Static Bloom", "Paper Moon Drive", "Last Carrier"],
  genres: [{ name: "electronic", count: 5 }],
  cover: "ok"
};
const NO_SLEEVE = { id: "rel-no-sleeve", artist: ARTIST, title: "No Sleeve", date: "2002-02-02", label: "E2E Records", tracks: ["Bare One", "Bare Two"], cover: "none" };
const BROKEN = { id: "rel-broken-scan", artist: ARTIST, title: "Broken Scan", date: "2003-03-03", label: "E2E Records", tracks: ["Torn Edge"], cover: "broken" };
const SLOW = { id: "rel-slow-archive", artist: ARTIST, title: "Slow Archive", date: "2005-05-05", label: "E2E Records", tracks: ["Waiting Room"], cover: "ok", delayMs: 9000, colors: [[30, 120, 60], [240, 230, 200]] };
const PROJECT_ID = "e2e-art-paper-tones";

const RESEARCH = 'section[aria-labelledby="research-heading"]';
const REAL_LABEL = "Real album artwork · Cover Art Archive";
const MOCK_LABEL = "Placeholder artwork · mock adapter (not AI-generated)";
const EDIT_LABEL = "Original-cover edit / Cloudflare FLUX.2 Pro";

function imageLoaded(css) {
  return `const img = document.querySelector(${JSON.stringify(css)}); return Boolean(img && img.complete && img.naturalWidth > 0);`;
}

async function waitForLookupIdle(driver, timeout = 90_000) {
  await waitFor(driver, `const b = document.querySelector('[data-testid="run-research"]'); return b && !b.disabled;`, {
    timeout,
    message: "Lookup button enabled again"
  });
}

async function lookup(driver, album) {
  await typeInto(driver, '[data-testid="album-input"]', album);
  await click(driver, '[data-testid="run-research"]');
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).map((name) => path.join(dir, name)) : [];
}

async function waitForProject(home, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = readProject(home, PROJECT_ID);
      if (predicate(last)) return last;
    } catch {
      // being replaced atomically; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`project file never matched; last research=${JSON.stringify(last?.research?.album)}`);
}

describe("album research and cover art (online stub)", () => {
  let stub;
  let app;
  let driver;
  let home;
  let busySnapshot;

  before(async () => {
    stub = await startStubServer();
    for (const album of [PAPER, NO_SLEEVE, BROKEN, SLOW]) stub.addAlbum(album);
    app = await startApp({
      stub,
      env: {
        CLOUDFLARE_ACCOUNT_ID: "e2e-account",
        CLOUDFLARE_API_TOKEN: "e2e-dummy-token",
        MXTP_MKR_CLOUDFLARE_BASE_URL: `${stub.base}/cf`
      },
      seed(_dirs, tempHome) {
        seedProject(tempHome, projectJson({ id: PROJECT_ID, artist: ARTIST, album: PAPER.title }));
        seedLyricsCache(tempHome, ARTIST, "Opening Hum", "First line of the hum\nSecond line of the hum");
        seedLyricsCache(tempHome, ARTIST, "Paper Moon Drive", "Paper moon over the drive\nFold it twice and keep it");
      }
    });
    driver = app.driver;
    home = app.home;
  });

  after(async () => {
    await app?.close();
    await stub?.close();
  });

  it("auto-looks up the album on open: tracklist, real cover, theme, lyrics", async () => {
    await openProject(driver, PROJECT_ID);
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Paper Tones (1999)", { timeout: 90_000 });
    await waitForText(driver, '[data-testid="lyrics-coverage"]', "Lyrics: 2/4 tracks", { timeout: 90_000 });
    await waitForLookupIdle(driver);

    assert.match(await textOf(driver, '[data-testid="research-result"] pre'), /1\. Opening Hum\n2\. Static Bloom\n3\. Paper Moon Drive\n4\. Last Carrier/);
    assert.ok(await exists(driver, '[data-testid="album-theme"]'), "learned album theme is shown");
    assert.ok(await driver.executeScript(imageLoaded('[data-testid="theme-source-art"]')), "original artwork thumbnail renders");
    const swatches = await driver.executeScript(`return document.querySelectorAll('[data-testid="theme-swatches"] i').length`);
    assert.ok(swatches > 0, "palette swatches are shown");
    assert.match(await textOf(driver, '[data-testid="theme-tokens"]'), /artwork$/);
    await waitFor(driver, imageLoaded('[data-testid="cover-thumb"]'), { message: "cover thumbnail renders" });
    assert.equal(await textOf(driver, '[data-testid="cover-provider"]'), REAL_LABEL);
    assert.equal(await exists(driver, '[data-testid="cover-placeholder-note"]'), false, "real art is not labelled as a placeholder");
    assert.ok(await exists(driver, '[data-testid="cover-editor"]'), "Cover chat opens for the real original");
    // One restore control: Cover chat's "Undo edits", disabled while the original is showing.
    assert.equal(await exists(driver, '[data-testid="use-real-cover"]'), false, "no second restore button once the original is loaded");
    assert.equal(await textOf(driver, '[data-testid="reset-original-cover"]'), "Undo edits");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="reset-original-cover"]').disabled`), true);
    // Missing lyrics are a neutral note beside the coverage line, not an error.
    assert.match(await textOf(driver, '[data-testid="lyrics-note"]'), /Lyrics not found for 2 tracks\./);
    assert.equal(await exists(driver, '[data-testid="research-error"]'), false);

    // Applied into the project: status band, front chip, composed inserts.
    await waitForText(driver, '[data-testid="research-applied"]', "Signal Theory - Paper Tones");
    assert.equal(await attrOf(driver, '[data-testid="assigned-strip"] .assigned-chip:nth-child(1)', "data-filled"), "true");
    const coverFile = `${rustSlug(`${stub.base}/img/${PAPER.id}.png`)}.png`;
    const composed = await textOf(driver, '[data-testid="composed-inserts"]');
    assert.match(composed, new RegExp(`front ${coverFile.replace(/[.]/g, "\\.")}`));
    assert.match(composed, /tray 4 tracks/);
    assert.match(composed, /saddle-16 \d+ lyric lines/);

    // Files: real cover upscaled to print size, album cache written, all under the temp TMPDIR.
    const cover = path.join(artPaths(home).covers, coverFile);
    assert.ok(existsSync(cover), `real cover saved at ${cover}`);
    const size = pngSize(cover);
    assert.ok(size.width >= 1536 && size.height >= 1536, `real cover is print-sized (${size.width}x${size.height})`);
    assert.ok(existsSync(path.join(artPaths(home).cache, "album", `${rustCacheKey(`${ARTIST}-${PAPER.title}`)}.json`)), "album cache written");
    assert.ok(stub.requests("/ws/2/release").length >= 2, "MusicBrainz search + detail were called");
    assert.ok(stub.requests("/img/").length >= 1, "cover image was downloaded from the CAA stub");

    // Persisted into the saved project file.
    const saved = await waitForProject(home, (project) => project.research?.album?.album === "Paper Tones");
    assert.equal(saved.research.album.year, 1999);
    assert.equal(saved.research.cover.adapter, "real");
    assert.equal(saved.research.lyricsByTrack.length, 2);
    assert.ok(saved.art.some((item) => item.slotId === "front" && item.imageSource === "research"));

    await tour(driver, "research-real-cover", RESEARCH, ["desktop-light", "desktop-dark", "narrow-light", "narrow-dark"]);
  });

  it("cover direction picker explains each direction", async () => {
    // Cover direction lives inside the "Create a separate concept" details.
    await click(driver, ".cover-concept-actions > summary");
    await selectValue(driver, '[data-testid="cover-direction"]', "archival");
    assert.match(await textOf(driver, '[data-testid="cover-direction-description"]'), /Preserve the source era's restraint/);
    await selectValue(driver, '[data-testid="cover-direction"]', "unexpected-hybrid");
    assert.match(await textOf(driver, '[data-testid="cover-direction-description"]'), /surprising but coherent contrasting medium/);
    await selectValue(driver, '[data-testid="cover-direction"]', "era-adjacent");
    assert.match(await textOf(driver, '[data-testid="cover-direction-description"]'), /plausible sister release/);
    await click(driver, ".cover-concept-actions > summary");
  });

  it("Cover chat: a suggestion fills the box, Ctrl+Enter applies an edit of the original", async () => {
    await scrollTo(driver, '[data-testid="cover-editor"]');
    const applyDisabled = await driver.executeScript(`return document.querySelector('[data-testid="apply-original-edit"]').disabled`);
    assert.equal(applyDisabled, true, "Apply is disabled while the instruction is empty");
    const suggestion = await driver.executeScript(
      `return [...document.querySelectorAll('.cover-editor-suggestions button')].find((b) => b.textContent === "Hand-drawn")`
    );
    await click(driver, suggestion);
    assert.equal(
      await driver.executeScript(`return document.querySelector('[data-testid="cover-edit-instruction"]').value`),
      "Make it more hand-drawn, while preserving the subject and layout."
    );

    const box = await typeInto(driver, '[data-testid="cover-edit-instruction"]', "Add a soft paper grain");
    await box.sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
    await waitForText(driver, '[data-testid="cover-provider"]', EDIT_LABEL, { timeout: 60_000 });
    await waitForText(driver, '[data-testid="cover-edit-history"]', "Add a soft paper grain");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="cover-edit-instruction"]').value`), "");
    await waitFor(driver, imageLoaded('[data-testid="cover-thumb"]'), { message: "edited cover renders" });

    const post = stub.requests("/cf/accounts/e2e-account/ai/run");
    assert.equal(post.length, 1, "one Cloudflare edit request");
    assert.equal(post[0].model, "black-forest-labs/flux-2-pro-preview");
    assert.match(post[0].prompt, /Apply only this change: Add a soft paper grain\./, "the user's instruction reaches the edit model");
    const edited = filesIn(artPaths(home).imagegen).filter((file) => path.basename(file).startsWith("cloudflare-flux2-edit-cover"));
    assert.equal(edited.length, 1, "edited cover written to the imagegen dir");
    assert.ok(pngSize(edited[0]).width >= 1536, "edited cover upscaled to print size");
    await waitForText(driver, '[data-testid="composed-inserts"]', /front cloudflare-flux2-edit-cover/);
    await tour(driver, "cover-chat-edited", '[data-testid="cover-editor"]');
  });

  it("Cover chat: a failed edit leaves the current cover and says so (role=alert)", async () => {
    await typeInto(driver, '[data-testid="cover-edit-instruction"]', "FAILPLEASE make it blue");
    await click(driver, '[data-testid="apply-original-edit"]');
    await waitForText(driver, '[data-testid="cover-edit-error"]', "Could not apply that edit. Your current cover is unchanged.");
    assert.match(await textOf(driver, '[data-testid="cover-edit-error"]'), /stub edit refused/);
    assert.equal(await attrOf(driver, '[data-testid="cover-edit-error"]', "role"), "alert");
    assert.equal(await textOf(driver, '[data-testid="cover-provider"]'), EDIT_LABEL, "cover unchanged after the failure");
    await tour(driver, "cover-chat-error", '[data-testid="cover-editor"]');
  });

  it("Undo edits puts the real album cover back on the front", async () => {
    await click(driver, '[data-testid="reset-original-cover"]');
    await waitForText(driver, '[data-testid="cover-provider"]', REAL_LABEL);
    await waitForText(driver, '[data-testid="composed-inserts"]', new RegExp(`front ${rustSlug(`${stub.base}/img/${PAPER.id}.png`)}\\.png`));
  });

  it("separate concept: generates a labelled placeholder, original stays one click away", async () => {
    const llmBefore = stub.requests("/llm/").length;
    await click(driver, ".cover-concept-actions > summary");
    await click(driver, '[data-testid="generate-grounded-cover"]');
    await waitForText(driver, '[data-testid="cover-provider"]', MOCK_LABEL, { timeout: 60_000 });
    assert.ok(await exists(driver, '[data-testid="cover-placeholder-note"]'), "mock art carries the placeholder note");
    await waitFor(driver, imageLoaded('[data-testid="cover-thumb"]'), { message: "concept renders" });
    await waitForText(driver, '[data-testid="composed-inserts"]', /front mock-cover-/);
    assert.ok(stub.requests("/llm/").length > llmBefore, "vision art direction was attempted (router stub is down -> text prompt)");
    assert.ok(stub.requests("/ws/2/artist").length >= 1, "era references were looked up");
    const generated = filesIn(artPaths(home).imagegen).filter((file) => path.basename(file).startsWith("mock-cover-"));
    assert.equal(generated.length, 1, "one mock concept written");
    assert.ok(pngSize(generated[0]).width >= 1536, "concept is print-sized");
    assert.equal(await textOf(driver, '[data-testid="reset-original-cover"]'), "Undo edits");
    await tour(driver, "research-concept-placeholder", RESEARCH);

    await click(driver, '[data-testid="reset-original-cover"]');
    await waitForText(driver, '[data-testid="cover-provider"]', REAL_LABEL);
  });

  it("album without Cover Art Archive art says so and generates nothing", async () => {
    const conceptsBefore = filesIn(artPaths(home).imagegen).filter((file) => path.basename(file).startsWith("mock-cover-")).length;
    await lookup(driver, NO_SLEEVE.title);
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - No Sleeve (2002)");
    await waitForLookupIdle(driver);
    await waitForText(driver, '[data-testid="real-cover-note"]', "No real cover on Cover Art Archive for this release.");
    assert.equal(await attrOf(driver, '[data-testid="real-cover-note"]', "role"), "status");
    assert.equal(await exists(driver, '[data-testid="cover-provider"]'), false, "no generated art stands in for the real cover");
    assert.equal(await driver.executeScript(`return document.querySelector('.cover-concept-actions').open`), true, "generating stays an explicit choice, shown open");
    const conceptsAfter = filesIn(artPaths(home).imagegen).filter((file) => path.basename(file).startsWith("mock-cover-")).length;
    assert.equal(conceptsAfter, conceptsBefore, "no concept generated by the lookup");
    assert.equal(await exists(driver, '[data-testid="album-theme"]'), false, "no theme without real art");
    assert.equal(await exists(driver, '[data-testid="cover-editor"]'), false, "no Cover chat without an original");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="use-real-cover"]').disabled`), true);
    assert.equal(await attrOf(driver, '[data-testid="use-real-cover"]', "aria-describedby"), "real-cover-note");
    assert.match(await textOf(driver, '[data-testid="lyrics-coverage"]'), /^Lyrics: 0\/2 tracks/);
    await waitForText(driver, '[data-testid="research-applied"]', "Signal Theory - No Sleeve");
    await tour(driver, "research-no-artwork", RESEARCH);
  });

  it("lookup disables its controls while MusicBrainz is slow", async () => {
    await lookup(driver, SLOW.title);
    await waitFor(driver, `return document.querySelector('[data-testid="run-research"]').disabled`, { timeout: 5_000, message: "Lookup disabled" });
    busySnapshot = await driver.executeScript(`
      const button = document.querySelector('[data-testid="run-research"]');
      const panel = document.querySelector(${JSON.stringify(RESEARCH)});
      return {
        buttonText: button.textContent.trim(),
        buttonDisabled: button.disabled,
        // A new lookup clears the old result, so the concept controls are gone while it runs.
        directionDisabled: document.querySelector('[data-testid="cover-direction"]')?.disabled ?? true,
        ariaBusy: panel.getAttribute("aria-busy") || button.getAttribute("aria-busy"),
        statusText: [...panel.querySelectorAll('[role="status"], [aria-live]')].map((el) => el.textContent.trim()).join(" ")
      };
    `);
    assert.equal(busySnapshot.buttonDisabled, true);
    assert.equal(busySnapshot.directionDisabled, true);
    await screenshot(driver, "tour-art-research-loading-desktop-light");
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Slow Archive (2005)", { timeout: 60_000 });
    await waitForLookupIdle(driver);
  });

  it("lookup tells the user it is working (busy text, spinner or aria-busy)", () => {
    assert.ok(busySnapshot, "busy state was captured");
    assert.ok(
      busySnapshot.buttonText !== "Lookup" || busySnapshot.ariaBusy === "true" || /look|search|fetch/i.test(busySnapshot.statusText),
      `no busy indication: ${JSON.stringify(busySnapshot)}`
    );
  });

  it("unknown album shows a research error", async () => {
    await lookup(driver, "Does Not Exist");
    await waitForText(driver, '[data-testid="research-error"]', "Album research failed: MusicBrainz returned no release for Signal Theory - Does Not Exist");
    await waitForLookupIdle(driver);
    await tour(driver, "research-error", RESEARCH);
  });

  it("a failed lookup does not keep showing a different album as the result", async () => {
    const shown = await textOf(driver, '[data-testid="research-result"] strong');
    assert.ok(shown === null || shown.includes("Does Not Exist"), `still showing "${shown}" after looking up "Does Not Exist"`);
  });

  it("real artwork that fails to download is not silently replaced by generated art", async () => {
    await lookup(driver, BROKEN.title);
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Broken Scan (2003)");
    await waitForLookupIdle(driver);
    const provider = await textOf(driver, '[data-testid="cover-provider"]');
    const error = (await textOf(driver, '[data-testid="real-cover-note"]')) ?? "";
    assert.match(error, /^Real cover download failed: /);
    assert.equal(await textOf(driver, '[data-testid="use-real-cover"]'), "Retry");
    const composed = await textOf(driver, '[data-testid="composed-inserts"]');
    assert.ok(
      /cover/i.test(error) || !/mock-cover-|pollinations-/.test(composed),
      `front silently became generated art (provider "${provider}", composed "${composed}", error "${error}")`
    );
  });

  it("re-running lookup for the same album updates the saved research", async () => {
    // Last applied album is Broken Scan; MusicBrainz now reports a corrected date.
    stub.addAlbum({ ...BROKEN, date: "2013-03-03" });
    await lookup(driver, BROKEN.title);
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Broken Scan (2013)");
    await waitForLookupIdle(driver);
    let year;
    try {
      year = (await waitForProject(home, (project) => project.research?.album?.year === 2013, 8_000)).research.album.year;
    } catch {
      year = readProject(home, PROJECT_ID).research?.album?.year;
    }
    assert.equal(year, 2013, "panel shows 2013 but the saved project kept the earlier lookup");
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});

describe("album research offline: MusicBrainz down, cache fallback", () => {
  let stub;
  let app;
  let driver;
  const CACHED = {
    artist: ARTIST,
    album: "Cached Hours",
    year: 2004,
    label: "Cache Label",
    tracks: ["Hour One", "Hour Two", "Hour Three"],
    coverArtUrls: [],
    tags: ["ambient"]
  };

  before(async () => {
    stub = await startStubServer();
    stub.addAlbum({ id: "rel-cached-hours", artist: ARTIST, title: "Cached Hours", date: "2004-01-01", label: "x", tracks: ["x"], cover: "ok" });
    stub.state.mbStatus = 503;
    app = await startApp({
      stub,
      seed(_dirs, tempHome) {
        // The cached album points at real artwork on the (still reachable) CAA stub.
        seedAlbumCache(tempHome, { ...CACHED, coverArtUrls: [`${stub.base}/img/rel-cached-hours.png`] });
        seedLyricsCache(tempHome, ARTIST, "Hour Two", "Two o'clock and counting");
        seedProject(tempHome, projectJson({ id: "e2e-art-cached-hours", artist: ARTIST, album: "Cached Hours" }));
      }
    });
    driver = app.driver;
  });

  after(async () => {
    await app?.close();
    await stub?.close();
  });

  it("falls back to the cached album when MusicBrainz is unavailable", async () => {
    await openProject(driver, "e2e-art-cached-hours");
    await waitForText(driver, '[data-testid="research-result"] strong', "Signal Theory - Cached Hours (2004)", { timeout: 90_000 });
    await waitForText(driver, '[data-testid="lyrics-coverage"]', "Lyrics: 1/3 tracks", { timeout: 90_000 });
    await waitForLookupIdle(driver);
    assert.equal(stub.requests("/ws/2/release", { exact: true }).length, 3, "three MusicBrainz attempts before the cache");
    assert.equal(await textOf(driver, '[data-testid="cover-provider"]'), REAL_LABEL);
    await waitForText(driver, '[data-testid="research-applied"]', "Signal Theory - Cached Hours");
  });

  it("Cover chat without Cloudflare credentials explains what is missing", async () => {
    // cover_edit_available() is false: the chat is shown disabled with the reason beside it.
    await waitForText(driver, '[data-testid="cover-edit-unavailable"]', "Cover edits need Cloudflare Workers AI credentials.");
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="cover-edit-instruction"]').disabled`), true);
    assert.equal(await driver.executeScript(`return document.querySelector('[data-testid="apply-original-edit"]').disabled`), true);
    assert.equal(await attrOf(driver, '[data-testid="cover-edit-instruction"]', "aria-describedby"), "cover-edit-unavailable");
    await tour(driver, "cover-chat-unavailable", '[data-testid="cover-editor"]');
    assert.equal(await textOf(driver, '[data-testid="cover-provider"]'), REAL_LABEL);
  });

  it("no network and no cache: lookup reports the MusicBrainz failure", async () => {
    await lookup(driver, "Never Cached");
    await waitForText(driver, '[data-testid="research-error"]', "Couldn't reach MusicBrainz. Check your internet connection, then click Look up album again.", { timeout: 60_000 });
    assert.equal(await attrOf(driver, '[data-testid="research-error"]', "role"), "alert");
    assert.match(await textOf(driver, '[data-testid="research-error-details"] p'), /MusicBrainz request failed after 3 tries: HTTP 503/);
    assert.doesNotMatch(await textOf(driver, '[data-testid="research-error"]'), /https?:/, "the visible error carries no URL");
    await waitForLookupIdle(driver);
    await tour(driver, "research-offline-error", RESEARCH);
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});

describe("album research against the real internet", { skip: process.env.E2E_LIVE !== "1" && "set E2E_LIVE=1 (real MusicBrainz, CAA, lyrics)" }, () => {
  let app;

  before(async () => {
    app = await startApp({
      online: true,
      env: { MXTP_MKR_MUSICBRAINZ_THROTTLE_MS: "1100" },
      seed(_dirs, tempHome) {
        seedProject(tempHome, projectJson({ id: "e2e-art-live", artist: "Daft Punk", album: "Discovery" }));
      }
    });
  });

  after(async () => app?.close());

  it("looks up Daft Punk - Discovery with real artwork and lyrics", async () => {
    await openProject(app.driver, "e2e-art-live");
    await waitForText(app.driver, '[data-testid="research-result"] strong', /Daft Punk - Discovery \(2001\)/, { timeout: 180_000 });
    await waitForText(app.driver, '[data-testid="lyrics-coverage"]', /Lyrics: \d+\/\d+ tracks/, { timeout: 300_000 });
    assert.equal(await textOf(app.driver, '[data-testid="cover-provider"]'), REAL_LABEL);
    await screenshot(app.driver, "live-art-research-discovery");
  });
});
