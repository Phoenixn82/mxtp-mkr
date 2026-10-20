import { createFromLanding, startCustomFromLibrary } from "../lib/wp2.mjs";
// Studio burn band downloads: the automatic YouTube album match, "Download best +
// Burn CD", "Find album audio", and their error paths. YouTube is a local
// catalog served by the yt-dlp stand-in; the REAL playlist_fetch.py sidecar,
// python3, ffmpeg and ffprobe run. Burns never get past the (stubbed,
// always-cancelled) native confirmation.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import { pageErrors } from "../helpers.mjs";
import {
  byTestId,
  catalogPlaylist,
  clickWhenEnabled,
  dialogCalls,
  launchStudio,
  listProjects,
  makeProject,
  openProjectFromLanding,
  playlistsDir,
  resourceFailures,
  seedArt,
  seedProject,
  setDriveMode,
  slotArt,
  stubDialogs,
  tour,
  trackDurations,
  trackTitles,
  typeInto,
  updateCatalog,
  waitForProjectFile,
  waitForText,
  ytCalls
} from "../lib/audio.mjs";

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
const AURORA_URL = "https://www.youtube.com/playlist?list=PLE2EAURORA";

describe("studio burn band downloads", () => {
  let app;
  let driver;
  const projects = {};

  before(async () => {
    app = await launchStudio({
      tools: { cdrskin: "none", catalog: CATALOG },
      seed(dirs) {
        const art = seedArt(dirs);
        // No audio and no source folder: the studio looks the album up itself.
        projects.auto = seedProject(dirs, makeProject({ id: "e2e-auto", album: "Aurora Tones", tracks: [], art: [], sourcePath: null }));
        projects.chosen = seedProject(dirs, makeProject({
          id: "e2e-chosen-art",
          album: "Night Signals",
          tracks: [],
          art: [slotArt("front", art.front)],
          sourcePath: null
        }));
        projects.untitled = seedProject(dirs, makeProject({ id: "e2e-untitled", artist: "", album: "", tracks: [], art: [], kind: "custom", name: "Untitled mix" }));
      }
    });
    driver = app.driver;
  });

  after(async () => app?.close());

  async function openProject(project) {
    await openProjectFromLanding(driver, project);
    await stubDialogs(driver, { confirmBurn: false });
  }

  it("finds the album on YouTube when a new album CD has no audio yet", async () => {
    await startCustomFromLibrary(driver);
    await createFromLanding(driver, { artist: "Test Ensemble", album: "Aurora Tones" });
    await stubDialogs(driver, { confirmBurn: false });
    const message = await waitForText(driver, byTestId("burn-message"), /^Found .*Aurora Tones \(3 tracks\)\. Click Find album audio to download it\.$/, 30_000);
    assert.match(message, /Test Ensemble/);
    await driver.findElement(By.css(".audio-source-actions details > summary")).click();
    assert.equal(await (await driver.findElement(byTestId("playlist-url"))).getAttribute("value"), AURORA_URL);
    assert.ok(await (await driver.findElement(byTestId("playlist-burn-button"))).isEnabled());
    const search = ytCalls(app.home).find((call) => call.argv.includes("--dump-json"));
    assert.ok(search, "the album search ran through yt-dlp");
    assert.match(decodeURIComponent(search.argv.at(-1)), /Test Ensemble Aurora Tones official album/);
    await clickWhenEnabled(driver, byTestId("save-project-button"));
    await driver.wait(() => (projects.auto = listProjects(app.dirs).find((project) => project.entry.album === "Aurora Tones" && project.id !== "e2e-auto")), 10_000, "new album project never saved");
    await tour(driver, "burn-band-found", { focus: By.css(".audio-source-actions") });
  });

  it("Download playlist audio downloads the playlist into the track list", async () => {
    await clickWhenEnabled(driver, byTestId("playlist-burn-button"));
    const message = await waitForText(driver, byTestId("burn-message"), /^\d+ tracks are audio ready forever\. Click Burn CD when ready\.$/, 90_000);
    const titles = await trackTitles(driver);
    assert.ok(["Dawn Chorus", "Noon Drone", "Dusk Hum"].every((title) => titles.includes(title)), `tracks ${titles}`);
    assert.match(message, new RegExp(`^${titles.length} tracks are audio ready forever\\.`));
    const folder = path.join(playlistsDir(app.dirs), "Aurora Tones");
    assert.ok(existsSync(path.join(folder, ".mxtp-source.json")), "the sidecar marked the playlist cache with its source");
    assert.ok(existsSync(path.join(folder, "cover.jpg")), "the playlist cover was kept as cover.jpg");
    assert.ok(readdirSync(folder).filter((name) => name.endsWith(".wav")).length >= 3);
    // Durations come from ffprobe on the downloaded files.
    const durations = await trackDurations(driver);
    assert.deepEqual(
      titles.map((title, index) => [title, durations[index]]).filter(([title]) => !/video/i.test(title)),
      [["Dawn Chorus", "0:05"], ["Noon Drone", "0:06"], ["Dusk Hum", "0:07"]]
    );
    assert.match(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:(18|23) \/ 79:57/);
    assert.equal((await dialogCalls(driver)).length, 0, "no drive, so no burn confirmation");
    const saved = await waitForProjectFile(app.dirs, projects.auto.id, (project) => project.tracks.length === titles.length);
    assert.ok(saved.tracks.every((track) => track.path.startsWith(folder)), "saved tracks point at the playlist cache");
    await tour(driver, "burn-band-downloaded", { focus: By.css(".audio-source-actions") });
  });

  it("leaves music-video variants out of a downloaded album", async () => {
    const titles = await trackTitles(driver);
    assert.deepEqual(titles, ["Dawn Chorus", "Noon Drone", "Dusk Hum"]);
    const download = ytCalls(app.home).find((call) => call.argv.includes("--extract-audio"));
    assert.ok(download.argv.includes("--playlist-items"), "download restricted to the verified audio positions");
  });

  it("uses the playlist cover as front art when none was chosen", async () => {
    await driver.findElement(By.css("details.status-band > summary")).click();
    await waitForText(driver, byTestId("composed-inserts"), /front cover\.jpg/);
    const front = await driver.executeScript("return document.querySelector('[data-testid=assigned-strip] .assigned-chip').dataset.filled");
    assert.equal(front, "true");
  });

  it("explains a URL that is not a YouTube playlist", async () => {
    const input = await driver.findElement(byTestId("playlist-url"));
    await typeInto(driver, input, "");
    assert.equal(await (await driver.findElement(byTestId("playlist-burn-button"))).isEnabled(), false, "nothing to download without a URL");
    await typeInto(driver, input, "https://example.com/playlist?list=nope");
    await clickWhenEnabled(driver, byTestId("playlist-burn-button"));
    await waitForText(driver, byTestId("burn-message"), "Playlist download failed: paste a valid YouTube playlist URL", 30_000);
    await tour(driver, "burn-band-bad-url", { focus: By.css(".audio-source-actions") });
  });

  it("explains when the YouTube search itself fails", async () => {
    updateCatalog(app.home, { ...CATALOG, failAll: "e2e: YouTube is unreachable" });
    await clickWhenEnabled(driver, byTestId("find-album-burn-button"));
    await waitForText(driver, byTestId("burn-message"), /^YouTube album search failed: YouTube search failed: e2e: YouTube is unreachable$/, 30_000);
    assert.equal(await (await driver.findElement(byTestId("find-album-burn-button"))).getText(), "Find album audio");
    updateCatalog(app.home, CATALOG);
    await tour(driver, "burn-band-search-failed", { focus: By.css(".audio-source-actions") });
  });

  it("Find album audio downloads the album without asking to burn", async () => {
    setDriveMode(app.home, "drive");
    await openProject(projects.chosen);
    await driver.wait(until.elementLocated(byTestId("burner-select")), 15_000);
    const confirmsBefore = (await dialogCalls(driver)).length;
    await clickWhenEnabled(driver, byTestId("find-album-burn-button"));
    await waitForText(driver, byTestId("burn-message"), "2 tracks are audio ready forever. Click Burn CD when ready.", 90_000);
    assert.deepEqual(await trackTitles(driver), ["Static Bloom", "Relay Hum"]);
    const calls = (await dialogCalls(driver)).slice(confirmsBefore);
    assert.equal(calls.length, 0, "downloading never opens burn confirmation");
    await tour(driver, "burn-band-find-album", { focus: By.css(".audio-source-actions") });
  });

  it("keeps burning a separate step after a download", async () => {
    const confirms = (await dialogCalls(driver)).filter((call) => call.title === "Burn CD?");
    assert.equal(confirms.length, 0);
  });

  it("keeps the front cover the person chose", async () => {
    await driver.findElement(By.css("details.status-band > summary")).click();
    const composed = await (await driver.findElement(byTestId("composed-inserts"))).getText();
    assert.match(composed, /front art-front\.png/);
  });

  it("disables Find album audio until the project has an artist and album", async () => {
    await openProject(projects.untitled);
    assert.equal(await (await driver.findElement(byTestId("find-album-burn-button"))).isEnabled(), false);
    await driver.findElement(By.css(".audio-source-actions details > summary")).click();
    assert.equal(await (await driver.findElement(byTestId("playlist-burn-button"))).isEnabled(), false);
    assert.equal((await driver.findElements(byTestId("burn-message"))).length > 0 && /Looking for/.test(await (await driver.findElement(byTestId("burn-message"))).getText()), false, "no automatic lookup without an artist and album");
    await tour(driver, "burn-band-untitled", { focus: By.css(".audio-source-actions") });
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await resourceFailures(driver), []);
    assert.deepEqual(await pageErrors(driver), []);
  });
});

describe("studio burn band with the real cdrskin and no drive", () => {
  let app;

  before(async () => {
    app = await launchStudio({
      tools: { realCdrskin: true },
      seed(dirs) {
        seedProject(dirs, makeProject({ id: "e2e-real-cdrskin", album: "Probe Only", tracks: [], art: [] }));
      }
    });
  });

  after(async () => app?.close());

  it("reports no burner instead of a detection error", async () => {
    await openProjectFromLanding(app.driver, { id: "e2e-real-cdrskin" });
    await waitForText(app.driver, byTestId("burner-status"), "No CD writer found.");
    await clickWhenEnabled(app.driver, byTestId("detect-burners"));
    const message = await waitForText(app.driver, byTestId("burn-message"), /./);
    assert.doesNotMatch(message, /Burner detection failed/);
    assert.equal((await app.driver.findElements(By.css("[data-testid=burner-select]"))).length, 0);
    assert.deepEqual(await pageErrors(app.driver), []);
  });
});
