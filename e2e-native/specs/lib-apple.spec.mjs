// Library area with a real (generated) Apple Music Library.musicdb under the
// temp HOME: auto-load, artwork, pagination, sort, search, album detail,
// burn-list editing, Save project, project mode, Projects view + actions menu,
// and the delete confirmation. YouTube lookups go to the offline yt-dlp stub.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import {
  ABSOLUTE_ZERO,
  LONG_PLAYER,
  QUIET_HOURS,
  SINE_WAVE_SUITE,
  ZEBRA_CROSSING,
  fillerAlbums,
  youtubeCatalog
} from "../fixtures/lib/catalog.mjs";
import { SIZES, domText, installErrorCollector, launchApp, pageErrors, screenshot, setTheme, setWindowSize, settle, waitForReady } from "../helpers.mjs";
import {
  albumCardTitles,
  appDataRoot,
  appleLibraryPackage,
  ariaLabel,
  buttonText,
  clickButton,
  dragAlbumToBurnList,
  installInvokeGuard,
  openContextMenu,
  invokeLog,
  queueTitles,
  seedAppleLibrary,
  setFieldValue,
  sidebarStats,
  textOf,
  tour,
  visible,
  waitForText,
  waitVisible,
  ytdlpStubEnv
} from "../lib/lib.mjs";

const TRACKS = [...SINE_WAVE_SUITE, ...QUIET_HOURS, ...LONG_PLAYER, ...ZEBRA_CROSSING, ...ABSOLUTE_ZERO, ...fillerAlbums(57)];

describe("Apple Music library browsing and the burn list", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-lib-apple-"));
  const env = ytdlpStubEnv(home, youtubeCatalog());
  let app;
  let driver;
  let projectsDir;

  const projectFiles = () => (existsSync(projectsDir) ? readdirSync(projectsDir).filter((name) => name.endsWith(".json")) : []);
  const readProject = (file) => JSON.parse(readFileSync(path.join(projectsDir, file), "utf8"));
  const queueHead = () => textOf(driver, ".music-queue-head strong");
  const navButton = (help) => driver.findElement(By.css(`nav[aria-label="Music library"] button[data-help-target="${help}"]`));

  async function openAlbum(title) {
    if (!(await visible(driver, By.css(".music-album-grid")))) await clickButton(driver, "Albums");
    await (await waitVisible(driver, ariaLabel(`Open ${title}`, "button"))).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    await driver.wait(async () => (await textOf(driver, ".music-album-meta h1")) === title, 5_000);
  }

  async function rowTitles() {
    return driver.executeScript("return [...document.querySelectorAll('.music-track-row .music-track-title strong')].map((node) => node.textContent)");
  }

  async function openProjectMenu(prefer = "keyboard") {
    const via = await openContextMenu(driver, ariaLabel("Open Tone Test CD", "button"), { prefer });
    console.log(`project menu opened via ${via}`);
    return { menu: await waitVisible(driver, By.css('[role="menu"]'), 5_000, "project menu"), via };
  }

  before(async () => {
    app = await launchApp({ home, env, seed: () => seedAppleLibrary(home, { tracks: TRACKS }) });
    driver = app.driver;
    projectsDir = path.join(appDataRoot(app.dirs), "projects");
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  });

  after(async () => {
    await app?.close();
  });

  it("opens straight into the Apple library with counts from Library.musicdb", async () => {
    await waitVisible(driver, By.css('[data-testid="apple-library"]'), 20_000);
    assert.equal(await visible(driver, By.css('[data-testid="landing-screen"]')), undefined);
    assert.deepEqual(await sidebarStats(driver), ["66 songs", "62 albums", "617 plays"]);
    assert.equal(await textOf(driver, ".music-section-heading p"), "62 albums from your listening data");
    assert.equal((await albumCardTitles(driver)).length, 60, "first page should hold 60 albums");
    assert.deepEqual((await albumCardTitles(driver)).slice(0, 5), ["Sine Wave Suite", "Quiet Hours", "Long Player", "Zebra Crossing", "Absolute Zero"]);
    const sineCard = await textOf(driver, '[aria-label="Open Sine Wave Suite"]');
    assert.match(sineCard, /The Oscillators/);
    assert.match(sineCard, /3 tracks · 9:00/);
    await tour(driver, "albums-apple");
  });

  it("shows the album's real Apple artwork and the MXTP fallback where there is none", async () => {
    const art = await driver.findElement(By.css('[aria-label="Open Sine Wave Suite"] img'));
    await driver.wait(() => driver.executeScript("return arguments[0].complete && arguments[0].naturalWidth > 0", art), 10_000, "Apple artwork never loaded");
    const src = decodeURIComponent(await art.getAttribute("src"));
    assert.ok(src.endsWith(path.join(appleLibraryPackage(home), "artwork", "art1001_sk1.png")), `unexpected artwork src ${src}`);
    assert.equal(await driver.executeScript("return arguments[0].naturalWidth", art), 96);
    const fallback = await driver.findElement(By.css('[aria-label="Open Quiet Hours"] [data-testid="artwork-fallback"]'));
    assert.equal(await domText(driver, fallback), "MXTP");
  });

  it("Show more albums reveals the rest of the library", async () => {
    await clickButton(driver, "Show more albums");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 62, 5_000);
    assert.equal(await visible(driver, buttonText("Show more albums")), undefined);
  });

  it("sorts by most played, artist and album title", async () => {
    const sort = await driver.findElement(By.css(".music-sort select"));
    const first = async (value) => {
      await sort.findElement(By.css(`option[value="${value}"]`)).click();
      await driver.wait(async () => (await sort.getAttribute("value")) === value, 3_000);
      return (await albumCardTitles(driver))[0];
    };
    assert.equal(await first("plays"), "Quiet Hours");
    assert.equal(await first("artist"), "Zebra Crossing");
    assert.equal(await first("album"), "Absolute Zero");
    assert.equal(await first("recent"), "Sine Wave Suite");
  });

  it("searches artists, albums and genres and says when nothing matches", async () => {
    const search = await driver.findElement(By.css('.music-search input[placeholder="Artists, albums, genres"]'));
    await search.sendKeys("oscillators");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 1, 5_000);
    assert.deepEqual(await albumCardTitles(driver), ["Sine Wave Suite"]);
    assert.equal(await textOf(driver, ".music-section-heading p"), "1 album from your listening data");
    await setFieldValue(driver, search, "ambient");
    await driver.wait(async () => (await albumCardTitles(driver)).join() === "Quiet Hours", 5_000);
    await setFieldValue(driver, search, "Filler Album 0");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 9, 5_000);
    await setFieldValue(driver, search, "no such record");
    await waitForText(driver, ".music-library-view .music-empty", "No albums match “no such record”. Clear search");
    assert.equal((await albumCardTitles(driver)).length, 0);
    await tour(driver, "albums-search-empty", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    await setFieldValue(driver, search, "");
    await driver.wait(async () => (await albumCardTitles(driver)).length === 60, 5_000);
  });

  it("album detail opens on My Apple Music songs with the owned tracks", async () => {
    await openAlbum("Sine Wave Suite");
    assert.equal(await textOf(driver, ".music-album-meta h2"), "The Oscillators");
    const liked = await driver.findElement(By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'My Apple Music songs (')]"));
    assert.equal(await liked.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await rowTitles(), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    const states = await driver.executeScript("return [...document.querySelectorAll('.music-track-row')].map((row) => row.querySelector('.music-download-state')?.textContent ?? '')");
    assert.deepEqual(states, ["", "", ""]);
    assert.match(await textOf(driver, ".music-album-meta p"), /Electronic · 2019 · My Apple Music songs: 3 · 9:00 · 60 plays/);
    const cover = await driver.findElement(By.css('img[alt="Sine Wave Suite cover"]'));
    await driver.wait(() => driver.executeScript("return arguments[0].complete && arguments[0].naturalWidth > 0", cover), 10_000);
    assert.match(await textOf(driver, ".music-timing-note"), /My Apple Music songs are the tracks saved in your Apple Music library/);
    await tour(driver, "album-detail-liked");
  });

  it("selects tracks and adds them to the burn list", async () => {
    const selected = () => textOf(driver, ".music-track-actions span");
    const add = await driver.findElement(buttonText("Add to burn list"));
    assert.equal(await add.isEnabled(), false);
    await driver.findElement(ariaLabel("Select Beta Tone", "input")).click();
    assert.equal(await selected(), "1 selected");
    await clickButton(driver, "Select all");
    assert.equal(await selected(), "3 selected");
    await driver.findElement(By.css(".music-track-actions")).findElement(buttonText("Clear selection")).click();
    assert.equal(await selected(), "0 selected");
    await clickButton(driver, "Select all");
    await clickButton(driver, "Add to burn list");
    await driver.wait(async () => (await queueTitles(driver)).length === 3, 5_000);
    assert.deepEqual(await queueTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    assert.equal(await queueHead(), "3 tracks");
    assert.equal(await textOf(driver, ".music-capacity div span"), "9:00");
    for (const title of ["Alpha Tone", "Beta Tone", "Gamma Tone"]) {
      const play = await driver.findElement(ariaLabel(`${title} is not downloaded`, "button"));
      assert.equal(await play.isEnabled(), false);
    }
    await tour(driver, "album-detail-queue");
  });

  it("reorders the burn list from the keyboard and keeps focus on the moved track", async () => {
    const handle = await driver.findElement(ariaLabel("Reorder Gamma Tone", "button"));
    await handle.sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await queueTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Tone", 3_000);
    assert.equal(await driver.executeScript("return document.activeElement?.getAttribute('aria-label')"), "Reorder Gamma Tone");
    await driver.switchTo().activeElement().sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await queueTitles(driver)).join() === "Alpha Tone,Beta Tone,Gamma Tone", 3_000);
  });

  it("removes a track from the burn list", async () => {
    await driver.findElement(ariaLabel("Remove Beta Tone from burn list", "button")).click();
    await driver.wait(async () => (await queueTitles(driver)).join() === "Alpha Tone,Gamma Tone", 3_000);
    assert.equal(await queueHead(), "2 tracks");
  });

  it("an over-capacity burn list blocks Download and Burn CD", async () => {
    await clickButton(driver, "← All albums");
    await openAlbum("Long Player");
    await clickButton(driver, "Select all");
    await clickButton(driver, "Add to burn list");
    await driver.wait(async () => (await queueTitles(driver)).length === 4, 5_000);
    const capacity = await driver.findElement(By.css(".music-capacity"));
    assert.equal(await capacity.getAttribute("data-over"), "true");
    assert.equal(await textOf(driver, ".music-capacity div span"), "96:00");
    assert.equal(await driver.findElement(By.xpath("//div[contains(@class,'music-queue-actions')]/button[starts-with(normalize-space(.), 'Download (')]")).isEnabled(), false);
    assert.equal(await driver.findElement(buttonText("Burn CD")).isEnabled(), false);
    assert.equal(await driver.findElement(buttonText("Save as project")).isEnabled(), true);
    await tour(driver, "burn-list-over-capacity", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    await driver.findElement(ariaLabel("Remove First Side from burn list", "button")).click();
    await driver.findElement(ariaLabel("Remove Second Side from burn list", "button")).click();
    await driver.wait(async () => (await capacity.getAttribute("data-over")) === "false", 3_000);
  });

  it("the over-capacity state tells the user why Burn CD is disabled", async () => {
    await clickButton(driver, "Select all");
    await clickButton(driver, "Add to burn list");
    await driver.wait(async () => (await queueTitles(driver)).length === 4, 5_000);
    try {
      assert.match(await textOf(driver, "#capacity-reason.music-capacity-reason"), /^Over by \d+:\d\d\. Remove tracks to fit an 80-minute CD\.$/);
      assert.ok((await driver.findElement(buttonText("Burn CD")).getAttribute("aria-describedby")).split(" ").includes("capacity-reason"));
    } finally {
      await driver.findElement(ariaLabel("Remove First Side from burn list", "button")).click();
      await driver.findElement(ariaLabel("Remove Second Side from burn list", "button")).click();
      await driver.wait(async () => (await queueTitles(driver)).length === 2, 3_000);
    }
  });

  it("dragging an album onto the burn list adds its Apple Music songs", async () => {
    await clickButton(driver, "← All albums");
    const key = await dragAlbumToBurnList(driver, "Quiet Hours");
    assert.equal(key, "nightowl::quiethours");
    assert.equal(await waitForText(driver, ".music-message", "added to the burn list"), "2 tracks added to the burn list.");
    assert.deepEqual(await queueTitles(driver), ["Alpha Tone", "Gamma Tone", "Midnight", "Dawn"]);
    await driver.findElement(ariaLabel("Remove Midnight from burn list", "button")).click();
    await driver.findElement(ariaLabel("Remove Dawn from burn list", "button")).click();
    await driver.wait(async () => (await queueTitles(driver)).length === 2, 3_000);
  });

  it("Save as project writes the exact burn order and enters project mode", async () => {
    assert.deepEqual(projectFiles(), []);
    const name = await driver.findElement(By.css('.music-project-name input'));
    await name.sendKeys("Tone Test CD");
    await clickButton(driver, "Save as project");
    await driver.wait(() => projectFiles().length === 1, 10_000, "no project file was written");
    const project = readProject(projectFiles()[0]);
    assert.equal(project.name, "Tone Test CD");
    assert.equal(project.saved, true);
    assert.equal(project.kind, "artist");
    assert.deepEqual(project.entry, { artist: "The Oscillators", album: "Sine Wave Suite", formatId: "jewelcase" });
    assert.deepEqual(project.burnQueue.map((item) => item.title), ["Alpha Tone", "Gamma Tone"]);
    const front = project.art.find((slot) => slot.slotId === "front");
    assert.ok(front?.imageRef?.startsWith(path.join(appleLibraryPackage(home), "artwork")), `project cover is not the Apple artwork: ${front?.imageRef}`);
    await waitForText(driver, ".music-project-mode-banner strong", "Editing project: Tone Test CD · changes save automatically");
    assert.equal(await domText(driver, await navButton("projects")), "Projects 1");
    await tour(driver, "project-mode");
  });

  it("saving a project confirms it was saved", async () => {
    assert.equal(await textOf(driver, ".music-message"), "Saved Tone Test CD to Projects. Changes now save automatically.");
  });

  it("reordering inside a saved project persists the new order immediately", async () => {
    const file = projectFiles()[0];
    await driver.findElement(ariaLabel("Reorder Alpha Tone", "button")).sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await queueTitles(driver)).join() === "Gamma Tone,Alpha Tone", 3_000);
    await driver.wait(() => readProject(file).burnQueue.map((item) => item.title).join() === "Gamma Tone,Alpha Tone", 5_000, "new order never reached disk");
  });

  it("Exit project leaves project mode and empties the burn list", async () => {
    await driver.findElement(By.css('[data-testid="exit-project-button"]')).click();
    assert.equal(await waitForText(driver, ".music-message", "Closed Tone Test CD."), "Closed Tone Test CD. The burn list is empty and ready for a new mix.");
    assert.equal(await visible(driver, By.css(".music-project-mode-banner")), undefined);
    assert.equal(await queueHead(), "0 tracks");
    assert.equal(projectFiles().length, 1, "exiting must not delete the project");
  });

  it("Projects lists the saved CD and filters by kind", async () => {
    await (await navButton("projects")).click();
    await waitForText(driver, ".music-section-heading h1", "Projects");
    const card = await waitVisible(driver, ariaLabel("Open Tone Test CD", "button"));
    assert.match(await domText(driver, card), /Tone Test CD[\s\S]*The Oscillators[\s\S]*2 tracks · 0 with audio/);
    await clickButton(driver, "Custom CDs");
    await waitForText(driver, ".music-library-view .music-empty", "No saved projects match this filter.");
    await clickButton(driver, "Artist releases");
    await waitVisible(driver, ariaLabel("Open Tone Test CD", "button"));
    await clickButton(driver, "All");
    await tour(driver, "projects");
  });

  it("project actions open on contextmenu (right-click) or Shift+F10 and close with Escape", async () => {
    await waitVisible(driver, ariaLabel("Open Tone Test CD", "button"));
    const { menu, via } = await openProjectMenu("syntheticEvent");
    assert.equal(via, "syntheticEvent", "the card did not answer a contextmenu event");
    assert.equal(await menu.getAttribute("aria-label"), "Actions for Tone Test CD");
    const items = await driver.executeScript("return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((item) => [item.querySelector('strong').textContent, item.disabled])");
    assert.deepEqual(items, [["Burn project", false], ["Delete project…", false]]);
    assert.equal(await driver.executeScript("return document.activeElement?.getAttribute('role')"), "menuitem");
    await tour(driver, "projects-menu", {
      modes: ["desktop-light", "narrow-light", "desktop-dark"],
      prepare: async () => {
        if (!(await visible(driver, By.css('[role="menu"]')))) await openProjectMenu();
      }
    });
    if (!(await visible(driver, By.css('[role="menu"]')))) await openProjectMenu();
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await driver.wait(async () => !(await visible(driver, By.css('[role="menu"]'))), 3_000, "Escape did not close the menu");
    const keyboard = await openProjectMenu("keyboard");
    assert.equal(keyboard.via, "keyboard", "Shift+F10 did not open the project menu");
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await driver.wait(async () => !(await visible(driver, By.css('[role="menu"]'))), 3_000);
  });

  it("opening a project restores its order and checks the release without downloading", async () => {
    await driver.findElement(ariaLabel("Open Tone Test CD", "button")).click();
    await waitVisible(driver, By.css('[data-testid="album-detail"]'));
    assert.ok(await visible(driver, buttonText("← Projects")));
    assert.ok(await visible(driver, By.css(".music-album-actions .music-card-more")));
    assert.deepEqual(await queueTitles(driver), ["Gamma Tone", "Alpha Tone"]);
    const full = await driver.findElement(By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"));
    assert.equal(await full.getAttribute("aria-pressed"), "true");
    await waitForText(driver, ".music-timing-note", "Showing the verified release tracklist.");
    assert.deepEqual(await rowTitles(), ["Alpha Tone", "Beta Tone", "Gamma Tone", "Delta Tone"]);
    const commands = (await invokeLog(driver)).map((call) => call.command);
    assert.ok(commands.includes("find_youtube_album_playlist"));
    assert.ok(!commands.includes("download_playlist_best"), "opening a project must not download");
    await tour(driver, "album-detail-project", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
    await driver.findElement(By.css('[data-testid="exit-project-button"]')).click();
    await waitForText(driver, ".music-message", "The burn list is empty and ready for a new mix.");
  });

  it("Delete project asks first; Keep project keeps it, Delete forever removes it", async () => {
    await (await navButton("projects")).click();
    const card = await waitVisible(driver, ariaLabel("Open Tone Test CD", "button"));
    await openProjectMenu();
    await driver.findElement(By.css('[role="menu"] .danger')).click();
    const dialog = await waitVisible(driver, By.css('[role="alertdialog"]'), 5_000, "delete dialog");
    assert.equal(await domText(driver, await dialog.findElement(By.css("h2"))), "Delete Tone Test CD?");
    assert.equal(await driver.executeScript("return document.activeElement?.textContent"), "Keep project");
    // The theme toggle sits behind the modal: tour light with the dialog open,
    // then close it, switch to dark and reopen it for the dark shot.
    await tour(driver, "delete-dialog", { modes: ["desktop-light", "narrow-light"] });
    await clickButton(driver, "Keep project");
    await driver.wait(async () => !(await visible(driver, By.css('[role="alertdialog"]'))), 3_000);
    await setTheme(driver, "dark");
    await openProjectMenu();
    await driver.findElement(By.css('[role="menu"] .danger')).click();
    await waitVisible(driver, By.css('[role="alertdialog"]'));
    await settle(driver);
    await screenshot(driver, "tour-lib-delete-dialog-desktop-dark");
    await clickButton(driver, "Keep project");
    await driver.wait(async () => !(await visible(driver, By.css('[role="alertdialog"]'))), 3_000);
    await setTheme(driver, "light");
    await driver.wait(async () => !(await visible(driver, By.css('[role="alertdialog"]'))), 3_000);
    assert.equal(projectFiles().length, 1);
    await openProjectMenu();
    await driver.findElement(By.css('[role="menu"] .danger')).click();
    await waitVisible(driver, By.css('[role="alertdialog"]'));
    await clickButton(driver, "Delete forever");
    await driver.wait(() => projectFiles().length === 0, 10_000, "project file still on disk");
    await waitForText(driver, ".music-library-view .music-empty", "No saved projects match this filter.");
    assert.equal(await domText(driver, await navButton("projects")), "Projects 0");
  });

  it("AI Curator + Help opens as a global mix when no project is active", async () => {
    await driver.findElement(buttonText("AI Curator")).click();
    const workspace = await waitVisible(driver, By.css("section.curator-workspace"));
    assert.equal(await workspace.getAttribute("data-mode"), "global");
    assert.equal(await textOf(driver, ".curator-head span"), "Curator · new custom CD");
    assert.equal(await visible(driver, By.css(".curator-mode-notice")), undefined);
    await tour(driver, "curator", { modes: ["desktop-light", "narrow-light", "desktop-dark"] });
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
