import { startCustomFromLibrary } from "../lib/wp2.mjs";
// Library area, first run on a machine with no Apple Music library and no
// imports: landing -> Import music sources -> empty library -> Sources ->
// Update Apple Music (missing, then synced after launch) -> relaunch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { SINE_WAVE_SUITE } from "../fixtures/lib/catalog.mjs";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  albumCardTitles,
  ariaLabel,
  buttonText,
  clickButton,
  domText,
  installInvokeGuard,
  seedAppleLibrary,
  sidebarStats,
  textOf,
  tour,
  visible,
  waitForText,
  waitVisible
} from "../lib/lib.mjs";

describe("library first run (no Apple library, no imports)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-lib-first-"));
  let app;
  let driver;

  async function start() {
    app = await launchApp({ home, keepHome: true });
    driver = app.driver;
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  }

  before(start);

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("opens on the landing screen with an empty projects list", async () => {
    await waitVisible(driver, By.css('[data-testid="landing-screen"]'));
    assert.equal(await textOf(driver, '[data-testid="recent-projects"] .catalog-empty'), "Saved projects and completed burns will appear here.");
    const format = await driver.findElement(By.css(".landing-format-field select"));
    assert.equal(await format.getAttribute("value"), "jewelcase");
    assert.ok(await visible(driver, buttonText("Start custom CD")));
    assert.ok(await visible(driver, buttonText("Import music sources")));
    await tour(driver, "landing-empty");
  });

  it("Import music sources opens an empty but usable library", async () => {
    await clickButton(driver, "Import music sources");
    await waitVisible(driver, By.css('[data-testid="apple-library"]'));
    assert.deepEqual(await sidebarStats(driver), []);
    const active = await driver.findElement(By.css('nav[aria-label="Music library"] button.active'));
    assert.equal(await domText(driver, active), "Music sources");
    assert.equal(await visible(driver, ariaLabel("Your first CD", "section")), undefined, "Albums guidance is only shown on Albums");
    const toggles = await driver.executeScript(`return [...document.querySelectorAll('.music-source-toggles label')].map((label) => ({
      name: label.querySelector('span').textContent, disabled: label.querySelector('input').disabled, hint: label.querySelector('small').textContent }))`);
    assert.deepEqual(toggles, [], "only imported sources have toggles");
    assert.ok(await visible(driver, buttonText("Add a source")));
    await waitVisible(driver, By.css('[data-testid="music-sources"]'));
    assert.equal(await textOf(driver, ".music-queue-list p"), "Choose songs or an album. Your CD fills up here.");
    await tour(driver, "library-empty");
  });

  it("an empty library does not claim a search found nothing", async () => {
    await waitVisible(driver, By.css('[data-testid="music-sources"]'));
    await clickButton(driver, "Albums");
    const empty = await textOf(driver, ".music-empty-library p");
    assert.equal(empty, "Your library is empty. Import your Apple Music, Spotify, SoundCloud or YouTube Music listening data to see albums here.");
    assert.ok(await visible(driver, ariaLabel("Your first CD", "section")), "first-run guidance card is missing");
    assert.doesNotMatch(empty, /match that search/i);
  });

  it("Music sources lists import status and local audio files", async () => {
    await clickButton(driver, "Music sources");
    await waitVisible(driver, By.css('[data-testid="music-sources"]'));
    const cards = await driver.executeScript(`return [...document.querySelectorAll('.music-source-card')].map((card) => ({
      name: card.querySelector('h2').textContent, status: card.querySelector('header span').textContent }))`);
    assert.deepEqual(cards, [
      { name: "Apple Music", status: "Not found on this PC" },
      { name: "Spotify", status: "Not imported" },
      { name: "SoundCloud", status: "Not imported" },
      { name: "YouTube Music", status: "Not imported" },
      { name: "Audio files on this PC", status: "On this PC" }
    ]);
    for (const label of ["Choose Spotify export", "Choose SoundCloud export", "Choose YouTube Music export"]) {
      assert.ok(await visible(driver, By.xpath(`//label[contains(@class,'music-import-button')][normalize-space(.)='${label}']`)), `missing ${label}`);
    }
    const summary = await driver.findElement(By.xpath("//article[.//h2='Spotify']//details[summary='What this source can provide']/summary"));
    await summary.click();
    const limits = await driver.findElement(By.xpath("//article[.//h2='Spotify']//details[summary='What this source can provide']//li"));
    assert.match(await domText(driver, limits), /Extended Streaming History/);
    await summary.click();
    await tour(driver, "sources-empty");
  });

  it("Read Apple Music library explains where it looked when missing", async () => {
    await clickButton(driver, "Read Apple Music library");
    const expected = "MXTP could not find your Apple Music library on this PC. Open Apple Music once so it syncs, or choose your Library.musicdb file.";
    await waitForText(driver, ".music-source-message > p", expected);
    const status = await driver.findElement(By.css(".music-source-message"));
    assert.equal(await status.getAttribute("role"), "alert");
    assert.match(await status.getAttribute("class"), /\berror\b/);
    await status.findElement(By.css("summary")).click();
    assert.equal(await textOf(driver, ".music-source-message details p"), `Apple Music library was not found at \`${home}/Music/Apple Music/Apple Music Library.musiclibrary/Library.musicdb\``);
    await status.findElement(By.css("summary")).click();
    assert.ok(await visible(driver, buttonText("Read Apple Music library")), "Read button did not come back");
    await tour(driver, "sources-apple-error");
  });

  it("Read Apple Music library picks up a library synced after launch", async () => {
    seedAppleLibrary(home, { tracks: SINE_WAVE_SUITE });
    await clickButton(driver, "Read Apple Music library");
    assert.equal(await waitForText(driver, ".music-source-message", "Apple Music library read"), "Apple Music library read: 3 songs and 60 recorded plays.");
    const apple = await driver.findElement(By.xpath("//article[.//h2='Apple Music']"));
    assert.equal(await domText(driver, await apple.findElement(By.css("header span"))), "Read from this computer");
    assert.deepEqual(await sidebarStats(driver), ["3 songs", "1 album", "60 plays"]);
    const appleToggle = await driver.executeScript(`const label = document.querySelector('.music-source-toggles label');
      return { checked: label.querySelector('input').checked, disabled: label.querySelector('input').disabled, count: label.querySelector('small').textContent }`);
    assert.deepEqual(appleToggle, { checked: true, disabled: false, count: "3" });
    await clickButton(driver, "Albums");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 1, 10_000);
    assert.deepEqual(await albumCardTitles(driver), ["Sine Wave Suite"]);
    await tour(driver, "library-first-album", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("Dismiss getting started hides the card", async () => {
    await driver.findElement(ariaLabel("Dismiss getting started", "button")).click();
    await driver.wait(async () => !(await visible(driver, ariaLabel("Your first CD", "section"))), 5_000, "card still visible");
    assert.equal(await driver.executeScript("return localStorage.getItem('mxtp.gettingStartedDismissed')"), "1");
  });

  it("Start a CD for one album goes back to the create form", async () => {
    await startCustomFromLibrary(driver);
    await waitVisible(driver, By.css('[data-testid="landing-screen"]'));
    assert.equal(await visible(driver, By.css('[data-testid="apple-library"]')), undefined);
  });

  it("raised no page errors before relaunch", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });

  it("relaunch opens the synced library directly and remembers the dismissal", async () => {
    await app.close();
    app = undefined;
    await start();
    await waitVisible(driver, By.css('[data-testid="apple-library"]'), 20_000);
    assert.equal(await visible(driver, By.css('[data-testid="landing-screen"]')), undefined, "landing shown although a library exists");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 1, 10_000);
    assert.deepEqual(await sidebarStats(driver), ["3 songs", "1 album", "60 plays"]);
    assert.equal(await visible(driver, ariaLabel("Your first CD", "section")), undefined, "dismissed card came back");
  });

  it("raised no page errors after relaunch", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
