// Library area: Spotify / SoundCloud / YouTube Music export imports through
// the Sources view (real file inputs, real save_imported_music_sources), the
// resulting albums, collections and source tracks, failures, source toggles,
// and persistence across a relaunch.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  FIXTURES,
  REPO_FIXTURES,
  albumCardTitles,
  appDataRoot,
  ariaLabel,
  buttonText,
  chooseFiles,
  clickButton,
  installInvokeGuard,
  sidebarStats,
  textOf,
  tour,
  visible,
  waitForText,
  waitVisible,
  ytdlpCalls,
  ytdlpStubEnv
} from "../lib/lib.mjs";

const SPOTIFY = path.join(REPO_FIXTURES, "spotify-extended-history.json");
const SOUNDCLOUD_JSON = path.join(REPO_FIXTURES, "soundcloud-library.json");
const YOUTUBE_MUSIC = path.join(REPO_FIXTURES, "youtube-music-history.json");
const SOUNDCLOUD_CSV = path.join(FIXTURES, "track-likes.csv");
const BROKEN = path.join(FIXTURES, "broken-export.json");
const UNRELATED = path.join(FIXTURES, "unrelated-export.json");
const notice = (source) => `.music-source-card:nth-child(${["Apple Music", "Spotify", "SoundCloud", "YouTube Music"].indexOf(source) + 1}) .music-source-message`;

describe("library imports (Spotify, SoundCloud, YouTube Music)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-lib-sources-"));
  // An empty catalog: any YouTube lookup fails offline instead of reaching the network.
  const env = ytdlpStubEnv(home, { albums: [], videos: [] });
  let app;
  let driver;
  let librariesFile;
  const uploadModes = new Set();
  let fullLookups = 0;
  const rows = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title strong')].map((node) => node.textContent)");

  async function start() {
    app = await launchApp({ home, keepHome: true, env });
    driver = app.driver;
    librariesFile = path.join(appDataRoot(app.dirs), "libraries.json");
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  }

  async function sourceInput(label) {
    return driver.findElement(By.xpath(`//article[.//h2='${label}']//input[@type='file']`));
  }

  async function importFile(label, file) {
    uploadModes.add(await chooseFiles(driver, await sourceInput(label), [file]));
  }

  async function sourceCards() {
    return driver.executeScript(`return [...document.querySelectorAll('.music-source-card')].map((card) => ({
      name: card.querySelector('h2').textContent, status: card.querySelector('header span').textContent,
      action: (card.querySelector('.music-import-button span, button') || {}).textContent }))`);
  }

  async function savedSources() {
    return JSON.parse(readFileSync(librariesFile, "utf8"));
  }

  before(async () => {
    await start();
    await clickButton(driver, "Import music sources");
    await waitVisible(driver, By.css('[data-testid="apple-library"]'));
    await clickButton(driver, "Music sources");
    await waitVisible(driver, By.css('[data-testid="music-sources"]'));
  });

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("imports a Spotify Extended Streaming History export", async () => {
    await importFile("Spotify", SPOTIFY);
    assert.equal(await waitForText(driver, notice("Spotify"), "Spotify imported"), "Spotify imported: 2 tracks. Your albums now include them.");
    const status = await driver.findElement(By.css(".music-source-message"));
    assert.doesNotMatch(await status.getAttribute("class"), /\berror\b/);
    const spotify = (await sourceCards()).find((card) => card.name === "Spotify");
    assert.deepEqual(spotify, { name: "Spotify", status: "Imported", action: "Replace Spotify export" });
    assert.deepEqual(await sidebarStats(driver), ["2 songs", "1 album", "3 plays"]);
    const saved = await savedSources();
    assert.deepEqual(saved.map((source) => source.source), ["spotify"]);
    assert.deepEqual(saved[0].tracks.map((track) => track.title).sort(), ["Them Bones", "Would?"]);
    assert.equal(saved[0].tracks.find((track) => track.title === "Would?").playCount, 2);
    await tour(driver, "sources-imported");
  });

  it("a broken export is rejected with a visible error and nothing is lost", async () => {
    const before = readFileSync(librariesFile, "utf8");
    await importFile("Spotify", BROKEN);
    assert.equal(await waitForText(driver, `${notice("Spotify")} > p`, "Could not import"), "Could not import that Spotify export. Your previous Spotify import is unchanged.");
    const details = await driver.findElement(By.css(`${notice("Spotify")} details`));
    await details.findElement(By.css("summary")).click();
    assert.equal(await textOf(driver, `${notice("Spotify")} details p`), "broken-export.json is not valid JSON.");
    await details.findElement(By.css("summary")).click();
    assert.match(await driver.findElement(By.css(".music-source-message")).getAttribute("class"), /\berror\b/);
    assert.equal(readFileSync(librariesFile, "utf8"), before, "a failed import rewrote libraries.json");
    assert.deepEqual(await sidebarStats(driver), ["2 songs", "1 album", "3 plays"]);
    await tour(driver, "sources-import-error", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("imports a SoundCloud account JSON export with album metadata", async () => {
    await importFile("SoundCloud", SOUNDCLOUD_JSON);
    assert.equal(await waitForText(driver, notice("SoundCloud"), "SoundCloud imported"), "SoundCloud imported: 2 tracks. Your albums now include them.");
    assert.deepEqual(await sidebarStats(driver), ["4 songs", "3 albums", "3 plays"]);
  });

  it("replacing SoundCloud with a track-likes.csv archive swaps its tracks", async () => {
    await importFile("SoundCloud", SOUNDCLOUD_CSV);
    assert.equal(await waitForText(driver, notice("SoundCloud"), "SoundCloud imported"), "SoundCloud imported: 2 tracks. Your albums now include them.");
    const soundcloud = (await savedSources()).find((source) => source.source === "soundcloud");
    assert.deepEqual(soundcloud.tracks.map((track) => track.title).sort(), ["Square Wave Morning", "Triangle, Slowly"]);
    assert.ok(soundcloud.tracks.every((track) => track.sourceStats[0].liked), "track-likes.csv rows must be liked");
  });

  it("imports YouTube Music watch history and skips non-music viewing", async () => {
    await importFile("YouTube Music", YOUTUBE_MUSIC);
    assert.equal(await waitForText(driver, notice("YouTube Music"), "YouTube Music imported"), "YouTube Music imported: 1 track. Your albums now include them.");
    const youtube = (await savedSources()).find((source) => source.source === "youtubeMusic");
    assert.deepEqual(youtube.tracks.map((track) => [track.title, track.artist]), [["Superunknown", "Soundgarden"]]);
  });

  it("an export with no music records names the source and keeps the previous import", async () => {
    const before = readFileSync(librariesFile, "utf8");
    await importFile("YouTube Music", UNRELATED);
    assert.equal(
      await waitForText(driver, `${notice("YouTube Music")} > p`, "Could not import"),
      "Could not import that YouTube Music export. Your previous YouTube Music import is unchanged."
    );
    const details = await driver.findElement(By.css(`${notice("YouTube Music")} details`));
    await details.findElement(By.css("summary")).click();
    assert.equal(await textOf(driver, `${notice("YouTube Music")} details p`), "No YouTube Music music records were recognized in those files.");
    await details.findElement(By.css("summary")).click();
    assert.equal(readFileSync(librariesFile, "utf8"), before);
  });

  it("the Albums grid shows real albums, source tracks and the collection", async () => {
    await clickButton(driver, "Albums");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 4, 10_000, "grid never showed 4 cards");
    assert.deepEqual((await albumCardTitles(driver)).sort(), ["Dirt", "Square Wave Morning", "Triangle, Slowly", "YouTube Music collection"]);
    assert.equal(await textOf(driver, ".music-section-heading h1"), "Albums + imported tracks");
    assert.equal(await textOf(driver, ".music-section-heading p"), "4 albums and imported tracks");
    const toggles = await driver.executeScript(`return [...document.querySelectorAll('.music-source-toggles label')].map((label) => [
      label.querySelector('span').textContent, label.querySelector('input').checked, label.querySelector('input').disabled, label.querySelector('small').textContent])`);
    assert.deepEqual(toggles, [
      ["Spotify", true, false, "2"],
      ["SoundCloud", true, false, "2"],
      ["YouTube Music", true, false, "1"]
    ]);
    await tour(driver, "albums-imported");
  });

  it("turning a source off removes its music and turning it on restores it", async () => {
    const spotifyToggle = await driver.findElement(By.xpath("//div[contains(@class,'music-source-toggles')]//label[span='Spotify']/input"));
    await spotifyToggle.click();
    await driver.wait(async () => !(await albumCardTitles(driver)).includes("Dirt"), 5_000, "Dirt stayed after turning Spotify off");
    assert.deepEqual(await sidebarStats(driver), ["3 songs", "0 albums", "1 play"]);
    await spotifyToggle.click();
    await driver.wait(async () => (await albumCardTitles(driver)).includes("Dirt"), 5_000, "Dirt did not come back");
    assert.deepEqual(await sidebarStats(driver), ["5 songs", "1 album", "4 plays"]);
  });

  it("an imported album opens on Full album with its local tracklist fallback", async () => {
    const searchesBefore = ytdlpCalls(home).length;
    await driver.findElement(ariaLabel("Open Dirt", "button")).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    assert.equal(await textOf(driver, ".music-album-meta h1"), "Dirt");
    assert.equal(await textOf(driver, ".music-album-meta h2"), "Alice in Chains");
    const full = await driver.findElement(By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"));
    assert.equal(await full.getAttribute("aria-pressed"), "true");
    await tour(driver, "album-detail-imported-liked", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    await (await waitVisible(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"))).click();
    await driver.wait(async () => (await rows()).length === 2, 5_000);
    assert.deepEqual(await rows(), ["Them Bones", "Would?"]);
    const sources = await driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title small')].map((node) => node.textContent)");
    assert.ok(sources.every((text) => text.endsWith("Spotify")), `rows should credit Spotify: ${sources}`);
    // Give the (failing, offline) release lookup time to settle.
    await waitForText(driver, ".music-timing-note", /^Could not verify the release tracklist: .+\. Showing your local tracklist\.\s*Retry$/);
    fullLookups = ytdlpCalls(home).length - searchesBefore;
    console.log(`release lookups across the album tour: ${fullLookups}`);
    assert.ok(!ytdlpCalls(home).some((call) => call.argv.includes("--extract-audio")), "Full album downloaded audio");
  });

  it("a failed release lookup settles on the local tracklist instead of retrying forever", async () => {
    assert.ok(fullLookups <= 2, `yt-dlp ran ${fullLookups} times for one album visit`);
    assert.match(await textOf(driver, ".music-timing-note"), /^Could not verify the release tracklist: .+\. Showing your local tracklist\.\s*Retry$/);
  });

  it("the liked-scope empty message names the right source for imported albums", async () => {
    await driver.findElement(By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'My Apple Music songs (')]")).click();
    const empty = await textOf(driver, '[data-testid="album-detail"] .music-empty');
    assert.equal(empty, "No songs from this album are in your Apple Music library. It came from Spotify. Choose Full album to see the release.");
  });

  it("a SoundCloud source track opens with its own detail and no invented album", async () => {
    await clickButton(driver, "← All albums");
    await driver.findElement(ariaLabel("Open Square Wave Morning", "button")).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    assert.equal(await textOf(driver, ".music-album-meta > span"), "SoundCloud track");
    assert.equal(await textOf(driver, ".music-album-meta h2"), "oscillator club");
    assert.equal(await visible(driver, ariaLabel("Album download scope")), undefined, "source tracks have no liked/full scope");
    assert.match(await textOf(driver, ".music-timing-note"), /MXTP never invents an album for it\./);
    await tour(driver, "album-detail-source-track", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("the YouTube Music collection groups tracks without album metadata", async () => {
    await clickButton(driver, "← All albums");
    await driver.findElement(ariaLabel("Open YouTube Music collection", "button")).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    assert.equal(await textOf(driver, ".music-album-meta > span"), "Collection");
    const rows = await driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title strong')].map((node) => node.textContent)");
    assert.deepEqual(rows, ["Superunknown"]);
    assert.match(await textOf(driver, ".music-timing-note"), /instead of inventing albums/);
    await tour(driver, "album-detail-collection");
  });

  it("raised no page errors before relaunch", async () => {
    console.log(`file chooser path used: ${[...uploadModes].join(", ")}`);
    assert.deepEqual(await pageErrors(driver), []);
  });

  it("imports persist across a relaunch and the library opens directly", async () => {
    await app.close();
    app = undefined;
    await start();
    await waitVisible(driver, By.css('[data-testid="apple-library"]'), 20_000);
    await driver.wait(async () => (await albumCardTitles(driver)).length === 4, 10_000);
    await clickButton(driver, "Music sources");
    const cards = await sourceCards();
    assert.deepEqual(cards.map((card) => [card.name, card.status]), [
      ["Apple Music", "Not found on this PC"],
      ["Spotify", "Imported"],
      ["SoundCloud", "Imported"],
      ["YouTube Music", "Imported"],
      ["Audio files on this PC", "On this PC"]
    ]);
    const importedAt = await driver.executeScript("return [...document.querySelectorAll('.music-source-card > small')].map((node) => node.textContent)");
    assert.equal(importedAt.length, 3);
    assert.ok(importedAt.every((text) => text.startsWith("Imported ")), importedAt.join(" | "));
    assert.deepEqual(await pageErrors(driver), []);
  });
});
