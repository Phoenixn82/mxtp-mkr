// WP1, library first run with no Apple library and no imports: the library
// opens on Music sources with plain labels, the Albums page shows "Your first
// CD" instead of a failed search, and a missing Apple library is one plain
// sentence with the raw error under Technical details.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { SINE_WAVE_SUITE } from "../fixtures/lib/catalog.mjs";
import { SIZES, stubDialogs, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import { ariaLabel, buttonText, clickButton, domText, installInvokeGuard, seedAppleLibrary, writeToneWav, queueTitles, textOf, visible, waitForText, waitVisible } from "../lib/lib.mjs";
import { tourWp1 } from "../lib/wp1.mjs";

describe("WP1 library first run", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-wp1-first-"));
  let app;
  let driver;

  before(async () => {
    app = await launchApp({ home, keepHome: true });
    driver = app.driver;
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  });

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("an empty library opens on Music sources with plain status labels", async () => {
    await clickButton(driver, "Import music sources");
    await waitVisible(driver, By.css('[data-testid="music-sources"]'), 20_000);
    const current = await driver.executeScript("return [...document.querySelectorAll('[aria-current=\"page\"]')].map((node) => node.textContent.trim())");
    assert.deepEqual(current, ["Music sources"]);
    const cards = await driver.executeScript(`return [...document.querySelectorAll('.music-source-card')].map((card) => ({
      name: card.querySelector('h2').textContent, status: card.querySelector('header span').textContent }))`);
    assert.deepEqual(cards, [
      { name: "Apple Music", status: "Not found on this PC" },
      { name: "Spotify", status: "Not imported" },
      { name: "SoundCloud", status: "Not imported" },
      { name: "YouTube Music", status: "Not imported" },
      { name: "Audio files on this PC", status: "On this PC" }
    ]);
    assert.ok(await visible(driver, buttonText("Read Apple Music library")));
    assert.ok(await visible(driver, buttonText("Choose Library.musicdb…")));
    assert.ok(await visible(driver, buttonText("Add audio files…")));
    assert.equal(await visible(driver, By.css(".music-toolbar input[type=search], .music-toolbar input[aria-label='Search library']")), undefined, "album search shows on Sources");
    await tourWp1(driver, "sources-empty");
  });

  it("a missing Apple library is a plain sentence with Technical details", async () => {
    await clickButton(driver, "Read Apple Music library");
    const alert = await waitVisible(driver, By.css(".music-source-message.error[role=alert]"), 20_000);
    const sentence = await domText(driver, await alert.findElement(By.css("p")));
    assert.equal(sentence, "MXTP could not find your Apple Music library on this PC. Open Apple Music once so it syncs, or choose your Library.musicdb file.");
    assert.doesNotMatch(sentence, /`/);
    const summary = await alert.findElement(By.css("summary"));
    assert.equal(await domText(driver, summary), "Technical details");
    await summary.click();
    assert.match(await domText(driver, alert), /Library\.musicdb/);
    await tourWp1(driver, "sources-apple-error");
  });

  it("the empty Albums page shows Your first CD, never a failed search", async () => {
    await clickButton(driver, "Albums");
    await waitVisible(driver, ariaLabel("Your first CD", "section"));
    assert.match(await textOf(driver, ".music-empty-library"), /^Your library is empty\./);
    assert.equal(await visible(driver, By.xpath("//*[contains(text(),'No albums match')]")), undefined);
    const rows = await driver.executeScript("return [...document.querySelectorAll('.music-checklist li')].map((li) => ({ text: li.textContent.trim(), done: li.hasAttribute('data-done') }))");
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => !row.done), `nothing is done yet: ${JSON.stringify(rows)}`);
    assert.equal(await visible(driver, By.css(".music-drag-settings")), undefined, "drag setting shows with no albums");
    await tourWp1(driver, "albums-empty");
  });

  it("Re-read picks up a library synced after launch and ticks the first step", async () => {
    seedAppleLibrary(home, { tracks: SINE_WAVE_SUITE });
    await clickButton(driver, "Music sources");
    await clickButton(driver, "Read Apple Music library");
    assert.equal(await waitForText(driver, ".music-source-message", "Apple Music library read"), "Apple Music library read: 3 songs and 60 recorded plays.");
    const status = await driver.executeScript("return document.querySelector('.music-source-card header span').textContent");
    assert.equal(status, "Read from this computer");
    assert.ok(await visible(driver, buttonText("Re-read Apple Music library")));
    await clickButton(driver, "Albums");
    await waitVisible(driver, ariaLabel("Open Sine Wave Suite", "button"));
    assert.equal(await textOf(driver, ".music-section-heading p"), "1 album from your listening data");
    const done = await driver.executeScript("return [...document.querySelectorAll('.music-checklist li[data-done]')].length");
    assert.ok(done >= 1, "importing music did not tick the checklist");
    await tourWp1(driver, "albums-first");
  });

  it("local audio files can be added to the burn list", async () => {
    const file = path.join(home, "imports", "Local tone.wav");
    writeToneWav(file, { seconds: 5 });
    await stubDialogs(driver, { openPaths: [file] });
    await clickButton(driver, "Music sources");
    const card = await driver.findElement(By.xpath("//article[.//h2='Audio files on this PC']"));
    await card.findElement(buttonText("Add audio files…")).click();
    await waitForText(driver, ".music-source-card:last-child .music-source-message", "Added 1 audio file to the burn list.");
    assert.deepEqual(await queueTitles(driver), ["Local tone"]);
    const play = await driver.findElement(ariaLabel("Play Local tone", "button"));
    assert.equal(await play.isEnabled(), true);
    const copies = await driver.executeScript("return (window.__e2eInvokes || []).filter((call) => call.command === 'copy_audio_file')");
    assert.equal(copies.length, 1);
    assert.equal(copies[0].args.sourcePath, file);
    assert.equal(copies[0].args.projectId, "library-imports");
    await tourWp1(driver, "sources-local-audio");
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
