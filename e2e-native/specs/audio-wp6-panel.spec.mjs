// WP6: studio Audio panel on the real app. Imports append (with probed durations
// and a named failure), the track list reorders by keyboard like the burn list,
// the capacity meter reads against 79:57, and the empty and playing states.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import { pageErrors } from "../helpers.mjs";
import {
  byAria,
  byTestId,
  clickWhenEnabled,
  launchStudio,
  makeProject,
  makeTrack,
  mxtpDir,
  openProjectFromLanding,
  projectsDir,
  resourceFailures,
  seedArt,
  seedProject,
  slotArt,
  stubDialogs,
  trackDurations,
  trackRow,
  trackTitles,
  waitForProjectFile,
  waitForText,
  writeWav
} from "../lib/audio.mjs";
import { tourWp6 } from "../lib/wp6.mjs";

const audioSection = By.css("[aria-labelledby=audio-heading]");

describe("WP6 studio audio panel", () => {
  let app;
  let driver;
  const projects = {};
  let importSources = [];

  before(async () => {
    app = await launchStudio({
      seed(dirs, home) {
        const audio = path.join(mxtpDir(dirs), "e2e-audio");
        const art = seedArt(dirs);
        projects.panel = seedProject(dirs, makeProject({
          id: "wp6-panel",
          tracks: [
            makeTrack(audio, { title: "Alpha Tone", seconds: 5, freq: 440 }),
            makeTrack(audio, { title: "Beta Tone", seconds: 6, freq: 550 }),
            makeTrack(audio, { title: "Gamma Tone", seconds: 7, freq: 660 })
          ],
          art: [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.disc)]
        }));
        projects.empty = seedProject(dirs, makeProject({ id: "wp6-empty", album: "Blank Slate", tracks: [], art: [] }));
        const notAudio = path.join(home, "imports", "liner notes.wav");
        importSources = [
          writeWav(path.join(home, "imports", "Delta Tone.wav"), { seconds: 5, freq: 770 }),
          writeWav(path.join(home, "imports", "Epsilon Tone.wav"), { seconds: 6, freq: 880 }),
          notAudio
        ];
        writeFileSync(notAudio, "these are words, not sound\n");
      }
    });
    driver = app.driver;
  });

  after(async () => app?.close());

  async function openProject(project) {
    await openProjectFromLanding(driver, project);
    await stubDialogs(driver, { confirmBurn: false });
  }

  it("lists tracks with m:ss durations, reorder handles and a 79:57 meter", async () => {
    await openProject(projects.panel);
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    assert.deepEqual(await trackDurations(driver), ["0:05", "0:06", "0:07"]);
    assert.match(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:18 \/ 79:57/);
    const width = await driver.executeScript("return document.querySelector('[data-testid=capacity-meter] .capacity-fill').style.width");
    assert.ok(Math.abs(parseFloat(width) - (18 / (79 * 60 + 57)) * 100) < 0.01, `fill width ${width}`);
    const handles = await driver.findElements(By.css("[data-testid=track-list] .audio-reorder-handle"));
    assert.equal(handles.length, 3);
    assert.equal((await driver.findElements(By.xpath("//*[@data-testid='track-list']//button[normalize-space(.)='Up']"))).length, 0, "no Up buttons");
    assert.equal((await driver.findElements(byTestId("prelisten"))).length, 0, "no 'Now playing' line before anything plays");
    const section = await driver.findElement(audioSection);
    assert.equal(await (await section.findElement(By.css(".panel-head button"))).getText(), "Add audio files…");
    await tourWp6(driver, "audio-panel", { focus: audioSection });
  });

  it("reorders by keyboard on the handle, keeps focus there, and saves the order", async () => {
    const handle = await driver.findElement(byAria("Reorder Alpha Tone"));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'}); arguments[0].focus()", handle);
    await handle.sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Beta Tone,Alpha Tone,Gamma Tone", 5_000, "ArrowDown did not move the track");
    assert.equal(await driver.executeScript("return document.activeElement.getAttribute('aria-label')"), "Reorder Alpha Tone", "focus stays on the moved track's handle");
    await driver.switchTo().activeElement().sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Beta Tone,Gamma Tone,Alpha Tone", 5_000, "second ArrowDown did not move the track");
    await driver.switchTo().activeElement().sendKeys(Key.ARROW_UP, Key.ARROW_UP);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Beta Tone,Gamma Tone", 5_000, "ArrowUp did not move the track back");
    await driver.findElement(byAria("Reorder Gamma Tone")).sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Tone", 5_000);
    await waitForProjectFile(app.dirs, "wp6-panel", (saved) => saved.burnQueue.map((track) => track.title).join() === "Alpha Tone,Gamma Tone,Beta Tone");
  });

  it("shows 'Now playing' only while a track plays, with no empty-src load", async () => {
    const row = await trackRow(driver, "Beta Tone");
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", row);
    await row.findElement(byAria("Play Beta Tone")).click();
    await waitForText(driver, byTestId("prelisten"), "Now playing: Beta Tone");
    await driver.wait(
      () => driver.executeScript("const a = document.querySelector('[data-testid=audio-player]'); return Boolean(a && a.src.startsWith('blob:') && !a.paused && a.currentTime > 0.2)"),
      15_000,
      "the pre-listen player never started playing"
    );
    // The 6 s tone would end during the three screenshots; loop it so they show the playing state.
    await driver.executeScript("document.querySelector('[data-testid=audio-player]').loop = true");
    await tourWp6(driver, "audio-panel-playing", { focus: byTestId("prelisten") });
    assert.equal(await (await driver.findElement(byTestId("prelisten"))).getText(), "Now playing: Beta Tone");
    await driver.executeScript("const a = document.querySelector('[data-testid=audio-player]'); a.loop = false; a.pause()");
    await driver.wait(async () => (await driver.findElements(byTestId("prelisten"))).length === 0, 5_000, "'Now playing' stayed after pause");
    assert.ok((await resourceFailures(driver)).every((failure) => failure.tag !== "audio"), "an <audio> loaded an empty src");
  });

  it("Play after pause restarts the same track, and 'Now playing' follows the player", async () => {
    const row = await trackRow(driver, "Beta Tone");
    // The screenshot tour resizes the window; bring the row out from under the sticky header.
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", row);
    await row.findElement(byAria("Play Beta Tone")).click();
    await waitForText(driver, byTestId("prelisten"), "Now playing: Beta Tone");
    await driver.wait(
      () => driver.executeScript("const a = document.querySelector('[data-testid=audio-player]'); return Boolean(a && !a.paused)"),
      15_000,
      "Play after pause did not restart the player"
    );
    await driver.executeScript("document.querySelector('[data-testid=audio-player]').pause()");
    await driver.wait(async () => (await driver.findElements(byTestId("prelisten"))).length === 0, 5_000, "'Now playing' stayed after pause");
  });

  it("ArrowUp on the first handle moves nothing and does not steal focus later", async () => {
    const first = await driver.findElement(byAria("Reorder Alpha Tone"));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'}); arguments[0].focus()", first);
    await first.sendKeys(Key.ARROW_UP);
    assert.equal((await trackTitles(driver)).join(), "Alpha Tone,Gamma Tone,Beta Tone");
    const title = await driver.findElement(byAria("Edit title for track 3"));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", title);
    await title.click();
    await title.sendKeys(Key.END, "XY");
    await driver.wait(async () => (await title.getAttribute("value")) === "Beta ToneXY", 5_000, "typing into the title lost a key");
    assert.equal(await driver.executeScript("return document.activeElement.getAttribute('aria-label')"), "Edit title for track 3");
    await title.sendKeys(Key.BACK_SPACE, Key.BACK_SPACE);
    await driver.wait(async () => (await title.getAttribute("value")) === "Beta Tone", 5_000);
  });

  it("reorders by dragging a handle onto another row", async () => {
    // WebKitWebDriver has no native HTML5 drag; dispatch the same DOM drag events a pointer drag fires.
    const drag = (sourceLabel, targetIndex) => driver.executeScript(`
      const handle = document.querySelector('[aria-label="' + arguments[0] + '"]');
      const target = document.querySelectorAll('[data-testid=track-list] > li')[arguments[1]];
      const dataTransfer = new DataTransfer();
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      return new Promise((resolve) => setTimeout(() => {
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
        resolve();
      }, 50));
    `, sourceLabel, targetIndex);
    await drag("Reorder Beta Tone", 0);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Beta Tone,Alpha Tone,Gamma Tone", 5_000, "drag did not move the track");
    await drag("Reorder Beta Tone", 2);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Tone", 5_000, "drag back did not move the track");
    await waitForProjectFile(app.dirs, "wp6-panel", (saved) => saved.burnQueue.map((track) => track.title).join() === "Alpha Tone,Gamma Tone,Beta Tone");
  });

  it("appends imported files with probed durations and names the file it could not add", async () => {
    await stubDialogs(driver, { openPaths: importSources });
    const section = await driver.findElement(audioSection);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", section);
    await section.findElement(By.xpath(".//button[normalize-space(.)='Add audio files…']")).click();
    await driver.wait(async () => (await trackTitles(driver)).includes("Epsilon Tone"), 20_000, "imported tracks never appeared");
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Gamma Tone", "Beta Tone", "Delta Tone", "Epsilon Tone"]);
    assert.deepEqual(await trackDurations(driver), ["0:05", "0:07", "0:06", "0:05", "0:06"]);
    assert.match(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:29 \/ 79:57/);
    await waitForText(driver, byTestId("audio-import-error"), "liner notes.wav is not a supported audio file");
    const audioDir = path.join(projectsDir(app.dirs), "wp6-panel", "audio");
    assert.ok(existsSync(path.join(audioDir, "Delta Tone.wav")));
    assert.equal(existsSync(path.join(audioDir, "liner notes.wav")), false, "an unreadable file is not copied into the project");
    const saved = await waitForProjectFile(app.dirs, "wp6-panel", (project) => project.tracks.length === 5);
    assert.deepEqual(saved.tracks.slice(3).map((track) => [track.title, Math.round(track.durationSec), track.sampleRate, track.channels]), [
      ["Delta Tone", 5, 44100, 2],
      ["Epsilon Tone", 6, 44100, 2]
    ]);
    await tourWp6(driver, "audio-panel-imported", { focus: audioSection });
  });

  it("shows an empty state that points at Find album audio", async () => {
    await openProject(projects.empty);
    const empty = await driver.findElement(By.css("[aria-labelledby=audio-heading] .audio-empty"));
    assert.equal(await empty.getText(), "No audio yet. Add WAV, FLAC or MP3 files, or use Find album audio below.");
    assert.match(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:00 \/ 79:57/);
    await tourWp6(driver, "audio-panel-empty", { focus: audioSection });
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await resourceFailures(driver), []);
    assert.deepEqual(await pageErrors(driver), []);
  });
});
