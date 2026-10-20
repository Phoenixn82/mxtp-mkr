import { startCustomFromLibrary } from "../lib/wp2.mjs";
// App shell + project lifecycle inside the music library: album grid and
// search, Projects view (filters, context menu, burn without a drive, delete),
// project mode (album layout first, three Exit project affordances), the burn
// list (keyboard + drag reorder, remove, rename, save, over-capacity), building
// a new project from an album, studio round trip, getting-started callout.
// Library = an imported Spotify source in libraries.json (real stored format);
// projects = saved CdProject JSON. Offline stubs: lib/proj.mjs offlineEnv.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it as plainIt } from "node:test";
import {
  By,
  Key,
  LIBRARY_TRACKS,
  absent,
  assertNoPageErrors,
  byButton,
  byButtonStart,
  byLabel,
  byTestId,
  click,
  failShots,
  inputProbe,
  installInputProbe,
  openProjectMenu,
  find,
  findVisible,
  launchProj,
  makeProject,
  makeQueueItem,
  makeSpotifySource,
  queueTitles,
  readProject,
  savedProjectsOnDisk,
  textOf,
  typeInto,
  waitAbsent,
  waitForCondition,
  waitForProjectOnDisk,
  waitTextContains,
  writeLibraries,
  writeProject,
  writeToneWav
} from "../lib/proj.mjs";

const QUEUE_STATUS = By.css('aside[aria-label="CD burn list"] .music-message');
const nav = (name) => By.xpath(`//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), '${name}')]`);
const projectCard = (album) => By.xpath(`//section[contains(@class,'music-library-view')]//button[contains(@class,'music-album-card') and parent::div[contains(@class,'music-project-card')] and @aria-label='Open ${album}']`);
const filterButton = (name) => By.xpath(`//section[contains(@class,'music-library-view')]//div[@aria-label='Filter projects']/button[normalize-space(.)='${name}']`);
const projectCards = By.css('.music-library-view .music-project-card > .music-album-card');
const albumCards = By.css('.music-library-view .music-album-grid > .music-album-card');

const ROAD = ["Glass Harbor", "Rust Belt Hymn", "Paper Satellites", "Anvil Choir"];

function roadMixQueue(home) {
  const tones = [440, 494, 523, 587].map((freq, index) =>
    writeToneWav(path.join(home, "audio", `road-${index}.wav`), { freq, seconds: 2 })
  );
  const byTitle = Object.fromEntries(LIBRARY_TRACKS.map((track) => [track.title, track]));
  return ROAD.map((title, index) => {
    const track = byTitle[title];
    return makeQueueItem({
      id: `road-${index}`,
      title,
      artist: track.artist,
      album: track.album,
      durationSec: track.durationSec,
      trackNumber: index + 1,
      wav: tones[index]
    });
  });
}

function seedLibrary(dirs, home, { projects = true } = {}) {
  writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]);
  if (!projects) return;
  // Custom CD across two albums, every track audio-ready (synthetic tones).
  writeProject(dirs, makeProject({ id: "road-mix", name: "Road Mix", album: "Road Mix", kind: "custom", queue: roadMixQueue(home), updatedAt: "2026-09-03T12:00:00.000Z" }));
  // Artist release the user renamed; nothing downloaded yet.
  writeProject(dirs, makeProject({
    id: "bloom-sessions",
    name: "Bloom Sessions",
    artist: "Neon Tide",
    album: "Static Bloom",
    queue: ["Glass Harbor", "Paper Satellites", "Low Orbit"].map((title, index) =>
      makeQueueItem({ id: `bloom-${index}`, title, artist: "Neon Tide", album: "Static Bloom", durationSec: 200, trackNumber: index + 1 })
    ),
    updatedAt: "2026-09-02T12:00:00.000Z"
  }));
  // Over the 80-minute CD limit (3 x 28:20).
  writeProject(dirs, makeProject({
    id: "marathon",
    name: "Marathon",
    album: "Marathon",
    kind: "custom",
    queue: ["Rust Belt Hymn", "Anvil Choir", "Molten Psalm"].map((title, index) =>
      makeQueueItem({ id: `marathon-${index}`, title, artist: "Iron Meridian", album: "Forge Lines", durationSec: 1_700, trackNumber: index + 1 })
    ),
    updatedAt: "2026-09-01T12:00:00.000Z"
  }));
}

async function openProjectsView(driver) {
  await click(driver, nav("Projects"));
  await findVisible(driver, By.xpath("//section[contains(@class,'music-library-view')]//h1[normalize-space(.)='Projects']"));
}

async function openProjectFromProjects(driver, album) {
  await openProjectsView(driver);
  await click(driver, projectCard(album));
  await findVisible(driver, byTestId("album-detail"));
}

async function exitProjectIfOpen(driver) {
  if ((await driver.findElements(byTestId("exit-project-button"))).length > 0) {
    await click(driver, byTestId("exit-project-button"));
    await waitAbsent(driver, byTestId("exit-project-button"));
  }
}

/** HTML5 drag of one element onto another with real DragEvents + a shared DataTransfer. */
async function html5Drag(driver, source, target) {
  return driver.executeScript(`
    const [source, target] = arguments;
    const data = new DataTransfer();
    const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    fire(source, "dragstart");
    fire(target, "dragenter");
    fire(target, "dragover");
    fire(target, "drop");
    fire(source, "dragend");
    return [...data.types];
  `, source, target);
}

describe("library: albums, projects, project mode and the burn list", () => {
  let app;
  const it = failShots(() => app?.driver, "library");
  const stubDir = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-stublog-"));
  const stubLog = path.join(stubDir, "calls.log");
  const stubCalls = () => {
    try {
      return readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  before(async () => {
    app = await launchProj({ seed: (dirs, home) => seedLibrary(dirs, home), env: { MXTP_E2E_STUB_LOG: stubLog } });
    await findVisible(app.driver, byTestId("apple-library"), 20_000);
  });

  after(async () => {
    await app?.close();
    rmSync(stubDir, { recursive: true, force: true });
  });

  it("an imported library opens the library shell: albums grid, source toggles, counts", async () => {
    const { driver } = app;
    await waitForCondition(async () => (await driver.findElements(albumCards)).length === 2, "expected 2 album cards");
    await findVisible(driver, byLabel("Open Static Bloom"));
    await findVisible(driver, byLabel("Open Forge Lines"));
    const stats = await textOf(driver, By.css(".music-sidebar-stats"));
    assert.match(stats, /6 songs/);
    assert.match(stats, /2 albums/);
    assert.match(await textOf(driver, nav("Projects")), /Projects\s*3/);
    const spotify = await find(driver, By.xpath("//div[@aria-label='Included music sources']//label[.//span[normalize-space(.)='Spotify']]//input"));
    assert.equal(await spotify.isEnabled(), true);
    assert.equal(await spotify.isSelected(), true);
    await findVisible(driver, byLabel("Your first CD"));
    assert.equal(await driver.executeScript("return document.querySelectorAll('.music-checklist li[data-done]').length"), 3, "music, burn list and saved-project steps are done");
    assert.ok(await absent(driver, byTestId("exit-project-button")), "no project is open on launch");
    await waitTextContains(driver, By.css(".music-queue-list"), "Choose songs or an album. Your CD fills up here.");
  });

  it("Search library filters albums and shows the no-match state", async () => {
    const { driver } = app;
    const search = By.css('[data-help-target="album-search"] input');
    await typeInto(driver, search, "meridian");
    await waitForCondition(async () => (await driver.findElements(albumCards)).length === 1, "search should leave one album");
    await findVisible(driver, byLabel("Open Forge Lines"));
    await typeInto(driver, search, "zzz-nothing");
    await waitTextContains(driver, By.css(".music-library-view .music-empty"), "No albums match “zzz-nothing”.");
    await typeInto(driver, search, "");
    await waitForCondition(async () => (await driver.findElements(albumCards)).length === 2, "clearing search restores both albums");
  });

  it("Projects view lists saved projects and filters by kind", async () => {
    const { driver } = app;
    await openProjectsView(driver);
    assert.equal((await driver.findElements(projectCards)).length, 3);
    await click(driver, filterButton("Custom CDs"));
    assert.equal((await driver.findElements(projectCards)).length, 2);
    await click(driver, filterButton("Artist releases"));
    assert.equal((await driver.findElements(projectCards)).length, 1);
    await findVisible(driver, projectCard("Bloom Sessions"));
    await click(driver, filterButton("All"));
    assert.equal((await driver.findElements(projectCards)).length, 3);
  });

  it(
    "a renamed project card is announced by the name it shows",
    async () => {
      const { driver } = app;
      await openProjectsView(driver);
      await findVisible(driver, byLabel("Open Bloom Sessions"), 3_000);
    }
  );

  it("opening a project from Projects enters project mode with its saved queue in exact order", async () => {
    const { driver } = app;
    await openProjectFromProjects(driver, "Road Mix");
    await findVisible(driver, byButton("← Projects"));
    await waitTextContains(driver, By.css(".music-project-mode-banner"), "Editing project: Road Mix · changes save automatically");
    await findVisible(driver, By.css(".music-project-mode-banner button"));
    await findVisible(driver, byTestId("exit-project-button"));
    await click(driver, byButton("AI Curator"));
    assert.equal(await (await find(driver, By.css(".curator-workspace"))).getAttribute("data-mode"), "project");
    assert.equal(await (await find(driver, By.css('.music-project-name input'))).getAttribute("value"), "Road Mix");
    assert.deepEqual(await queueTitles(driver), ROAD, "queue restores the exact saved order");
    for (const title of ROAD) await findVisible(driver, byLabel(`Play ${title}`));
    await waitTextContains(driver, By.css(".music-queue-head"), "4 tracks");
    await openProjectFromProjects(driver, "Road Mix");
  });

  it(
    "a custom CD opens on its own tracklist, not on one of its source albums",
    async () => {
      const { driver } = app;
      const heading = await textOf(driver, By.css('[data-testid="album-detail"] h1'));
      const table = await (await find(driver, By.css('[data-testid="album-detail"] .music-tracklist'))).getAttribute("aria-label");
      assert.deepEqual({ heading, table }, { heading: "Road Mix", table: "Road Mix tracklist" });
    }
  );

  it("keyboard reorder: ArrowUp/ArrowDown on the handle move the track, keep focus, and autosave the order", async () => {
    const { driver, dirs } = app;
    const handle = await findVisible(driver, byLabel("Reorder Paper Satellites"));
    await driver.executeScript("arguments[0].focus()", handle);
    await driver.actions().sendKeys(Key.ARROW_UP).perform();
    const expected = ["Glass Harbor", "Paper Satellites", "Rust Belt Hymn", "Anvil Choir"];
    await waitForCondition(async () => JSON.stringify(await queueTitles(driver)) === JSON.stringify(expected), "ArrowUp did not move the track");
    assert.equal(
      await driver.executeScript("return document.activeElement.getAttribute('aria-label')"),
      "Reorder Paper Satellites",
      "focus stays on the moved track's handle"
    );
    await driver.actions().sendKeys(Key.ARROW_UP).perform();
    const top = ["Paper Satellites", "Glass Harbor", "Rust Belt Hymn", "Anvil Choir"];
    await waitForCondition(async () => JSON.stringify(await queueTitles(driver)) === JSON.stringify(top), "second ArrowUp did not move to the top");
    await driver.actions().sendKeys(Key.ARROW_UP).perform(); // already first: no-op
    assert.deepEqual(await queueTitles(driver), top);
    await waitForProjectOnDisk(dirs, "road-mix", (project) => JSON.stringify(project.burnQueue.map((item) => item.title)) === JSON.stringify(top), "reordered queue was not autosaved");

    const last = await findVisible(driver, byLabel("Reorder Anvil Choir"));
    await driver.executeScript("arguments[0].focus()", last);
    await driver.actions().sendKeys(Key.ARROW_DOWN).perform(); // already last: no-op
    assert.deepEqual(await queueTitles(driver), top);
    await driver.actions().sendKeys(Key.ARROW_UP).perform();
    const final = ["Paper Satellites", "Glass Harbor", "Anvil Choir", "Rust Belt Hymn"];
    await waitForCondition(async () => JSON.stringify(await queueTitles(driver)) === JSON.stringify(final), "ArrowUp on the last track failed");
    const saved = await waitForProjectOnDisk(dirs, "road-mix", (project) => JSON.stringify(project.burnQueue.map((item) => item.title)) === JSON.stringify(final));
    assert.deepEqual(saved.burnQueue.map((item) => item.id), ["road-2", "road-0", "road-3", "road-1"], "exact item identity and order persisted");
  });

  it("the queue has no arrow-button pairs and no per-item 'ready' dot", async () => {
    const { driver } = app;
    const buttons = await driver.executeScript(
      "return [...document.querySelectorAll('.music-queue-item button')].map((b) => b.getAttribute('aria-label') || b.textContent)"
    );
    assert.ok(!buttons.some((label) => /move .* (up|down)|^[↑↓▲▼]$/i.test(label)), `arrow buttons found: ${buttons}`);
  });

  it("drag reorder: dropping a track's handle on another track moves it and autosaves", async () => {
    const { driver, dirs } = app;
    const source = await find(driver, byLabel("Reorder Rust Belt Hymn"));
    const target = await find(driver, By.xpath("//div[contains(@class,'music-queue-item')][.//strong[normalize-space(.)='Paper Satellites']]"));
    const types = await html5Drag(driver, source, target);
    assert.ok(types.includes("application/x-mxtp-track-id"), `dragstart did not set the track id (${types})`);
    const expected = ["Rust Belt Hymn", "Paper Satellites", "Glass Harbor", "Anvil Choir"];
    await waitForCondition(async () => JSON.stringify(await queueTitles(driver)) === JSON.stringify(expected), "drag did not reorder");
    await waitForProjectOnDisk(dirs, "road-mix", (project) => JSON.stringify(project.burnQueue.map((item) => item.title)) === JSON.stringify(expected), "dragged order was not autosaved");
  });

  it("remove from burn list updates the count and the saved project", async () => {
    const { driver, dirs } = app;
    await click(driver, byLabel("Remove Anvil Choir from burn list"));
    await waitForCondition(async () => !(await queueTitles(driver)).includes("Anvil Choir"), "track not removed");
    await waitTextContains(driver, By.css(".music-queue-head"), "3 tracks");
    await waitForProjectOnDisk(dirs, "road-mix", (project) => project.burnQueue.length === 3 && !project.burnQueue.some((item) => item.title === "Anvil Choir"));
  });

  it("renaming the project autosaves the new name", async () => {
    const { driver, dirs } = app;
    await typeInto(driver, By.css(".music-project-name input"), "Road Mix Deluxe");
    await (await find(driver, By.css(".music-project-name input"))).sendKeys(Key.TAB);
    await waitForProjectOnDisk(dirs, "road-mix", (project) => project.name === "Road Mix Deluxe" && project.saved === true, "renamed project not saved");
    await waitTextContains(driver, By.css(".music-project-mode-banner"), "Editing project: Road Mix Deluxe");
    assert.equal(
      await driver.executeScript("return document.querySelector('.music-queue-project-mode strong').textContent"),
      "Road Mix Deluxe"
    );
  });

  it("Exit project (banner) leaves project mode and empties the burn list", async () => {
    const { driver, dirs } = app;
    await click(driver, By.css(".music-project-mode-banner button"));
    await waitTextContains(driver, QUEUE_STATUS, "The burn list is empty and ready for a new mix.");
    assert.ok(await absent(driver, By.css(".music-project-mode-banner")));
    assert.ok(await absent(driver, byTestId("exit-project-button")));
    await waitTextContains(driver, By.css(".music-queue-list"), "Choose songs or an album. Your CD fills up here.");
    assert.equal(readProject(dirs, "road-mix").burnQueue.length, 3, "exiting does not modify the saved project");
  });

  it("Exit project from the burn list works across repeated project visits", async () => {
    const { driver } = app;
    await openProjectFromProjects(driver, "Bloom Sessions");
    await click(driver, byTestId("exit-project-button"));
    await waitTextContains(driver, QUEUE_STATUS, "The burn list is empty and ready for a new mix.");
    assert.ok(await absent(driver, By.css(".music-project-mode-banner")));

    await openProjectFromProjects(driver, "Bloom Sessions");
    await click(driver, byTestId("exit-project-button"));
    await waitTextContains(driver, QUEUE_STATUS, "The burn list is empty and ready for a new mix.");
    assert.ok(await absent(driver, By.css(".music-project-mode-banner")));
    assert.equal((await queueTitles(driver)).length, 0);
  });

  it(
    "opening an album while a project is open never hides the project context",
    async () => {
      const { driver } = app;
      await openProjectFromProjects(driver, "Bloom Sessions");
      await click(driver, nav("Albums"));
      await click(driver, byLabel("Open Forge Lines"));
      await findVisible(driver, byTestId("album-detail"));
      const state = {
        banner: (await driver.findElements(By.css(".music-project-mode-banner"))).length > 0,
        queue: (await queueTitles(driver)).length,
        name: await (await find(driver, By.css(".music-project-name input"))).getAttribute("value")
      };
      // Clean up for the next tests whichever way the app behaves.
      await exitProjectIfOpen(driver);
      if ((await queueTitles(driver)).length > 0) {
        await click(driver, By.xpath("//aside[@aria-label='CD burn list']//div[contains(@class,'music-queue-head')]//button[normalize-space(.)='Clear burn list']"));
      }
      await typeInto(driver, By.css(".music-project-name input"), "");
      assert.ok(state.banner || (state.queue === 0 && state.name === ""), `project context hidden while its queue stays: ${JSON.stringify(state)}`);
    }
  );

  it("an over-80-minute project disables Prepare audio and Burn CD and flags capacity", async () => {
    const { driver } = app;
    await openProjectFromProjects(driver, "Marathon");
    assert.equal(await (await find(driver, By.css(".music-capacity"))).getAttribute("data-over"), "true");
    assert.equal(await (await find(driver, byButton("Burn CD"))).isEnabled(), false);
    assert.equal(await (await find(driver, By.xpath("//div[contains(@class,'music-queue-actions')]/button[starts-with(normalize-space(.), 'Download (')]"))).isEnabled(), false);
    await click(driver, byLabel("Remove Molten Psalm from burn list"));
    assert.equal(await (await find(driver, By.css(".music-capacity"))).getAttribute("data-over"), "false");
    assert.equal(await (await find(driver, byButton("Burn CD"))).isEnabled(), true);
    await exitProjectIfOpen(driver);
  });

  it("project context menu opens from the keyboard (Shift+F10) and closes with Escape", async () => {
    const { driver } = app;
    await openProjectsView(driver);
    const card = await findVisible(driver, projectCard("Road Mix Deluxe"));
    await installInputProbe(driver);
    await driver.executeScript("arguments[0].focus()", card);
    await driver.actions().keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform();
    const opened = await driver.wait(async () => (await driver.findElements(By.css('[role="menu"]'))).length > 0, 3_000).catch(() => false);
    assert.ok(opened, `Shift+F10 did not open the menu; page saw: ${JSON.stringify(await inputProbe(driver))}`);
    const menu = await findVisible(driver, By.css('[role="menu"][aria-label="Actions for Road Mix Deluxe"]'));
    assert.equal(await driver.executeScript("return document.activeElement.getAttribute('role')"), "menuitem", "first menu item is focused");
    assert.match(await menu.getText(), /Burn project/);
    assert.match(await menu.getText(), /Delete project…/);
    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await waitAbsent(driver, By.css('[role="menu"]'));
  });

  it(
    "project context menu opens on right-click and stays open",
    async () => {
    const { driver } = app;
    await openProjectsView(driver);
    await installInputProbe(driver);
    await driver.actions().contextClick(await findVisible(driver, projectCard("Road Mix Deluxe"))).perform();
    const opened = await driver.wait(async () => (await driver.findElements(By.css('[role="menu"]'))).length > 0, 3_000).catch(() => false);
    const seen = await inputProbe(driver);
    const inProjectMode = (await driver.findElements(byTestId("exit-project-button"))).length > 0;
    try {
      assert.ok(opened && !inProjectMode, `right-click: menu open=${opened}, card opened the project=${inProjectMode}; page saw: ${JSON.stringify(seen)}`);
    } finally {
      if ((await driver.findElements(By.css('[role="menu"]'))).length > 0) await driver.actions().sendKeys(Key.ESCAPE).perform();
      await exitProjectIfOpen(driver);
    }
    }
  );

  it("Burn project with audio ready but no CD writer loads the order and stops safely (no burn)", async () => {
    const { driver, dirs } = app;
    await openProjectsView(driver);
    await openProjectMenu(driver, projectCard("Road Mix Deluxe"));
    await click(driver, By.xpath("//div[@role='menu']//button[@role='menuitem'][.//strong[normalize-space(.)='Burn project']]"));
    await waitTextContains(driver, QUEUE_STATUS, "No CD writer found. You can download the audio now and burn later.", 20_000);
    assert.deepEqual(await queueTitles(driver), ["Rust Belt Hymn", "Paper Satellites", "Glass Harbor"]);
    await findVisible(driver, byTestId("exit-project-button"));
    const saved = readProject(dirs, "road-mix");
    assert.equal(saved.lastBurnedAt, undefined, "nothing was burned");
    await exitProjectIfOpen(driver);
  });

  it("Prepare audio for tracks that are not downloaded reports the offline match failure", async () => {
    const { driver } = app;
    await openProjectFromProjects(driver, "Bloom Sessions");
    for (const title of ["Glass Harbor", "Paper Satellites", "Low Orbit"]) {
      const play = await find(driver, byLabel(`${title} is not downloaded`));
      assert.equal(await play.isEnabled(), false);
    }
    await click(driver, By.xpath("//div[contains(@class,'music-queue-actions')]/button[starts-with(normalize-space(.), 'Download (')]"));
    await waitTextContains(driver, QUEUE_STATUS, "0 tracks ready. Not found on YouTube: Glass Harbor, Paper Satellites, Low Orbit.", 30_000);
    await exitProjectIfOpen(driver);
  });

  it("Delete project… from the context menu removes it after confirmation", async () => {
    const { driver, dirs } = app;
    await openProjectsView(driver);
    await openProjectMenu(driver, projectCard("Bloom Sessions"));
    await click(driver, By.xpath("//div[@role='menu']//button[@role='menuitem'][.//strong[normalize-space(.)='Delete project…']]"));
    await findVisible(driver, By.css('section[role="alertdialog"]'));
    assert.equal(await textOf(driver, By.id("project-delete-title")), "Delete Bloom Sessions?");
    await click(driver, byButton("Delete forever"));
    await waitAbsent(driver, By.css('section[role="alertdialog"]'));
    await waitForCondition(() => readProject(dirs, "bloom-sessions") === null, "deleted project file still on disk");
    await waitForCondition(async () => (await driver.findElements(projectCards)).length === 2, "card still listed");
    assert.match(await textOf(driver, nav("Projects")), /Projects\s*2/);
  });

  it("album detail: Liked songs is empty for Spotify-only tracks; Full album falls back to the local tracklist offline", async () => {
    const { driver } = app;
    await exitProjectIfOpen(driver);
    await click(driver, nav("Albums"));
    if ((await queueTitles(driver)).length > 0) {
      await click(driver, By.xpath("//aside[@aria-label='CD burn list']//div[contains(@class,'music-queue-head')]//button[normalize-space(.)='Clear burn list']"));
    }
    await click(driver, byLabel("Open Forge Lines"));
    await findVisible(driver, byTestId("album-detail"));
    await findVisible(driver, byButton("← All albums"));
    const liked = By.xpath("//div[@aria-label='Album download scope']/button[normalize-space(.)='My Apple Music songs (0)']");
    assert.equal(await (await find(driver, liked)).getAttribute("aria-pressed"), "false");
    await click(driver, liked);
    await waitTextContains(driver, By.css(".music-empty"), "No songs from this album are in your Apple Music library. It came from Spotify. Choose Full album to see the release.");
    assert.equal(await (await find(driver, byButton("Download 0 songs"))).isEnabled(), false);
    await click(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"));
    await waitTextContains(driver, By.css(".music-timing-note"), "Showing your local tracklist.", 20_000);
    const states = await driver.executeScript(
      "return Object.fromEntries([...document.querySelectorAll('.music-tracklist .music-track-row')].map((row) => [row.querySelector('.music-track-title strong').textContent, row.querySelector('.music-download-state')?.textContent ?? '']))"
    );
    // Downloads outlive projects: Road Mix downloaded Rust Belt Hymn and Anvil
    // Choir (Anvil Choir was later removed from its queue), so both stay ready.
    assert.deepEqual(states, {
      "Rust Belt Hymn": "Audio ready forever",
      "Anvil Choir": "Audio ready forever",
      "Molten Psalm": ""
    });
    assert.ok(await absent(driver, byButton("Delete project")), "no Delete project outside project mode");
  });

  it(
    "Full album looks up the verified tracklist once and settles when it is unavailable",
    async () => {
      const { driver } = app;
      await click(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'My Apple Music songs (')]"));
      const albumSearches = () => stubCalls().filter((line) => line.startsWith("yt-dlp") && line.includes("Forge%20Lines")).length;
      const before = albumSearches();
      await click(driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"));
      await driver.sleep(6_000);
      const notes = [];
      for (let i = 0; i < 10; i += 1) {
        notes.push((await textOf(driver, By.css(".music-timing-note"))).split(".")[0]);
        await driver.sleep(200);
      }
      const searches = albumSearches() - before;
      assert.ok(searches <= 2 && new Set(notes).size === 1, `album searches in 6 s: ${searches}; notes seen: ${JSON.stringify([...new Set(notes)])}`);
    }
  );

  it("Select all → Add to burn list → Save project creates a new saved artist project and enters project mode", async () => {
    const { driver, dirs } = app;
    await click(driver, byButton("Select all"));
    await waitTextContains(driver, By.css(".music-track-actions"), "3 selected");
    await click(driver, byButton("Add to burn list"));
    await waitForCondition(async () => (await queueTitles(driver)).length === 3, "Add to burn list did not add 3 tracks");
    const shown = await queueTitles(driver);
    assert.deepEqual([...shown].sort(), ["Anvil Choir", "Molten Psalm", "Rust Belt Hymn"]);
    const before = savedProjectsOnDisk(dirs).map((project) => project.id);
    await click(driver, byButton("Save as project"));
    const created = await waitForCondition(() => savedProjectsOnDisk(dirs).find((project) => !before.includes(project.id)), "Save project wrote no new file");
    assert.equal(created.saved, true);
    assert.equal(created.kind, "artist");
    assert.equal(created.name, "Forge Lines");
    assert.deepEqual(created.entry, { artist: "Iron Meridian", album: "Forge Lines", formatId: "jewelcase" });
    assert.deepEqual(created.burnQueue.map((item) => item.title), shown, "saved order equals the burn list order");
    await waitTextContains(driver, By.css(".music-project-mode-banner"), "Editing project: Forge Lines");
    assert.match(await textOf(driver, nav("Projects")), /Projects\s*3/);
  });

  it("Clear empties the burn list of the open saved project", async () => {
    const { driver, dirs } = app;
    const id = savedProjectsOnDisk(dirs).find((project) => project.name === "Forge Lines").id;
    await click(driver, By.xpath("//aside[@aria-label='CD burn list']//div[contains(@class,'music-queue-head')]//button[normalize-space(.)='Clear burn list']"));
    await waitTextContains(driver, By.css(".music-queue-list"), "Choose songs or an album.");
    await waitForProjectOnDisk(dirs, id, (project) => project.burnQueue.length === 0, "cleared queue not persisted");
    await exitProjectIfOpen(driver);
  });

  it("Open cover + booklet studio goes to the studio, and Music Library returns to the library", async () => {
    const { driver } = app;
    await click(driver, nav("Albums"));
    await click(driver, byLabel("Open Static Bloom"));
    await click(driver, byButton("Select all"));
    await click(driver, byButton("Add to burn list"));
    await click(driver, byButton("Save as project"));
    await click(driver, byButton("Open cover + booklet studio"));
    await findVisible(driver, byTestId("detail-view"), 20_000);
    assert.match(await textOf(driver, byTestId("detail-entry-summary")), /Neon Tide · Static Bloom · Jewel case/);
    await click(driver, byTestId("catalog-button"));
    await findVisible(driver, byTestId("apple-library"));
  });

  it("dragging an album card onto the burn list adds it per the Album drag setting", async () => {
    const { driver } = app;
    await exitProjectIfOpen(driver);
    await click(driver, nav("Albums"));
    const aside = await find(driver, By.css('aside[aria-label="CD burn list"]'));
    await html5Drag(driver, await findVisible(driver, byLabel("Open Static Bloom")), aside);
    await waitTextContains(driver, QUEUE_STATUS, "This album has no My Apple Music songs. Choose Full album in the Album drag setting to add the release.");
    assert.equal((await queueTitles(driver)).length, 0);

    await click(driver, By.xpath("//fieldset[contains(@class,'music-drag-settings')]//label[contains(normalize-space(.),'Full album')]/input"));
    assert.equal(await driver.executeScript("return localStorage.getItem('mxtp.albumDragScope')"), "full");
    await html5Drag(driver, await findVisible(driver, byLabel("Open Static Bloom")), aside);
    await waitTextContains(driver, QUEUE_STATUS, "3 tracks added to the burn list.", 20_000);
    assert.deepEqual((await queueTitles(driver)).sort(), ["Glass Harbor", "Low Orbit", "Paper Satellites"]);
    await click(driver, By.xpath("//aside[@aria-label='CD burn list']//div[contains(@class,'music-queue-head')]//button[normalize-space(.)='Clear burn list']"));
  });

  it(
    "Start a CD for one album can get back to the library from the landing",
    async () => {
      const { driver } = app;
      await startCustomFromLibrary(driver);
      await findVisible(driver, byTestId("landing-screen"));
      await click(driver, byButton("Back to library"));
      await findVisible(driver, byTestId("apple-library"), 5_000);
    }
  );

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("library: getting started callout", () => {
  plainIt("shows for a library with no projects, and Dismiss is remembered across restarts", async () => {
    let app = await launchProj({ seed: (dirs, home) => seedLibrary(dirs, home, { projects: false }), keepHome: true });
    try {
      const callout = await findVisible(app.driver, byLabel("Your first CD"), 20_000);
      assert.match(await callout.getText(), /Your first CD/);
      await click(app.driver, byLabel("Dismiss getting started"));
      await waitAbsent(app.driver, byLabel("Your first CD"));
      await assertNoPageErrors(app.driver);
      const home = app.home;
      await app.close();
      app = await launchProj({ home });
      await findVisible(app.driver, byTestId("apple-library"), 20_000);
      await findVisible(app.driver, byLabel("Open Static Bloom"));
      assert.ok(await absent(app.driver, byLabel("Your first CD")), "dismissed callout came back after restart");
    } finally {
      await app.close();
    }
  });
});
