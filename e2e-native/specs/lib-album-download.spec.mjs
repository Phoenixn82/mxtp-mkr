// Library area, YouTube-backed album audio through the offline yt-dlp stub and
// the real python sidecar + ffprobe: verified Full album tracklist (music video
// rejected), Download, audio ready forever, playback, Prepare audio with a
// partial match, Burn CD with no writer (never burns), Full-album drag, and
// downloads that outlive relaunches and the deleted project.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { QUIET_HOURS, SINE_PLAYLIST_URL, SINE_WAVE_SUITE, youtubeCatalog } from "../fixtures/lib/catalog.mjs";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  appDataRoot,
  appleLibraryPackage,
  ariaLabel,
  buttonText,
  clickButton,
  domText,
  dragAlbumToBurnList,
  installInvokeGuard,
  openContextMenu,
  invokeLog,
  pngBuffer,
  queueTitles,
  seedAppleLibrary,
  textOf,
  tour,
  visible,
  waitForText,
  waitVisible,
  ytdlpCalls,
  ytdlpStubEnv
} from "../lib/lib.mjs";

describe("album audio from YouTube (offline stub)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-lib-download-"));
  const cover = path.join(home, "youtube-cover.png");
  writeFileSync(cover, pngBuffer([230, 120, 30], 160));
  const catalog = youtubeCatalog({ cover });
  const env = ytdlpStubEnv(home, catalog);
  let app;
  let driver;
  let dataRoot;

  const setCatalog = (next) => writeFileSync(env.MXTP_E2E_YTDLP_CATALOG, JSON.stringify(next, null, 2));
  const projectsDir = () => path.join(dataRoot, "projects");
  const projectFiles = () => (existsSync(projectsDir()) ? readdirSync(projectsDir()).filter((name) => name.endsWith(".json")) : []);
  const sineFolder = () => path.join(dataRoot, "playlists", "Sine Wave Suite");
  const extractCalls = () => ytdlpCalls(home).filter((call) => call.argv.includes("--extract-audio"));
  const states = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row')].map((row) => row.querySelector('.music-download-state')?.textContent ?? '')");
  const rows = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title strong')].map((node) => node.textContent)");

  async function start() {
    app = await launchApp({ home, keepHome: true, env, seed: () => seedAppleLibrary(home, { tracks: [...SINE_WAVE_SUITE, ...QUIET_HOURS] }) });
    driver = app.driver;
    dataRoot = appDataRoot(app.dirs);
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
    await waitVisible(driver, By.css('[data-testid="apple-library"]'), 20_000);
  }

  async function openAlbum(title) {
    if (!(await visible(driver, By.css(".music-album-grid")))) await clickButton(driver, "Albums");
    await (await waitVisible(driver, ariaLabel(`Open ${title}`, "button"))).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    await driver.wait(async () => (await textOf(driver, ".music-album-meta h1")) === title, 5_000);
  }

  async function clearQueue() {
    const clear = await visible(driver, buttonText("Clear burn list"));
    if (clear) await clear.click();
    await driver.wait(async () => (await queueTitles(driver)).length === 0, 3_000);
  }

  async function relaunch() {
    await app.close();
    app = undefined;
    await start();
  }

  before(start);

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("Full album checks a verified release without downloading and drops the music video", async () => {
    setCatalog({ ...catalog, delayMs: { probe: 10_000 } });
    await openAlbum("Sine Wave Suite");
    await (await waitVisible(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"))).click();
    await waitForText(driver, ".music-timing-note", "Checking the release tracklist. Nothing is being downloaded.");
    await tour(driver, "album-detail-full-loading", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    await waitForText(driver, ".music-timing-note", "Showing the verified release tracklist.", 40_000);
    setCatalog(catalog);
    assert.deepEqual(await rows(), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    assert.deepEqual(await states(), ["", "", "", ""]);
    assert.deepEqual(extractCalls(), [], "choosing Full album must not download");
    assert.ok(!(await invokeLog(driver)).some((call) => call.command === "download_playlist_best"));
    await tour(driver, "album-detail-full-verified");
  });

  it("Download fetches only the verified positions and saves the album as audio ready forever", async () => {
    const download = await driver.findElement(buttonText("Download full album"));
    await download.click();
    await driver.wait(async () => /Downloading…|downloaded/.test(await domText(driver, download) + (await textOf(driver, ".music-message"))), 10_000);
    const message = await waitForText(driver, ".music-message", /^Downloaded 4 tracks and saved them as the project Sine Wave Suite\. Burn-list changes now update it\.$/, 120_000);
    assert.equal(message, "Downloaded 4 tracks and saved them as the project Sine Wave Suite. Burn-list changes now update it.");
    const calls = extractCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argv[calls[0].argv.indexOf("--playlist-items") + 1], "1,3,4,5");
    assert.equal(calls[0].argv.at(-1), SINE_PLAYLIST_URL);
    const audio = readdirSync(sineFolder()).filter((name) => name.endsWith(".wav")).sort();
    assert.deepEqual(audio, ["001 - Alpha Tone.wav", "003 - Beta Tone.wav", "004 - Gamma Tone.wav", "005 - Delta Tone.wav"]);
    assert.ok(existsSync(path.join(sineFolder(), "cover.jpg")), "playlist cover was not kept");
    assert.deepEqual(await queueTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    for (const title of ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]) {
      assert.equal(await driver.findElement(ariaLabel(`Play ${title}`, "button")).isEnabled(), true);
    }
    await driver.wait(() => projectFiles().length > 0, 10_000);
    assert.equal(projectFiles().length, 1, `expected one saved album project, found ${projectFiles().join(", ")}`);
    const project = JSON.parse(readFileSync(path.join(projectsDir(), projectFiles()[0]), "utf8"));
    assert.equal(project.saved, true);
    assert.equal(project.kind, "artist");
    assert.deepEqual(project.entry, { artist: "The Oscillators", album: "Sine Wave Suite", formatId: "jewelcase" });
    assert.deepEqual(project.burnQueue.map((item) => item.title), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    assert.ok(project.tracks.every((track) => track.path.startsWith(sineFolder())), "saved tracks must point at the playlist cache");
    const front = project.art.find((slot) => slot.slotId === "front");
    assert.ok(front?.imageRef?.startsWith(path.join(appleLibraryPackage(home), "artwork")), `owned album should keep its Apple artwork, got ${front?.imageRef}`);
    await tour(driver, "album-detail-downloaded");
  });

  it("the Full album tracklist marks the downloaded tracks ready", async () => {
    assert.deepEqual(await states(), ["Audio ready forever", "Audio ready forever", "Audio ready forever", "Audio ready forever"]);
  });

  it("the album card counts the downloaded audio", async () => {
    await clickButton(driver, "← All albums");
    const card = await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    assert.match(await domText(driver, card), /4\/4 audio ready forever/);
    assert.match(await domText(driver, card), /4 tracks/);
  });

  it("a downloaded track plays from the burn list", async () => {
    await driver.findElement(ariaLabel("Play Alpha Tone", "button")).click();
    const player = await waitVisible(driver, By.css('[data-testid="burn-list-audio-player"]'), 5_000, "audio player");
    await driver.wait(async () => (await player.getAttribute("src"))?.startsWith("blob:"), 10_000, "audio never got a blob source");
    await driver.wait(async () => (await driver.executeScript("return arguments[0].readyState", player)) >= 1, 10_000, "audio metadata never loaded");
    const duration = await driver.executeScript("return arguments[0].duration", player);
    assert.ok(Math.abs(duration - 1.5) < 0.1, `unexpected duration ${duration}`);
    await driver.wait(async () => (await textOf(driver, ".music-playback-error")) === "", 5_000, "playback error stayed on screen");
    await driver.executeScript("arguments[0].pause()", player);
    await tour(driver, "burn-list-playing", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("starting playback does not fire a failed load for an empty audio src", async () => {
    const failed = (await pageErrors(driver)).filter((error) => error.message === "failed to load tauri://localhost");
    assert.deepEqual(failed, []);
  });

  it("Download matches only verified audio and names the unmatched track", async () => {
    await clearQueue();
    await openAlbum("Quiet Hours");
    await clickButton(driver, "Select all");
    await clickButton(driver, "Add to burn list");
    await driver.wait(async () => (await queueTitles(driver)).join() === "Midnight,Dawn", 5_000);
    const extractsBefore = extractCalls().length;
    await (await driver.findElement(By.xpath("//div[contains(@class,'music-queue-actions')]/button[starts-with(normalize-space(.), 'Download (')]") )).click();
    const message = await waitForText(driver, ".music-message", /^1 track ready\. Not found on YouTube: Dawn\. Remove unmatched$/, 120_000);
    assert.equal(message, "1 track ready. Not found on YouTube: Dawn. Remove unmatched");
    assert.equal(await driver.findElement(ariaLabel("Play Midnight", "button")).isEnabled(), true);
    assert.equal(await driver.findElement(ariaLabel("Dawn is not downloaded", "button")).isEnabled(), false);
    const downloaded = extractCalls().slice(extractsBefore);
    assert.equal(downloaded.length, 1, "only the verified Midnight upload is downloaded");
    // Quiet Hours has no album playlist: the fallback downloads its vetted single upload.
    assert.equal(downloaded[0].argv.at(-1), "https://www.youtube.com/watch?v=e2eMidnight");
    assert.ok(!downloaded.some((call) => call.argv.includes("https://www.youtube.com/watch?v=e2eDawnVideo")), "a music video was downloaded as album audio");
    await tour(driver, "burn-list-partial", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("Burn CD with no CD writer stops before writing anything", async () => {
    await driver.findElement(ariaLabel("Remove Dawn from burn list", "button")).click();
    await driver.wait(async () => (await queueTitles(driver)).join() === "Midnight", 3_000);
    await clickButton(driver, "Burn CD");
    assert.equal(
      await waitForText(driver, ".music-message", "No CD writer found. You can download the audio now and burn later.", 60_000),
      "No CD writer found. You can download the audio now and burn later."
    );
    const commands = (await invokeLog(driver)).map((call) => call.command);
    assert.ok(commands.includes("list_burners"));
    for (const writer of ["prepare_pcm", "build_cda_image", "burn_cda"]) assert.ok(!commands.includes(writer), `${writer} ran`);
  });

  it("the Full album drag setting adds the verified release with its ready audio", async () => {
    await clearQueue();
    const fullRadio = await driver.findElement(By.xpath("//fieldset[contains(@class,'music-drag-settings')]//label[contains(normalize-space(.),'Full album')]/input"));
    await fullRadio.click();
    assert.equal(await driver.executeScript("return localStorage.getItem('mxtp.albumDragScope')"), "full");
    await clickButton(driver, "Albums");
    await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    await dragAlbumToBurnList(driver, "Sine Wave Suite");
    assert.equal(await waitForText(driver, ".music-message", "added to the burn list", 30_000), "4 tracks added to the burn list.");
    assert.deepEqual(await queueTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
  });

  it("a Full album drag carries the downloaded audio into the burn list", async () => {
    assert.ok(await visible(driver, ariaLabel("Play Delta Tone", "button")), "Delta Tone queued without its downloaded audio");
  });

  it("raised no page errors before relaunch (besides the reported empty-src load)", async () => {
    const errors = (await pageErrors(driver)).filter((error) => error.message !== "failed to load tauri://localhost");
    assert.deepEqual(errors, []);
  });

  it("downloads and the drag setting survive a relaunch", async () => {
    await relaunch();
    const card = await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    await driver.wait(async () => /4\/4 audio ready forever/.test(await domText(driver, card)), 10_000, "badge missing after relaunch");
    const fullChecked = await driver.executeScript("return [...document.querySelectorAll('.music-drag-settings input')].map((input) => input.checked)");
    assert.deepEqual(fullChecked, [false, true]);
  });

  it("downloaded audio outlives the deleted project", async () => {
    await driver.findElement(By.css('nav[aria-label="Music library"] button[data-help-target="projects"]')).click();
    const card = await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    await openContextMenu(driver, card);
    await driver.findElement(By.css('[role="menu"] .danger')).click();
    await waitVisible(driver, By.css('[role="alertdialog"]'));
    await clickButton(driver, "Delete forever");
    await driver.wait(() => projectFiles().length === 0, 10_000, "project file still on disk");
    assert.equal(readdirSync(sineFolder()).filter((name) => name.endsWith(".wav")).length, 4, "deleting the project deleted audio");
    await relaunch();
    const album = await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    await driver.wait(async () => /4\/4 audio ready forever/.test(await domText(driver, album)), 10_000, "audio was not recovered after the project was deleted");
    await openAlbum("Sine Wave Suite");
    assert.deepEqual(await rows(), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    assert.deepEqual(await states(), ["Audio ready forever", "Audio ready forever", "Audio ready forever"]);
    await tour(driver, "album-detail-recovered", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    assert.deepEqual(await pageErrors(driver), []);
  });
});
