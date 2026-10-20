import { startCustomFromLibrary } from "../lib/wp2.mjs";
// Library area, landing without a music library: saved projects list (search
// and filters), format picker, Create with the automatic YouTube album lookup
// (found / not found), and the YouTube playlist URL download in the new
// project (offline yt-dlp stub; no CD writer, so nothing is ever burned).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { SINE_PLAYLIST_URL, youtubeCatalog } from "../fixtures/lib/catalog.mjs";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  appDataRoot,
  buttonText,
  clickButton,
  domText,
  installInvokeGuard,
  invokeLog,
  pngBuffer,
  setFieldValue,
  textOf,
  tour,
  visible,
  waitForText,
  waitVisible,
  ytdlpCalls,
  ytdlpStubEnv
} from "../lib/lib.mjs";

function savedProject({ id, name, artist, album, kind, titles, updatedAt, lastBurnedAt }) {
  const albumKey = `${artist.toLowerCase().replace(/[^a-z0-9]+/g, "")}::${album.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  return {
    id,
    name,
    kind,
    saved: true,
    entry: { artist, album, formatId: "jewelcase" },
    burnQueue: titles.map((title, index) => ({ id: `${id}-${index}`, albumKey, title, artist: artist || "Various", album, durationSec: 180 + index, trackNumber: index + 1 })),
    tracks: [],
    art: [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: lastBurnedAt ? 100 : 0,
    playlistUrl: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt,
    ...(lastBurnedAt ? { lastBurnedAt } : {})
  };
}

const PROJECTS = [
  savedProject({ id: "night-owl-basement-tapes-1", name: "Basement Tapes", artist: "Night Owl", album: "Basement Tapes", kind: "artist", titles: ["Stairs", "Boiler", "Lightbulb"], updatedAt: "2026-09-20T10:00:00.000Z" }),
  savedProject({ id: "mix-road-trip-mix-2", name: "Road Trip Mix", artist: "", album: "Road Trip Mix", kind: "custom", titles: ["Mile One", "Mile Two"], updatedAt: "2026-09-25T10:00:00.000Z", lastBurnedAt: "2026-09-25T09:00:00.000Z" })
];

describe("landing projects and YouTube album lookup", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-lib-landing-"));
  const cover = path.join(home, "youtube-cover.png");
  writeFileSync(cover, pngBuffer([230, 120, 30], 160));
  const env = ytdlpStubEnv(home, youtubeCatalog({ cover }));
  let app;
  let driver;
  let dataRoot;

  const cardTitles = () => driver.executeScript("return [...document.querySelectorAll('[data-testid=recent-projects] .catalog-card strong')].map((node) => node.textContent)");
  const burnMessage = () => textOf(driver, '[data-testid="burn-message"]');

  async function createFromLanding(artist, album) {
    if (!(await visible(driver, By.css('[data-testid="landing-screen"]')))) {
      await driver.findElement(By.css('[data-testid="catalog-button"]')).click();
      const leave = await visible(driver, By.css('[role="alertdialog"]'));
      if (leave) await clickButton(driver, "Discard");
      if (await visible(driver, By.css('[data-testid="apple-library"]'))) await startCustomFromLibrary(driver);
      await waitVisible(driver, By.css('[data-testid="landing-screen"]'));
    }
    const [artistInput, albumInput] = await driver.findElements(By.css(".landing-form .landing-field input"));
    await setFieldValue(driver, artistInput, artist);
    await setFieldValue(driver, albumInput, album);
    await clickButton(driver, "Create album CD");
    await waitVisible(driver, By.css('[data-testid="print-burn"]'), 15_000, "project detail");
    await driver.findElement(By.css(".audio-source-actions details > summary")).click();
  }

  before(async () => {
    app = await launchApp({
      home,
      env,
      seed: (dirs) => {
        const projects = path.join(appDataRoot(dirs), "projects");
        mkdirSync(projects, { recursive: true });
        for (const project of PROJECTS) writeFileSync(path.join(projects, `${project.id}.json`), JSON.stringify(project, null, 2));
      }
    });
    driver = app.driver;
    dataRoot = appDataRoot(app.dirs);
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  });

  after(async () => {
    await app?.close();
  });

  it("lists saved projects newest first with their details", async () => {
    await waitVisible(driver, By.css('[data-testid="landing-screen"]'));
    await driver.wait(async () => (await cardTitles()).length === 2, 10_000, "seeded projects not listed");
    assert.deepEqual(await cardTitles(), ["Road Trip Mix", "Basement Tapes"]);
    const basement = await driver.findElement(By.css('[data-testid="project-card-night-owl-basement-tapes-1"]'));
    assert.equal(await basement.getAttribute("aria-label"), "Open Basement Tapes");
    assert.match(await domText(driver, basement), /Night Owl[\s\S]*3 tracks · 0 lyrics · 16-page booklet[\s\S]*Jewel case · Updated/);
    await tour(driver, "landing-projects");
  });

  it("a custom CD without an artist is not labelled as a recovered playlist", async () => {
    const custom = await driver.findElement(By.css('[data-testid="project-card-mix-road-trip-mix-2"]'));
    assert.doesNotMatch(await domText(driver, custom), /Recovered playlist/);
  });

  it("finds projects by artist or album and filters by kind", async () => {
    const search = await driver.findElement(By.css('[data-testid="recent-projects"] input[type="search"]'));
    await search.sendKeys("night owl");
    await driver.wait(async () => (await cardTitles()).join() === "Basement Tapes", 5_000);
    await setFieldValue(driver, search, "road");
    await driver.wait(async () => (await cardTitles()).join() === "Road Trip Mix", 5_000);
    await setFieldValue(driver, search, "");
    await driver.wait(async () => (await cardTitles()).length === 2, 5_000);
    const filters = await driver.findElement(By.css('[data-testid="recent-projects"] [aria-label="Filter projects"]'));
    await filters.findElement(buttonText("Custom CDs")).click();
    await driver.wait(async () => (await cardTitles()).join() === "Road Trip Mix", 5_000);
    await filters.findElement(buttonText("Artist releases")).click();
    await driver.wait(async () => (await cardTitles()).join() === "Basement Tapes", 5_000);
    await filters.findElement(buttonText("All")).click();
    await driver.wait(async () => (await cardTitles()).length === 2, 5_000);
  });

  it("the format picker switches the 3D case preview", async () => {
    const format = await driver.findElement(By.css(".landing-format-field select"));
    const options = await driver.executeScript("return [...arguments[0].options].map((option) => option.textContent)", format);
    assert.equal(options[0], "Jewel case");
    assert.ok(options.includes("Digipak") && options.includes("Cassette"), options.join(", "));
    await format.findElement(By.css('option[value="digipak"]')).click();
    await driver.wait(async () => (await driver.findElement(By.css('[data-testid="landing-case-model"]')).getAttribute("data-model-id")) === "digipak", 5_000);
    await format.findElement(By.css('option[value="jewelcase"]')).click();
  });

  it("Create album CD looks up the verified YouTube playlist", async () => {
    await createFromLanding("The Oscillators", "Sine Wave Suite");
    const message = await waitForText(driver, '[data-testid="burn-message"]', /^Found|failed/, 60_000);
    assert.equal(message, "Found The Oscillators: Sine Wave Suite (4 tracks). Click Find album audio to download it.");
    assert.equal(await driver.findElement(By.css('[data-testid="playlist-url"]')).getAttribute("value"), SINE_PLAYLIST_URL);
    assert.equal(await textOf(driver, '[data-testid="burner-status"]'), "No CD writer found. Plug one in with a blank CD-R, then click Detect drives.");
    assert.deepEqual(ytdlpCalls(home).filter((call) => call.argv.includes("--extract-audio")), [], "lookup alone must not download");
    await tour(driver, "detail-youtube-found", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("Download playlist loads the audio without burning", async () => {
    await clickButton(driver, "Download playlist");
    await driver.wait(async () => (await driver.findElements(By.css('[data-testid="track-list"] li'))).length > 0, 120_000, "no tracks loaded");
    const titles = await driver.executeScript("return [...document.querySelectorAll('[data-testid=track-list] li .track-title-input')].map((input) => input.value)");
    assert.ok(titles.includes("Alpha Tone") && titles.includes("Delta Tone"), titles.join(" | "));
    await driver.wait(async () => !(await domText(driver, await driver.findElement(By.css('[data-testid="playlist-burn-button"]')))).includes("Working"), 60_000);
    const commands = (await invokeLog(driver)).map((call) => call.command);
    assert.ok(commands.includes("download_playlist_best"));
    for (const writer of ["prepare_pcm", "build_cda_image", "burn_cda"]) assert.ok(!commands.includes(writer), `${writer} ran`);
    const folder = path.join(dataRoot, "playlists", "Sine Wave Suite");
    assert.ok(existsSync(folder), "playlist cache folder missing");
    await tour(driver, "detail-youtube-downloaded", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("the playlist download skips the release's music-video duplicate", async () => {
    const files = readdirSync(path.join(dataRoot, "playlists", "Sine Wave Suite"));
    assert.ok(!files.some((name) => /music video/i.test(name)), `music video downloaded as album audio: ${files.join(", ")}`);
    const titles = await driver.executeScript("return [...document.querySelectorAll('[data-testid=track-list] li .track-title-input')].map((input) => input.value)");
    assert.ok(!titles.some((title) => /music video/i.test(title)), titles.join(" | "));
  });

  it("the download result stays visible after the lyrics lookup", async () => {
    await driver.wait(async () => !/Finding lyrics/.test(await burnMessage()), 30_000);
    assert.match(await burnMessage(), /^4 tracks are audio ready forever\. Click Burn CD when ready\.$/);
  });

  it("a non-YouTube playlist URL is refused before any tool runs", async () => {
    const before = ytdlpCalls(home).length;
    const url = await driver.findElement(By.css('[data-testid="playlist-url"]'));
    await setFieldValue(driver, url, "https://example.com/playlist?list=abc");
    await clickButton(driver, "Download playlist");
    assert.equal(await waitForText(driver, '[data-testid="burn-message"]', "Playlist download failed"), "Playlist download failed: paste a valid YouTube playlist URL");
    assert.equal(ytdlpCalls(home).length, before, "yt-dlp ran for a non-YouTube URL");
  });

  it("an album YouTube does not have reports a clear failure", async () => {
    await createFromLanding("Ghost Band", "Nobody Knows");
    const message = await waitForText(driver, '[data-testid="burn-message"]', /^Found|failed/, 60_000);
    assert.equal(message, "Automatic YouTube match failed: Couldn't find a trustworthy YouTube release for Nobody Knows by Ghost Band: no album playlists came up in the search.");
    assert.equal(await driver.findElement(By.css('[data-testid="playlist-url"]')).getAttribute("value"), "");
    assert.equal(await driver.findElement(By.css('[data-testid="playlist-burn-button"]')).isEnabled(), false);
    await tour(driver, "detail-youtube-failed", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
