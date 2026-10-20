// WP1, album and burn-list flows against the offline yt-dlp stub and the real
// sidecar: Full album rows marked ready by file position, status on the album
// page while downloading, project mode with Clear + Undo and Exit project,
// unmatched tracks named and removable, Add album by keyboard, keyboard
// reorder, over-capacity reason, Save as project confirmation, no-writer Burn
// (never burns), narrow burn-list peek, Projects search and the ⋯ menu.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { LONG_PLAYER, QUIET_HOURS, SINE_WAVE_SUITE, youtubeCatalog } from "../fixtures/lib/catalog.mjs";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  appDataRoot,
  ariaLabel,
  buttonText,
  clickButton,
  domText,
  installInvokeGuard,
  invokeLog,
  pngBuffer,
  queueTitles,
  seedAppleLibrary,
  textOf,
  visible,
  waitForText,
  waitVisible,
  ytdlpCalls,
  ytdlpStubEnv
} from "../lib/lib.mjs";
import { tourWp1 } from "../lib/wp1.mjs";

describe("WP1 album and burn list", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-wp1-album-"));
  const cover = path.join(home, "youtube-cover.png");
  writeFileSync(cover, pngBuffer([230, 120, 30], 160));
  const catalog = youtubeCatalog({ cover });
  const env = ytdlpStubEnv(home, catalog);
  let app;
  let driver;
  let dataRoot;

  const setCatalog = (next) => writeFileSync(env.MXTP_E2E_YTDLP_CATALOG, JSON.stringify(next, null, 2));
  const projectsDir = () => path.join(dataRoot, "projects");
  const projects = () => (existsSync(projectsDir()) ? readdirSync(projectsDir()).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(projectsDir(), name), "utf8"))) : []);
  const project = (name) => projects().find((entry) => entry.name === name);
  const extractCalls = () => ytdlpCalls(home).filter((call) => call.argv.includes("--extract-audio"));
  const states = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row')].map((row) => row.querySelector('.music-download-state')?.textContent ?? '')");
  const rows = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title strong')].map((node) => node.textContent)");
  const numbers = () => driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-number')].map((node) => [node.textContent, node.getAttribute('title')])");
  // The status sentence without its Undo / Remove unmatched buttons.
  const message = () => driver.executeScript("const p = document.querySelector('.music-message'); return p ? [...p.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim() : ''");
  const waitMessage = async (pattern, timeoutMs = 20_000) => {
    let last = "";
    await driver.wait(async () => { last = await message(); return typeof pattern === "string" ? last.includes(pattern) : pattern.test(last); }, timeoutMs, `burn-list status never matched ${pattern}`).catch((error) => { throw new Error(`${error.message}; last: ${last}`); });
    return last;
  };
  const queueCount = () => textOf(driver, ".music-queue-head strong");
  const navButton = (label) => By.xpath(`//nav[@aria-label='Music library']//button[starts-with(normalize-space(.), '${label}')]`);

  async function openAlbum(title) {
    await (await waitVisible(driver, navButton("Albums"))).click();
    await (await waitVisible(driver, ariaLabel(`Open ${title}`, "button"))).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
  }

  before(async () => {
    app = await launchApp({ home, keepHome: true, env, seed: () => seedAppleLibrary(home, { tracks: [...SINE_WAVE_SUITE, ...QUIET_HOURS, ...LONG_PLAYER] }) });
    driver = app.driver;
    dataRoot = appDataRoot(app.dirs);
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
    await waitVisible(driver, By.css('[data-testid="apple-library"]'), 20_000);
  });

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("Full album shows the verified release numbered 1 to 4 with plain scope labels", async () => {
    await openAlbum("Sine Wave Suite");
    assert.ok(await visible(driver, By.xpath("//button[starts-with(normalize-space(.), 'My Apple Music songs (')]")));
    await (await waitVisible(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"))).click();
    await waitForText(driver, ".music-timing-note", "Showing the verified release tracklist.", 40_000);
    assert.deepEqual(await rows(), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    assert.deepEqual((await numbers()).map(([number]) => number), ["1", "2", "3", "4"]);
    assert.deepEqual(await states(), ["", "", "", ""], "no 'Not downloaded' chips");
    assert.equal(await driver.executeScript("return document.querySelectorAll('.music-track-row .music-download-state').length"), 0, "no empty state pills");
    assert.equal(await textOf(driver, ".music-timing-estimate"), "About 7-20 minutes. Nothing burns until you click Burn CD.");
    assert.deepEqual(extractCalls(), [], "choosing Full album must not download");
    await tourWp1(driver, "album-full");
  });

  it("Download full album reports progress on the album page, saves the project and marks every row ready", async () => {
    setCatalog({ ...catalog, delayMs: { download: 4_000 } });
    await clickButton(driver, "Download full album");
    const status = await waitForText(driver, ".music-album-status", /Downloading the complete|Finding the complete/, 20_000);
    assert.match(status, /elapsed$/);
    assert.ok(await visible(driver, buttonText("Downloading…")));
    await tourWp1(driver, "album-downloading", { modes: ["desktop-light"] });
    const done = await waitForText(driver, ".music-message", /^Downloaded|Could not download/, 120_000);
    setCatalog(catalog);
    assert.equal(done, "Downloaded 4 tracks and saved them as the project Sine Wave Suite. Burn-list changes now update it.");
    const calls = extractCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argv[calls[0].argv.indexOf("--playlist-items") + 1], "1,3,4,5");
    await driver.wait(async () => (await states()).every((state) => state === "Audio ready forever"), 10_000, "Full album rows did not turn ready");
    assert.deepEqual(await queueTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    assert.match(await textOf(driver, ".music-project-mode-banner"), /^Editing project: Sine Wave Suite · changes save automatically/);
    assert.equal(await textOf(driver, ".music-autosave"), "Changes save automatically");
    await driver.wait(() => project("Sine Wave Suite")?.burnQueue?.length === 4, 10_000, "album project not on disk");
    assert.equal(projects().length, 1);
    await tourWp1(driver, "album-downloaded");
  });

  it("keyboard reorder keeps focus on the moved handle and saves the order", async () => {
    const handle = await driver.findElement(ariaLabel("Reorder Alpha Tone", "button"));
    await handle.sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await queueTitles(driver))[1] === "Alpha Tone", 5_000);
    assert.equal(await driver.executeScript("return document.activeElement?.getAttribute('aria-label')"), "Reorder Alpha Tone");
    await driver.wait(() => project("Sine Wave Suite")?.burnQueue?.[1]?.title === "Alpha Tone", 10_000, "reorder not saved");
    const arrowPairs = await driver.executeScript("return document.querySelectorAll('.music-queue-item button[aria-label^=\"Move \"]').length");
    assert.equal(arrowPairs, 0, "no arrow-button pairs");
    await handle.sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await queueTitles(driver))[0] === "Alpha Tone", 5_000);
  });

  it("Clear burn list in a project keeps the project, and Undo puts the tracks back", async () => {
    await clickButton(driver, "Clear burn list");
    assert.equal(await message(), "Cleared 4 tracks from Sine Wave Suite.");
    await driver.wait(() => project("Sine Wave Suite")?.burnQueue?.length === 0, 10_000, "cleared list not saved");
    const cleared = project("Sine Wave Suite");
    assert.equal(cleared.kind, "artist");
    assert.equal(cleared.entry.artist, "The Oscillators");
    const seen = [];
    for (let i = 0; i < 15; i += 1) {
      seen.push(await queueCount());
      await driver.sleep(200);
    }
    const saves = (await invokeLog(driver)).filter((call) => call.command === "save_cd_project").slice(-6)
      .map((call) => `${call.args.project.id.slice(-12)}:${call.args.project.burnQueue.length}@${call.args.project.updatedAt}`);
    assert.deepEqual([...new Set(seen)], ["0 tracks"], `cleared list came back: ${seen.join(",")}; saves ${saves.join(" ")}`);
    await tourWp1(driver, "burn-list-undo");
    await clickButton(driver, "Undo");
    await driver.wait(async () => (await queueTitles(driver)).length === 4, 5_000);
    await driver.wait(() => project("Sine Wave Suite")?.burnQueue?.length === 4, 10_000, "undo not saved");
  });

  it("Exit project leaves an empty burn list ready for a new mix", async () => {
    await (await driver.findElement(By.css('[data-testid="exit-project-button"]'))).click();
    assert.equal(await waitForText(driver, ".music-message", "Closed"), "Closed Sine Wave Suite. The burn list is empty and ready for a new mix.");
    assert.deepEqual(await queueTitles(driver), []);
    assert.equal(await visible(driver, By.css(".music-project-mode-banner")), undefined);
  });

  it("Add album to burn list works from the keyboard and confirms on the album page", async () => {
    await openAlbum("Quiet Hours");
    const add = await waitVisible(driver, buttonText("Add album to burn list"));
    await driver.executeScript("arguments[0].focus()", add);
    await add.sendKeys(Key.ENTER);
    await driver.wait(async () => (await queueTitles(driver)).join() === "Midnight,Dawn", 5_000);
    assert.equal(await textOf(driver, ".music-album-status"), "2 tracks added to the burn list.");
    assert.equal(await textOf(driver, ".music-unsaved-tag"), "Not saved");
  });

  it("Download names the track YouTube could not match and Remove unmatched drops it", async () => {
    await clickButton(driver, "Download (2)");
    const result = await waitMessage(/ready\./, 120_000);
    assert.equal(result, "1 track ready. Not found on YouTube: Dawn.");
    const tagged = await driver.executeScript("return [...document.querySelectorAll('.music-unmatched-tag')].map((tag) => tag.closest('.music-queue-item').querySelector('.music-queue-play strong').textContent)");
    assert.deepEqual(tagged, ["Dawn"]);
    const downloaded = extractCalls().map((call) => call.argv.at(-1));
    assert.ok(!downloaded.includes("https://www.youtube.com/watch?v=e2eDawnVideo"), "a music video was downloaded as album audio");
    await tourWp1(driver, "burn-list-unmatched");
    await clickButton(driver, "Remove unmatched");
    assert.equal(await waitMessage("Removed"), "Removed 1 unmatched track.");
    assert.equal(await queueCount(), "1 track");
    assert.deepEqual(await queueTitles(driver), ["Midnight"]);
  });

  it("Burn CD with no CD writer stops before writing anything", async () => {
    await clickButton(driver, "Burn CD");
    assert.equal(
      await waitMessage(/No CD writer|Could not/, 60_000),
      "No CD writer found. You can download the audio now and burn later."
    );
    const commands = (await invokeLog(driver)).map((call) => call.command);
    for (const writer of ["prepare_pcm", "build_cda_image", "burn_cda"]) assert.ok(!commands.includes(writer), `${writer} ran`);
  });

  it("the narrow burn list has a peek bar that mirrors the list", async () => {
    await setWindowSize(driver, SIZES.narrow);
    const peek = await waitVisible(driver, By.css(".music-queue-peek"));
    assert.match(await domText(driver, peek), /^Burn list · 1 track · \d+:\d\d \/ 80:00/);
    assert.equal(await peek.getAttribute("aria-expanded"), "false");
    assert.equal(await peek.getAttribute("aria-controls"), "burn-list");
    await driver.executeScript("arguments[0].click()", peek);
    await driver.wait(async () => (await peek.getAttribute("aria-expanded")) === "true", 3_000);
    assert.equal(await driver.executeScript("return document.getElementById('burn-list').dataset.expanded"), "true");
    await driver.executeScript("arguments[0].click()", peek);
    await setWindowSize(driver, SIZES.desktop);
  });

  it("the narrow peek bar stays on screen while the album list scrolls", async () => {
    await setWindowSize(driver, SIZES.narrow);
    await driver.executeScript("window.scrollTo(0, document.body.scrollHeight)");
    const inView = await driver.executeScript("const r = document.querySelector('.music-queue-peek').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight");
    await setWindowSize(driver, SIZES.desktop);
    assert.equal(inView, true);
  });

  it("Save as project confirms and switches to autosave", async () => {
    const name = await driver.findElement(By.css(".music-project-name input"));
    await name.clear();
    await name.sendKeys("Night Drive");
    await clickButton(driver, "Save as project");
    await driver.wait(async () => (await textOf(driver, ".music-autosave")) === "Changes save automatically", 10_000, "autosave label missing");
    assert.match(await message(), /^Saved Night Drive to Projects/);
    await driver.wait(() => project("Night Drive")?.burnQueue?.length === 1, 10_000, "saved project not on disk");
    assert.equal(await visible(driver, By.css(".music-unsaved-tag")), undefined);
    await tourWp1(driver, "burn-list-saved");
  });

  it("over-capacity lists say why Download and Burn CD are off", async () => {
    await clickButton(driver, "New mix");
    await openAlbum("Long Player");
    await clickButton(driver, "Select all");
    await clickButton(driver, "Add to burn list");
    const reason = await waitForText(driver, "#capacity-reason", /^Over by/);
    assert.equal(reason, "Over by 10:03. Remove tracks to fit an 80-minute CD.");
    const burn = await driver.findElement(By.xpath("//aside[@id='burn-list']//button[normalize-space(.)='Burn CD']"));
    assert.equal(await burn.isEnabled(), false);
    assert.equal(await burn.getAttribute("aria-describedby"), "capacity-reason");
    await tourWp1(driver, "burn-list-over");
    await clickButton(driver, "Clear burn list");
  });

  it("Projects search filters cards and the ⋯ menu works from the keyboard", async () => {
    await (await waitVisible(driver, navButton("Projects"))).click();
    const search = await waitVisible(driver, By.css("input[type=search]"));
    assert.equal(await visible(driver, ariaLabel("Search library", "input")), undefined, "album search shows on Projects");
    await search.sendKeys("night");
    await driver.wait(async () => !(await visible(driver, ariaLabel("Open Sine Wave Suite", "button"))), 5_000, "search did not filter");
    assert.ok(await visible(driver, ariaLabel("Open Night Drive", "button")));
    await tourWp1(driver, "projects-search");
    const more = await driver.findElement(ariaLabel("Actions for Night Drive", "button"));
    await more.click();
    const menu = await waitVisible(driver, By.css('[role="menu"]'));
    const focused = () => driver.executeScript("return document.activeElement?.textContent?.trim()");
    assert.match(await focused(), /^Burn project/);
    await driver.actions().sendKeys(Key.ARROW_DOWN).perform();
    assert.match(await focused(), /^Delete project/);
    await tourWp1(driver, "projects-menu", { modes: ["desktop-light"], keepScroll: true });
    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await driver.wait(async () => !(await menu.isDisplayed().catch(() => false)), 3_000, "menu stayed open");
    assert.equal(await driver.executeScript("return document.activeElement?.getAttribute('aria-label')"), "Actions for Night Drive");
  });

  it("raised no page errors", async () => {
    const errors = (await pageErrors(driver)).filter((error) => error.message !== "failed to load tauri://localhost");
    assert.deepEqual(errors, []);
  });
});
