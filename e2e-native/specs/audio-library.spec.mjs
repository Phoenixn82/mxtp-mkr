// Library downloads: album download scope (Liked songs / Full album), verified
// release tracklists that reject music-video variants, "Audio ready forever",
// the burn list (keyboard reorder, play, remove, prepare, burn without and with
// a drive, save), and downloaded audio outliving its project across restarts.
// YouTube is a local catalog behind the yt-dlp stand-in; the real
// playlist_fetch.py sidecar, python3, ffmpeg and ffprobe run.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import { pageErrors, screenshot, setTheme, setWindowSize, settle, SIZES } from "../helpers.mjs";
import {
  byAria,
  byTestId,
  buttonByText,
  catalogPlaylist,
  cdrskinCalls,
  clickWhenEnabled,
  dialogCalls,
  launchStudio,
  listProjects,
  playlistsDir,
  resourceFailures,
  seedLibrary,
  setDriveMode,
  stubDialogs,
  tour,
  trackDurations,
  trackTitles,
  typeInto,
  updateCatalog,
  waitForText,
  ytCalls
} from "../lib/audio.mjs";

const ARTIST = "Test Ensemble";
const AURORA = catalogPlaylist({
  id: "PLE2EAURORA",
  title: "Aurora Tones",
  channel: "Test Ensemble - Topic",
  entries: [
    { title: "Dawn Chorus", duration: 5 },
    { title: "Dawn Chorus (Official Music Video)", duration: 5 },
    { title: "Noon Drone", duration: 6 },
    { title: "Dusk Hum", duration: 7 }
  ]
});
// Only two of the album's three songs exist on "YouTube": the album match
// fails its coverage gate and the liked songs are matched one by one.
const NIGHT = catalogPlaylist({
  id: "PLE2ENIGHT",
  title: "Night Signals",
  channel: "Test Ensemble - Topic",
  entries: [
    { title: "Static Bloom", duration: 5 },
    { title: "Relay Hum", duration: 6 }
  ]
});
const CATALOG = { playlists: [AURORA, NIGHT] };

function seedAll(dirs) {
  seedLibrary(dirs, {
    artist: ARTIST,
    albums: [
      { album: "Aurora Tones", tracks: [{ title: "Dawn Chorus", duration: 5, liked: true }, { title: "Noon Drone", duration: 6, liked: true }, { title: "Dusk Hum", duration: 7 }] },
      { album: "Night Signals", tracks: [{ title: "Static Bloom", duration: 5, liked: true }, { title: "Relay Hum", duration: 6, liked: true }, { title: "Late Carrier", duration: 7 }] },
      { album: "Missing Tapes", tracks: [{ title: "Hiss One", duration: 5 }, { title: "Hiss Two", duration: 6 }] },
      { album: "Long Form", tracks: [{ title: "Slow Tide", duration: 2500, liked: true }, { title: "Slower Tide", duration: 2500, liked: true }] }
    ]
  });
}

const albumRows = (driver) => driver.executeScript(
  "return [...document.querySelectorAll('[data-testid=album-detail] .music-track-row')].map((row) => [row.querySelector('.music-track-title strong').textContent, row.querySelector('.music-download-state')?.textContent ?? ''])"
);
const queueTitles = (driver) => driver.executeScript(
  "return [...document.querySelectorAll('.music-queue-item .music-queue-play strong')].map((node) => node.textContent)"
);
const albumCard = (title) => byAria(`Open ${title}`);
const statusMessage = By.css(".music-message[role=status]");

async function showAlbums(driver) {
  await clickWhenEnabled(driver, By.xpath("//nav[@aria-label='Music library']/button[normalize-space(.)='Albums']"));
  await driver.wait(until.elementLocated(By.css(".music-album-grid")), 10_000);
}

async function openAlbum(driver, title) {
  await showAlbums(driver);
  await clickWhenEnabled(driver, albumCard(title));
  await waitForText(driver, By.css("[data-testid=album-detail] h1"), title);
}

async function setScope(driver, scope) {
  await clickWhenEnabled(driver, By.xpath(`//div[@aria-label='Album download scope']/button[${scope === 'Liked songs' ? "starts-with(normalize-space(.), 'My Apple Music songs (')" : "starts-with(normalize-space(.), 'Full album (')"}]`));
  await driver.wait(async () => (await (await driver.findElement(By.xpath(`//div[@aria-label='Album download scope']/button[${scope === 'Liked songs' ? "starts-with(normalize-space(.), 'My Apple Music songs (')" : "starts-with(normalize-space(.), 'Full album (')"}]`))).getAttribute("aria-pressed")) === "true", 5_000);
}

describe("library album downloads and the burn list", () => {
  let app;
  let driver;

  before(async () => {
    app = await launchStudio({ tools: { cdrskin: "none", catalog: CATALOG }, seed: seedAll });
    driver = app.driver;
    await driver.wait(until.elementLocated(byTestId("apple-library")), 20_000);
    await stubDialogs(driver, { confirmBurn: false });
  });

  after(async () => app?.close());

  it("shows the imported library as album cards", async () => {
    await showAlbums(driver);
    // WebKitWebDriver's getText on this draggable card returns only the
    // fallback art's "MXTP"; read the rendered children instead.
    const card = await driver.wait(until.elementLocated(albumCard("Aurora Tones")), 10_000);
    assert.ok(await card.isDisplayed());
    const text = await driver.executeScript("return [...arguments[0].children].map((node) => node.innerText).join('\\n')", card);
    assert.match(text, /Aurora Tones\s+Test Ensemble\s+3 tracks · 0:18/);
    assert.doesNotMatch(text, /audio ready forever/);
    await tour(driver, "library-albums");
  });

  it("opens an album on My Apple Music songs with nothing downloaded yet", async () => {
    await openAlbum(driver, "Aurora Tones");
    const liked = await driver.findElement(By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'My Apple Music songs (')]"));
    assert.equal(await liked.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await albumRows(driver), [["Dawn Chorus", ""], ["Noon Drone", ""]]);
    assert.match(await (await driver.findElement(By.css(".music-timing-note"))).getText(), /^My Apple Music songs are the tracks saved in your Apple Music library/);
    await tour(driver, "album-detail-liked", { focus: byTestId("album-detail") });
  });

  it("Full album checks a verified release tracklist and drops music-video variants", async () => {
    updateCatalog(app.home, { ...CATALOG, delayMs: 9_000 });
    await setScope(driver, "Full album");
    await waitForText(driver, By.css(".music-timing-note"), /^Checking the release tracklist\. Nothing is being downloaded\./);
    await tour(driver, "album-detail-checking", { focus: byTestId("album-detail"), modes: [
      ["desktop-light", { width: 1440, height: 950 }, "light"],
      ["desktop-dark", { width: 1440, height: 950 }, "dark"],
      ["narrow-light", { width: 420, height: 900 }, "light"]
    ] });
    updateCatalog(app.home, CATALOG);
    await waitForText(driver, By.css(".music-timing-note"), /^Showing the verified release tracklist\./, 60_000);
    assert.deepEqual(await albumRows(driver), [["Dawn Chorus", ""], ["Noon Drone", ""], ["Dusk Hum", ""]]);
    assert.equal(ytCalls(app.home).some((call) => call.argv.includes("--extract-audio")), false, "nothing is downloaded while checking");
    await tour(driver, "album-detail-full", { focus: byTestId("album-detail") });
  });

  it("Download fetches the complete album once and marks it audio ready forever", async () => {
    updateCatalog(app.home, { ...CATALOG, delayMs: 4_000 });
    const download = await clickWhenEnabled(driver, buttonByText("Download full album"));
    await driver.wait(async () => (await download.getText()) === "Downloading…", 10_000);
    await waitForText(driver, statusMessage, /^(Finding the complete Test Ensemble — Aurora Tones release on YouTube…|Downloading the complete 3-track release)/);
    await tour(driver, "album-detail-downloading", { focus: byTestId("album-detail"), modes: [
      ["desktop-light", { width: 1440, height: 950 }, "light"],
      ["desktop-dark", { width: 1440, height: 950 }, "dark"],
      ["narrow-light", { width: 420, height: 900 }, "light"]
    ] });
    updateCatalog(app.home, CATALOG);
    await waitForText(driver, statusMessage, "Downloaded 3 tracks and saved them as the project Aurora Tones. Burn-list changes now update it.", 120_000);
    assert.equal(await download.getText(), "Download full album");
    assert.deepEqual(await queueTitles(driver), ["Dawn Chorus", "Noon Drone", "Dusk Hum"]);
    const fetches = ytCalls(app.home).filter((call) => call.argv.includes("--extract-audio"));
    assert.equal(fetches.length, 1, "one download for the album");
    const items = fetches[0].argv[fetches[0].argv.indexOf("--playlist-items") + 1];
    assert.equal(items, "1,3,4", "the music-video entry (position 2) is never downloaded");
    const folder = path.join(playlistsDir(app.dirs), "Aurora Tones");
    assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith(".wav")).sort(), ["001 - Dawn Chorus.wav", "003 - Noon Drone.wav", "004 - Dusk Hum.wav"]);
    const saved = listProjects(app.dirs).find((project) => project.entry.album === "Aurora Tones");
    assert.ok(saved?.saved, "the download is saved as a project");
    assert.deepEqual(saved.burnQueue.map((item) => item.title), ["Dawn Chorus", "Noon Drone", "Dusk Hum"]);
    assert.ok(saved.burnQueue.every((item) => item.ready?.path?.startsWith(folder)));
    await tour(driver, "album-detail-ready", { focus: byTestId("album-detail") });
  });

  it("marks each downloaded track audio ready forever in the Full album view", async () => {
    assert.deepEqual(await albumRows(driver), [["Dawn Chorus", "Audio ready forever"], ["Noon Drone", "Audio ready forever"], ["Dusk Hum", "Audio ready forever"]]);
  });

  it("counts audio ready forever on the album card", async () => {
    await showAlbums(driver);
    assert.match(await (await driver.findElement(albumCard("Aurora Tones"))).getText(), /3\/3 audio ready forever/);
    await tour(driver, "library-albums-ready");
  });

  it("reorders the burn list from the keyboard", async () => {
    const handle = await driver.findElement(byAria("Reorder Dusk Hum"));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'}); arguments[0].focus()", handle);
    await handle.sendKeys(Key.ARROW_UP);
    assert.deepEqual(await queueTitles(driver), ["Dawn Chorus", "Dusk Hum", "Noon Drone"]);
    await (await driver.findElement(byAria("Reorder Dawn Chorus"))).sendKeys(Key.ARROW_DOWN);
    assert.deepEqual(await queueTitles(driver), ["Dusk Hum", "Dawn Chorus", "Noon Drone"]);
  });

  it("plays a downloaded track from the burn list", async () => {
    await clickWhenEnabled(driver, byAria("Play Noon Drone"));
    await driver.wait(
      () => driver.executeScript("const a = document.querySelector('[data-testid=burn-list-audio-player]'); return Boolean(a && a.src.startsWith('blob:') && !a.paused && a.currentTime > 0.2)"),
      15_000,
      "the burn-list player never started"
    );
    assert.equal((await driver.findElements(By.css(".music-playback-error"))).length, 0);
    await tour(driver, "burn-list", { focus: By.css(".music-queue") });
    await driver.executeScript("document.querySelector('[data-testid=burn-list-audio-player]').pause()");
  });

  it("removes a track from the burn list", async () => {
    await clickWhenEnabled(driver, byAria("Remove Dawn Chorus from burn list"));
    assert.deepEqual(await queueTitles(driver), ["Dusk Hum", "Noon Drone"]);
    assert.match(await (await driver.findElement(By.css(".music-queue-head"))).getText(), /2 tracks/);
  });

  it("disables Download when every queued track already has audio", async () => {
    const fetchesBefore = ytCalls(app.home).length;
    assert.equal(await driver.findElement(buttonByText("Download (0)")).isEnabled(), false, "ready audio needs no download");
    assert.equal(ytCalls(app.home).length, fetchesBefore, "nothing new was fetched");
  });

  it("Burn CD without a drive asks for a CD writer", async () => {
    await clickWhenEnabled(driver, By.css(".music-queue-actions button.primary"));
    await waitForText(driver, statusMessage, "No CD writer found. You can download the audio now and burn later.", 30_000);
    assert.equal((await dialogCalls(driver)).length, 0);
    await tour(driver, "burn-list-no-drive", { focus: By.css(".music-queue") });
  });

  it("Burn CD with a drive asks first, and Cancel burns nothing", async () => {
    setDriveMode(app.home, "drive");
    const before = cdrskinCalls(app.home).length;
    await clickWhenEnabled(driver, By.css(".music-queue-actions button.primary"));
    await waitForText(driver, statusMessage, "2 tracks are ready and loaded. Burn canceled. Click Burn CD when you're ready.", 30_000);
    const [confirm] = await dialogCalls(driver);
    assert.match(confirm.message, /Burn “Aurora Tones” — 2 tracks — to the disc in MOCK BURNER\?/);
    assert.deepEqual(cdrskinCalls(app.home).slice(before).map((call) => call.argv), [["--device_links"]], "only the drive probe ran");
    setDriveMode(app.home, "none");
  });

  it("renaming a saved project keeps the burn list's exact order", async () => {
    await typeInto(driver, await driver.findElement(By.css(".music-project-name input")), "Dusk First");
    await driver.findElement(By.css(".music-project-name input")).sendKeys(Key.TAB);
    await waitForText(driver, By.css(".music-project-mode-banner"), "Editing project: Dusk First · changes save automatically");
    let saved;
    await driver.wait(() => (saved = listProjects(app.dirs).find((project) => project.name === "Dusk First")), 10_000);
    assert.deepEqual(saved.burnQueue.map((item) => item.title), ["Dusk Hum", "Noon Drone"]);
    assert.ok(saved.burnQueue.every((item) => item.ready?.path && existsSync(item.ready.path)));
    await tour(driver, "burn-list-project", { focus: By.css(".music-queue") });
  });

  it("an over-capacity burn list cannot be downloaded or burned", async () => {
    await clickWhenEnabled(driver, byTestId("exit-project-button"));
    await waitForText(driver, statusMessage, "The burn list is empty and ready for a new mix.");
    await openAlbum(driver, "Long Form");
    await clickWhenEnabled(driver, buttonByText("Select all"));
    await clickWhenEnabled(driver, buttonByText("Add to burn list"));
    assert.deepEqual(await queueTitles(driver), ["Slow Tide", "Slower Tide"]);
    assert.equal(await (await driver.findElement(By.css(".music-capacity"))).getAttribute("data-over"), "true");
    assert.equal(await (await driver.findElement(By.xpath("//div[contains(@class,'music-queue-actions')]/button[starts-with(normalize-space(.), 'Download (')]"))).isEnabled(), false);
    assert.equal(await (await driver.findElement(By.css(".music-queue-actions button.primary"))).isEnabled(), false);
    await tour(driver, "burn-list-overcap", { focus: By.css(".music-queue") });
  });

  it("says why Download and Burn CD are disabled when the list is too long", async () => {
    const reason = await driver.findElement(By.css("#capacity-reason.music-capacity-reason"));
    assert.match(await reason.getText(), /^Over by \d+:\d\d\. Remove tracks to fit an 80-minute CD\.$/);
    for (const action of [buttonByText("Download (2)"), By.css(".music-queue-actions button.primary")]) {
      assert.ok((await driver.findElement(action).getAttribute("aria-describedby")).split(" ").includes("capacity-reason"));
    }
  });

  it("My Apple Music songs downloads only saved tracks when the album match is incomplete", async () => {
    await clickWhenEnabled(driver, By.xpath("//div[@class='music-queue-head']//button[normalize-space(.)='Clear burn list']"));
    await openAlbum(driver, "Night Signals");
    assert.deepEqual(await albumRows(driver), [["Static Bloom", ""], ["Relay Hum", ""]]);
    await clickWhenEnabled(driver, buttonByText("Download 2 songs"));
    await waitForText(driver, statusMessage, "Downloaded 2 songs. Audio ready forever, saved to the project Night Signals in Projects.", 120_000);
    assert.deepEqual(await albumRows(driver), [["Static Bloom", "Audio ready forever"], ["Relay Hum", "Audio ready forever"]]);
    const searches = ytCalls(app.home).filter((call) => /^ytsearch\d*:/.test(call.argv.at(-1) ?? ""));
    assert.equal(searches.length, 2, "each liked song was matched individually");
    await tour(driver, "album-detail-liked-ready", { focus: byTestId("album-detail") });
    await setScope(driver, "Full album");
    await driver.wait(async () => (await albumRows(driver)).length === 3, 30_000);
    assert.deepEqual(await albumRows(driver), [["Static Bloom", "Audio ready forever"], ["Relay Hum", "Audio ready forever"], ["Late Carrier", ""]]);
  });

  it("falls back to the local tracklist when no release can be verified", async () => {
    await openAlbum(driver, "Missing Tapes");
    const searches = () => ytCalls(app.home).filter((call) => call.argv.includes("--dump-json")).length;
    const before = searches();
    await setScope(driver, "Full album");
    try {
      await waitForText(driver, By.css(".music-timing-note"), /^Could not verify the release tracklist: .+\. Showing your local tracklist\.\s*Retry$/, 15_000);
    } finally {
      assert.ok(searches() - before <= 2, `the album search ran ${searches() - before} times in 15s`);
    }
  });

  it("explains when the complete album cannot be found", async () => {
    if ((await driver.findElements(By.xpath("//div[@data-testid='album-detail']//h1[normalize-space(.)='Missing Tapes']"))).length === 0) {
      await openAlbum(driver, "Missing Tapes");
    }
    await setScope(driver, "Full album");
    await clickWhenEnabled(driver, buttonByText("Download full album"));
    await waitForText(driver, statusMessage, "Could not download the complete album: Couldn't find a trustworthy YouTube release for Missing Tapes by Test Ensemble: no album playlists came up in the search.", 60_000);
    assert.deepEqual(await albumRows(driver), [["Hiss One", ""], ["Hiss Two", ""]]);
    await tour(driver, "album-detail-error", { focus: byTestId("album-detail") });
  });

  it("a saved CD opens on its album tracklist first, and the studio is a separate step", async () => {
    await clickWhenEnabled(driver, By.xpath("//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), 'Projects')]"));
    await clickWhenEnabled(driver, By.xpath("//section[contains(@class,'music-library-view')]//button[.//strong[text()='Dusk First']]"));
    await waitForText(driver, By.id("music-confirm-title"), "Save your burn list first?");
    assert.equal(await driver.findElement(By.id("music-confirm-body")).getText(), "Your 2-track burn list isn't saved. Leaving will clear it.");
    await clickWhenEnabled(driver, By.css(".music-confirm button.danger"));
    await driver.wait(until.elementLocated(byTestId("album-detail")), 10_000);
    assert.equal((await driver.findElements(byTestId("detail-view"))).length, 0, "the 3D studio does not open first");
    assert.deepEqual(await queueTitles(driver), ["Dusk Hum", "Noon Drone"]);
    await clickWhenEnabled(driver, By.css("[data-help-target=cover-studio]"));
    await driver.wait(until.elementLocated(byTestId("detail-view")), 15_000);
    assert.deepEqual(await trackTitles(driver), ["Dusk Hum", "Noon Drone"]);
    assert.deepEqual(await trackDurations(driver), ["0:07", "0:06"]);
    await tour(driver, "studio-from-library", { focus: By.css("[aria-labelledby=audio-heading]") });
    await clickWhenEnabled(driver, byTestId("catalog-button"));
    await driver.wait(until.elementLocated(byTestId("apple-library")), 15_000);
  });

  it("raised no page errors other than the audio player's empty-src load", async () => {
    const failures = await resourceFailures(driver);
    const unexplained = (await pageErrors(driver)).filter((error) => !(error.type === "resource" && error.message === "failed to load tauri://localhost"));
    assert.deepEqual(unexplained, []);
    assert.ok(failures.every((failure) => failure.tag === "audio" && failure.src === ""), `unexpected resource failures ${JSON.stringify(failures)}`);
  });

  it("raised no page errors at all", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});

describe("downloaded audio outlives its projects", () => {
  let home;

  async function relaunch() {
    const app = await launchStudio({ tools: { cdrskin: "none", catalog: CATALOG }, home, keepHome: true });
    await app.driver.wait(until.elementLocated(byTestId("apple-library")), 20_000);
    await stubDialogs(app.driver);
    return app;
  }

  before(async () => {
    // Fresh library + one finished album download, made through the UI.
    const first = await launchStudio({ tools: { cdrskin: "none", catalog: CATALOG }, keepHome: true, seed: seedAll });
    home = first.home;
    try {
      await openAlbum(first.driver, "Aurora Tones");
      await setScope(first.driver, "Full album");
      await waitForText(first.driver, By.css(".music-timing-note"), /^Showing the verified release tracklist/, 60_000);
      await clickWhenEnabled(first.driver, buttonByText("Download full album"));
      await waitForText(first.driver, statusMessage, /^Downloaded 3 tracks and saved them as the project Aurora Tones\. Burn-list changes now update it\.$/, 120_000);
    } finally {
      await first.close();
    }
  });

  it("still shows the album as audio ready forever after a restart", async () => {
    const app = await relaunch();
    try {
      assert.match(await (await app.driver.findElement(albumCard("Aurora Tones"))).getText(), /3\/3 audio ready forever/);
      assert.deepEqual(await pageErrors(app.driver), []);
    } finally {
      await app.close();
    }
  });

  it("keeps the audio ready after the project is deleted and the app restarts", async () => {
    let app = await relaunch();
    try {
      await clickWhenEnabled(app.driver, By.xpath("//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), 'Projects')]"));
      const cardLocator = By.xpath("//section[contains(@class,'music-library-view')]//button[.//strong[text()='Aurora Tones']]");
      await app.driver.wait(until.elementLocated(cardLocator), 10_000);
      const openDeleteDialog = async () => {
        await app.driver.executeScript("arguments[0].focus()", await app.driver.findElement(cardLocator));
        await (await app.driver.findElement(cardLocator)).sendKeys(Key.chord(Key.SHIFT, Key.F10));
        await clickWhenEnabled(app.driver, By.xpath("//div[@role='menu']//button[.//strong[text()='Delete project…']]"));
        await waitForText(app.driver, By.css("#project-delete-description"), "Downloaded audio stays in your library.");
      };
      // The modal covers the theme toggle, so each theme gets its own dialog.
      for (const theme of ["light", "dark"]) {
        await setTheme(app.driver, theme);
        await openDeleteDialog();
        for (const [name, size] of [["desktop", SIZES.desktop], ["narrow", SIZES.narrow]]) {
          await setWindowSize(app.driver, size);
          await settle(app.driver);
          await screenshot(app.driver, `tour-audio-delete-project-dialog-${name}-${theme}`);
        }
        await setWindowSize(app.driver, SIZES.desktop);
        if (theme === "light") {
          await clickWhenEnabled(app.driver, buttonByText("Keep project"));
          await app.driver.wait(() => app.driver.executeScript("return !document.querySelector('[role=alertdialog]')"), 10_000, "delete dialog did not close");
          assert.ok(listProjects({ XDG_DATA_HOME: path.join(home, ".local/share") }).some((project) => project.entry.album === "Aurora Tones"), "Keep project kept it");
        }
      }
      await clickWhenEnabled(app.driver, buttonByText("Delete forever"));
      await app.driver.wait(() => app.driver.executeScript("return !document.querySelector('[role=alertdialog]')"), 10_000, "delete dialog did not close");
      await app.driver.wait(() => !listProjects({ XDG_DATA_HOME: path.join(home, ".local/share") }).some((project) => project.entry.album === "Aurora Tones"), 10_000, "project file was not deleted");
    } finally {
      await app.close();
    }
    app = await relaunch();
    try {
      assert.match(await (await app.driver.findElement(albumCard("Aurora Tones"))).getText(), /3\/3 audio ready forever/);
      await openAlbum(app.driver, "Aurora Tones");
      // The recovered album opens on the two songs in the Apple library.
      await app.driver.wait(async () => JSON.stringify(await albumRows(app.driver)) === JSON.stringify([["Dawn Chorus", "Audio ready forever"], ["Noon Drone", "Audio ready forever"]]), 30_000, "recovered tracks are not ready");
      const fetches = ytCalls(home).filter((call) => call.argv.includes("--extract-audio"));
      assert.equal(fetches.length, 1, "the recovered album was never downloaded again");
      await tour(app.driver, "album-detail-recovered", { focus: byTestId("album-detail") });
      assert.deepEqual(await pageErrors(app.driver), []);
    } finally {
      await app.close();
    }
  });

  after(async () => {
    // keepHome launches leave the temp HOME behind; remove it now.
    const { rmSync } = await import("node:fs");
    if (home) rmSync(home, { recursive: true, force: true });
  });
});
