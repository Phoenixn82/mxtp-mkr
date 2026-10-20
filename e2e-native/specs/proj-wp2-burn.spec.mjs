// WP2 studio <-> burn list on the real app: the studio plays, exports and
// burns the project's burn list in its order, a reorder in the studio reaches
// the library, a track removed in the library leaves the studio, an export
// runs once per click, and a burned project says "Last burned" instead of a
// simulation percentage. Burns never write: GO is simulate-only and the
// cdrskin stand-in refuses every write flag.
//
// Recent projects open their album layout first; opening the studio is explicit.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { pageErrors } from "../helpers.mjs";
import {
  byTestId,
  clickWhenEnabled,
  launchStudio,
  makeProject,
  makeTrack,
  mxtpDir,
  seedArt,
  seedProject,
  slotArt,
  stubDialogs,
  trackTitles,
  waitForProjectFile,
  waitForText
} from "../lib/audio.mjs";
import { openProjectStudio, scrollToTop, tourWp2 } from "../lib/wp2.mjs";


const queueTitles = (driver) =>
  driver.executeScript("return [...document.querySelectorAll('.music-queue-item .music-queue-play strong')].map((node) => node.textContent)");

/** Record every backend command (and its args) the page sends from now on. */
async function spyInvokes(driver) {
  await driver.executeScript(`
    const internals = window.__TAURI_INTERNALS__;
    window.__wp2Calls = [];
    window.__MXTP_INVOKE__ = (command, args) => {
      window.__wp2Calls.push({ command, args: args ?? null });
      return internals.invoke(command, args ?? {});
    };
  `);
}
const invokes = (driver, command) =>
  driver.executeScript("return (window.__wp2Calls || []).filter((call) => call.command === arguments[0])", command);

/** Page errors, minus the pre-listen player's known empty-src load (tracked in audio-panel.spec). */
const unexplainedErrors = async (driver) =>
  ((await pageErrors(driver)) ?? []).filter((error) => !(error.type === "resource" && error.message === "failed to load tauri://localhost"));

const burnItems = (tracks, artist, album) =>
  tracks.map((track) => ({ id: `item-${track.id}`, albumKey: `${artist}::${album}`.toLowerCase(), title: track.title, artist, album, durationSec: track.durationSec, ready: track }));

describe("wp2 burn list in the studio", () => {
  let app;
  let driver;
  const projects = {};

  before(async () => {
    app = await launchStudio({
      tools: { cdrskin: "none" },
      seed(dirs) {
        const audio = path.join(mxtpDir(dirs), "e2e-wp2-audio");
        const art = seedArt(dirs);
        const allArt = [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.disc)];
        const tracks = [
          makeTrack(audio, { title: "Alpha Tone", seconds: 5, freq: 440 }),
          makeTrack(audio, { title: "Beta Tone", seconds: 5, freq: 550 }),
          makeTrack(audio, { title: "Gamma Tone", seconds: 5, freq: 660 })
        ];
        projects.mix = seedProject(dirs, makeProject({
          id: "e2e-wp2-mix",
          album: "Order Matters",
          tracks,
          burnQueue: burnItems(tracks, "Test Ensemble", "Order Matters"),
          art: allArt
        }));
        projects.burned = seedProject(dirs, makeProject({
          id: "e2e-wp2-burned",
          album: "Already Burned",
          tracks: [tracks[0]],
          art: allArt,
          burnProgress: 100,
          lastBurnedAt: "2026-10-01T18:30:00.000Z"
        }));
      }
    });
    driver = app.driver;
  });

  after(async () => app?.close());

  it("a studio reorder shows up in the library burn list in the same order", async () => {
    await openProjectStudio(driver, projects.mix);
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    const handle = await driver.findElement(By.css('[data-testid="track-list"] [aria-label="Reorder Gamma Tone"]'));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", handle);
    await handle.sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Tone", 10_000, "studio order never changed");
    const saved = await waitForProjectFile(app.dirs, projects.mix.id, (project) => project.burnQueue.map((item) => item.title).join() === "Alpha Tone,Gamma Tone,Beta Tone");
    assert.equal(saved.burnQueue.length, 3, "a reorder keeps every burn-list item");
    await clickWhenEnabled(driver, byTestId("catalog-button"));
    await driver.wait(async () => (await queueTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Tone", 10_000, "the library burn list kept the old order");
  });

  it("a track removed in the library is not burned or printed by the studio", async () => {
    await clickWhenEnabled(driver, By.css('[aria-label="Remove Beta Tone from burn list"]'));
    await driver.wait(async () => !(await queueTitles(driver)).includes("Beta Tone"), 10_000, "Beta Tone stayed in the burn list");
    await waitForProjectFile(app.dirs, projects.mix.id, (project) => project.burnQueue.every((item) => item.title !== "Beta Tone"));
    await openProjectStudio(driver, projects.mix);
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Gamma Tone"]);
    await spyInvokes(driver);
    await clickWhenEnabled(driver, byTestId("go-button"));
    await waitForText(driver, byTestId("burn-progress"), "Test burn: 100%", 120_000);
    const [prepare] = await invokes(driver, "prepare_pcm");
    assert.equal(prepare.args.paths.length, 2, `GO prepared ${JSON.stringify(prepare.args.paths)}`);
    assert.ok(prepare.args.paths.every((file) => !/Beta Tone/.test(file)), "the removed track was not prepared for the disc");
    assert.equal(prepare.args.normalize, false, "albums keep their own loudness");
  });

  it("export cannot be started twice", async () => {
    await spyInvokes(driver);
    // Two clicks in the same task: the second lands before React re-renders.
    await driver.executeScript("const button = document.querySelector('[data-testid=go-button]'); button.click(); button.click();");
    await waitForText(driver, byTestId("go-button"), "Exporting…", 10_000).catch(() => undefined);
    await driver.wait(async () => (await driver.findElement(byTestId("go-button")).getText()) === "Export print files + test burn", 120_000, "export never finished");
    assert.equal((await invokes(driver, "prepare_pcm")).length, 1, "one export for a double click");
    assert.equal((await invokes(driver, "compose_pdf")).length, 3, "one PDF per piece, once");
    assert.deepEqual(await unexplainedErrors(driver), []);
  });

  it("a burned project says Last burned, not a simulation percentage", async () => {
    await openProjectStudio(driver, projects.burned);
    await stubDialogs(driver, { confirmBurn: false });
    await scrollToTop(driver, byTestId("print-burn"));
    await waitForText(driver, byTestId("last-burned"), /^Last burned /);
    assert.equal(await driver.findElement(byTestId("burn-progress")).getText(), "Test burn: not run yet");
    assert.equal(await driver.findElement(byTestId("burn-cd-button")).getText(), "Burn CD again");
    assert.doesNotMatch(await driver.findElement(byTestId("print-burn")).getText(), /simulation/i);
    await tourWp2(driver, "print-burn-burned", { before: () => scrollToTop(driver, byTestId("print-burn")) });
    assert.deepEqual(await unexplainedErrors(driver), []);
  });
});
