// WP2 landing on the real app: intro + "Your projects (n)" link, Recent cards
// that survive partial research, Recent opening the library without
// rewriting the project file, 'Import music sources' after New custom CD, and
// a project file that cannot be read shown as an alert instead of an empty
// list. Real release binary, offline stubs, temp HOME only.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe } from "node:test";
import {
  By,
  assertNoPageErrors,
  byButton,
  byTestId,
  click,
  failShots,
  findVisible,
  innerText,
  makeProject,
  projectsDir,
  waitTextContains,
  writeProject,
  writeRawProjectFile
} from "../lib/proj.mjs";
import { launchWp2, startCustomFromLibrary, tourWp2 } from "../lib/wp2.mjs";

const card = (name) => By.css(`[data-testid="recent-projects"] button[aria-label="Open ${name}"]`);

describe("wp2 landing", () => {
  let app;
  const it = failShots(() => app?.driver, "wp2-landing");
  let partialFile;

  before(async () => {
    app = await launchWp2({
      theme: "light",
      seed: (dirs) => {
        writeProject(dirs, makeProject({ id: "neon-static", name: "Static Bloom", artist: "Neon Tide", album: "Static Bloom" }));
        // Saved before research finished: research has no lyrics list and the
        // burn list is missing entirely.
        const partial = makeProject({ id: "forge-partial", name: "Forge Lines", artist: "Iron Meridian", album: "Forge Lines", research: {} });
        delete partial.burnQueue;
        writeProject(dirs, partial);
        partialFile = path.join(projectsDir(dirs), "forge-partial.json");
      }
    });
  });

  after(async () => {
    await app?.close();
  });

  it("shows the intro, a projects link with the count, and Recent cards for partial projects", async () => {
    const { driver } = app;
    await findVisible(driver, byTestId("landing-screen"), 20_000);
    await waitTextContains(driver, By.css(".landing-projects-link"), "Your projects (2)");
    const forge = await findVisible(driver, card("Forge Lines"));
    // innerText: getText drops text inside the 3D-transformed cards.
    assert.match(await innerText(driver, forge), /0 tracks · 0 lyrics/);
    assert.ok(await findVisible(driver, byButton("Start custom CD")), "an empty form starts a custom CD");
    assert.ok(await findVisible(driver, byButton("Import music sources")));
    const shots = await tourWp2(driver, "landing", {
      before: () => driver.executeScript("window.scrollTo(0, 0)")
    });
    for (const shot of shots) assert.ok(shot.overflow <= 1, `${shot.mode} scrolls sideways by ${shot.overflow}px`);
    await assertNoPageErrors(driver);
  });

  it("the projects link scrolls to Recent projects", async () => {
    const { driver } = app;
    await driver.executeScript("window.scrollTo(0, 0)");
    await click(driver, By.css(".landing-projects-link"));
    // The page may be too short to bring the section to the very top; it must
    // have scrolled and be in view.
    const { top, scrollY } = await driver.executeScript("return { top: document.getElementById('recent-projects').getBoundingClientRect().top, scrollY: window.scrollY }");
    assert.ok(scrollY > 0 && top >= 0 && top < 500, `Recent projects should be in view after the link (top ${top}px, scrollY ${scrollY})`);
  });

  it("a Recent card opens the library and does not rewrite the project file", async () => {
    const { driver } = app;
    const before = readFileSync(partialFile, "utf8");
    await click(driver, card("Forge Lines"));
    await findVisible(driver, byTestId("apple-library"), 20_000);
    await driver.sleep(1500); // longer than the studio autosave debounce
    assert.equal(readFileSync(partialFile, "utf8"), before, "opening a project must not save it");
    await assertNoPageErrors(driver);
  });

  it("New custom CD returns to the landing, and Import music sources opens the library again", async () => {
    const { driver } = app;
    await startCustomFromLibrary(driver);
    await click(driver, byButton("Import music sources"));
    await findVisible(driver, byTestId("apple-library"), 20_000);
    await assertNoPageErrors(driver);
  });
});

describe("wp2 landing: one damaged project file", () => {
  let app;
  const it = failShots(() => app?.driver, "wp2-landing-error");

  before(async () => {
    app = await launchWp2({
      theme: "light",
      seed: (dirs) => {
        writeProject(dirs, makeProject({ id: "neon-static", name: "Static Bloom", artist: "Neon Tide", album: "Static Bloom" }));
        // Valid JSON, but not a CD project (entry: null).
        writeRawProjectFile(dirs, "bad-entry.json", JSON.stringify({ ...makeProject({ id: "bad-entry" }), entry: null }));
      }
    });
  });

  after(async () => {
    await app?.close();
  });

  it("names or sets aside the damaged project and still lists the good one", async () => {
    const { driver, dirs } = app;
    await findVisible(driver, byTestId("landing-screen"), 20_000);
    await findVisible(driver, card("Static Bloom"));
    assert.equal((await driver.findElements(By.css('[data-testid="recent-projects"] .catalog-empty'))).length, 0);
    // Without WP4 the file reaches the app, which names it in an alert. WP4's
    // loader sets a non-project file aside as bad-entry.json.corrupt-<time>.
    const setAside = readdirSync(projectsDir(dirs)).some((name) => name.startsWith("bad-entry.json.corrupt"));
    if (!setAside) {
      await waitTextContains(driver, byTestId("projects-load-error"), 'Some projects could not be loaded: "bad-entry" is damaged');
    }
    await tourWp2(driver, "landing-error", {
      before: async () => {
        const focus = (await driver.findElements(byTestId("projects-load-error")))[0] ?? (await findVisible(driver, byTestId("recent-projects")));
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", focus);
      }
    });
    await assertNoPageErrors(driver);
  });
});
