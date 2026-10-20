import { openProjectStudio, startCustomFromLibrary } from "../lib/wp2.mjs";
// App shell + project lifecycle on the landing route (no music library):
// first launch, new custom CD and artist CD, unsaved draft vs explicit save,
// Recent projects (search, filters), reopen after restart, studio delete with
// the confirmation dialog, theme persistence, and corrupt/malformed project
// files on disk. Real release binary, offline stubs (lib/proj.mjs offlineEnv).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it as plainIt } from "node:test";
import { SIZES, setTheme, setWindowSize } from "../helpers.mjs";
import {
  By,
  Key,
  absent,
  assertNoPageErrors,
  byButton,
  byLabel,
  byTestId,
  click,
  failShots,
  overflowCulprits,
  find,
  findVisible,
  horizontalOverflow,
  innerText,
  launchProj,
  makeProject,
  projectFiles,
  projectsDir,
  readProject,
  savedProjectsOnDisk,
  textOf,
  typeInto,
  waitAbsent,
  waitForCondition,
  waitForProjectOnDisk,
  waitTextContains,
  writeProject,
  writeRawProjectFile
} from "../lib/proj.mjs";

const landingInput = (label) => By.xpath(`//main[@data-testid='landing-screen']//label[contains(normalize-space(.), '${label}')]//input`);
const formatOption = (text) => By.xpath(`//label[contains(@class,'landing-format-field')]//select/option[normalize-space(.)='${text}']`);
const EMPTY_COPY = "Saved projects and completed burns will appear here.";
const catalogEmpty = By.css('[data-testid="recent-projects"] .catalog-empty');
const cards = By.css('[data-testid="recent-projects"] .catalog-card');

async function createFromLanding(driver, { artist = "", album = "", format } = {}) {
  await findVisible(driver, byTestId("landing-screen"));
  if (artist) await typeInto(driver, landingInput("Artist"), artist);
  if (album) await typeInto(driver, landingInput("Album"), album);
  if (format) await click(driver, formatOption(format));
  await click(driver, byButton(artist && album ? "Create album CD" : "Start custom CD"));
  await findVisible(driver, byTestId("detail-view"), 20_000);
}

describe("landing: new CD, save, reopen, delete", () => {
  let app;
  const it = failShots(() => app?.driver, "landing");
  let artistProjectId;

  before(async () => {
    app = await launchProj({ keepHome: true });
  });

  after(async () => {
    await app?.close();
  });

  it("first launch with no data shows the landing form and the empty Projects state", async () => {
    const { driver, dirs } = app;
    await findVisible(driver, byTestId("landing-screen"));
    assert.ok(await findVisible(driver, landingInput("Artist")));
    assert.ok(await findVisible(driver, landingInput("Album")));
    assert.equal(await (await find(driver, By.css(".landing-format-field select"))).getAttribute("value"), "jewelcase");
    await waitTextContains(driver, catalogEmpty, EMPTY_COPY);
    assert.equal((await driver.findElements(cards)).length, 0);
    assert.ok(await findVisible(driver, byButton("Import music sources")));
    assert.deepEqual(projectFiles(dirs), [], "no project files on a fresh install");
  });

  it("Start custom CD opens an unsaved studio draft and writes nothing to disk", async () => {
    const { driver, dirs } = app;
    await createFromLanding(driver);
    assert.equal(await textOf(driver, byTestId("detail-entry-summary")), "Jewel case");
    assert.equal(await textOf(driver, byTestId("save-project-button")), "Save as project");
    assert.ok(await absent(driver, byTestId("delete-project-button")), "unsaved draft must not offer Delete project");
    // cdrskin stub fails `--device_links`, so the app must report no burner.
    await waitTextContains(driver, byTestId("burner-status"), "No CD writer found.");
    assert.equal(await (await find(driver, byTestId("burn-cd-button"))).isEnabled(), false, "Burn this CD again disabled with no tracks/burner");
    await driver.sleep(1_200); // past the 350 ms studio snapshot debounce
    assert.deepEqual(projectFiles(dirs), [], "an unsaved draft is never written to disk");
  });

  it(
    "the studio fits the narrow 420 px window without horizontal scrolling",
    async () => {
      const { driver } = app;
      await setWindowSize(driver, SIZES.narrow);
      try {
        for (const theme of ["light", "dark"]) {
          await setTheme(driver, theme);
          const overflow = await horizontalOverflow(driver);
          assert.ok(overflow <= 0, `studio overflows by ${overflow}px at 420 px: ${JSON.stringify(await overflowCulprits(driver))}`);
          assert.ok(await driver.executeScript("return document.querySelector('.app-header').getBoundingClientRect().height < 120"), `${theme} studio header stays under 120px`);
        }
      } finally {
        await setWindowSize(driver, SIZES.desktop);
        await setTheme(driver, "light");
      }
    }
  );

  it("← Library from an empty unsaved draft returns to the landing", async () => {
    const { driver } = app;
    await click(driver, byTestId("catalog-button"));
    await findVisible(driver, byTestId("landing-screen"));
    await waitTextContains(driver, catalogEmpty, EMPTY_COPY);
  });

  it("Create an artist CD with a chosen format, then Save as project writes it to disk", async () => {
    const { driver, dirs } = app;
    await createFromLanding(driver, { artist: "Neon Tide", album: "Static Bloom", format: "Cassette" });
    assert.equal(await textOf(driver, byTestId("detail-entry-summary")), "Neon Tide · Static Bloom · Cassette");
    // The automatic YouTube album lookup runs and fails offline through the stub.
    await waitTextContains(driver, byTestId("burn-message"), "Automatic YouTube match failed", 20_000);
    assert.deepEqual(projectFiles(dirs), [], "not saved before the explicit save");

    await click(driver, byTestId("save-project-button"));
    await waitTextContains(driver, byTestId("save-project-button"), "Saved automatically");
    assert.equal(await textOf(driver, byTestId("save-project-button")), "Saved automatically");
    await click(driver, byLabel("Project actions"));
    await findVisible(driver, byTestId("delete-project-button"));
    await driver.actions().sendKeys(Key.ESCAPE).perform();

    const [saved] = await waitForCondition(() => {
      const projects = savedProjectsOnDisk(dirs);
      return projects.length === 1 ? projects : null;
    }, "explicit save never produced one project file");
    artistProjectId = saved.id;
    assert.match(saved.id, /^neon-tide-static-bloom-\d+-[a-z0-9]+$/);
    assert.equal(saved.saved, true);
    assert.equal(saved.kind, "artist");
    assert.equal(saved.name, "Static Bloom");
    assert.deepEqual(saved.entry, { artist: "Neon Tide", album: "Static Bloom", formatId: "cassette" });
    assert.ok(existsSync(path.join(projectsDir(dirs), `${saved.id}.json`)));
  });

  it(
    "an offline research failure does not push the studio wider than the desktop window",
    async () => {
      const { driver } = app;
      await click(driver, byButton("Look up album"));
      await waitTextContains(driver, By.css('[data-testid="research-error"]'), "Couldn't reach MusicBrainz.", 20_000);
      const overflow = await horizontalOverflow(driver);
      assert.ok(overflow <= 0, `studio overflows by ${overflow}px at 1440 px: ${JSON.stringify(await overflowCulprits(driver))}`);
    }
  );

  it("the saved project appears in Recent projects after leaving the studio", async () => {
    const { driver } = app;
    await click(driver, byTestId("catalog-button"));
    await startCustomFromLibrary(driver);
    const card = await findVisible(driver, byTestId(`project-card-${artistProjectId}`));
    assert.equal(await card.getAttribute("aria-label"), "Open Static Bloom");
    const text = await innerText(driver, card);
    assert.match(text, /Static Bloom/);
    assert.match(text, /Neon Tide/);
    assert.match(text, /Cassette/);
    assert.match(text, /16-page booklet/);
  });

  it("projects persist across an app restart", async () => {
    const home = app.home;
    await app.close();
    app = await launchProj({ home, keepHome: true });
    await findVisible(app.driver, byTestId(`project-card-${artistProjectId}`), 20_000);
  });

  it("Find a project search and the kind filters narrow the list", async () => {
    const { driver } = app;
    const search = By.css('[data-testid="recent-projects"] input[type="search"]');
    await typeInto(driver, search, "zzz-no-match");
    await waitTextContains(driver, catalogEmpty, EMPTY_COPY);
    assert.equal((await driver.findElements(cards)).length, 0);
    await typeInto(driver, search, "neon");
    await findVisible(driver, byTestId(`project-card-${artistProjectId}`));
    await typeInto(driver, search, "");

    const filter = (name) => By.xpath(`//section[@data-testid='recent-projects']//div[@aria-label='Filter projects']/button[normalize-space(.)='${name}']`);
    await click(driver, filter("Custom CDs"));
    assert.equal((await driver.findElements(cards)).length, 0, "an artist release is not a custom CD");
    assert.match(await (await find(driver, filter("Custom CDs"))).getAttribute("class"), /active/);
    await click(driver, filter("Artist releases"));
    assert.equal((await driver.findElements(cards)).length, 1);
    await click(driver, filter("All"));
    assert.equal((await driver.findElements(cards)).length, 1);
  });

  it(
    "opening a Recent project shows the album layout + tracklist first (studio is secondary)",
    async () => {
      const { driver } = app;
      await click(driver, byTestId(`project-card-${artistProjectId}`));
      try {
        await findVisible(driver, byTestId("album-detail"), 5_000);
      } finally {
        await startCustomFromLibrary(driver);
      }
    }
  );

  it(
    "merely opening a saved project does not rewrite it on disk",
    async () => {
      const { driver, dirs } = app;
      const before = readProject(dirs, artistProjectId).updatedAt;
      await openProjectStudio(driver, artistProjectId);
      await driver.sleep(1_500);
      const afterOpen = readProject(dirs, artistProjectId).updatedAt;
      await click(driver, byTestId("catalog-button"));
      await startCustomFromLibrary(driver);
      assert.equal(afterOpen, before, "updatedAt changed although nothing was edited");
    }
  );

  it("studio Delete project asks first: Escape and Keep project leave the file on disk", async () => {
    const { driver, dirs } = app;
    await openProjectStudio(driver, artistProjectId);
    await click(driver, byLabel("Project actions"));
    await click(driver, byTestId("delete-project-button"));
    const dialog = await findVisible(driver, By.css('section[role="alertdialog"]'));
    assert.equal(await textOf(driver, By.id("project-delete-title")), "Delete Static Bloom?");
    assert.match(await dialog.getText(), /Downloaded audio stays in your library/);
    assert.equal(await driver.executeScript("return document.activeElement.textContent"), "Keep project", "Keep project is focused");

    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await waitAbsent(driver, By.css('section[role="alertdialog"]'));
    assert.ok(readProject(dirs, artistProjectId), "Escape must not delete");

    await click(driver, byLabel("Project actions"));
    await click(driver, byTestId("delete-project-button"));
    await click(driver, byButton("Keep project"));
    await waitAbsent(driver, By.css('section[role="alertdialog"]'));
    assert.ok(readProject(dirs, artistProjectId), "Keep project must not delete");
    await findVisible(driver, byTestId("detail-view"));
  });

  it("Delete forever removes the file and its Recent project card", async () => {
    const { driver, dirs } = app;
    await click(driver, byLabel("Project actions"));
    await click(driver, byTestId("delete-project-button"));
    await click(driver, byButton("Delete forever"));
    await waitAbsent(driver, By.css('section[role="alertdialog"]'));
    await startCustomFromLibrary(driver);
    await findVisible(driver, byTestId("landing-screen"), 15_000);
    await waitForCondition(() => readProject(dirs, artistProjectId) === null, "project file still on disk after Delete forever");
    await waitTextContains(driver, catalogEmpty, EMPTY_COPY);
    assert.deepEqual(projectFiles(dirs), []);
  });

  it("the chosen theme persists across a restart (MXTP light <-> Y2K dark)", async () => {
    const pressed = (theme) => By.css(`[aria-label="Color theme"] button[title="Use ${theme} mode"][aria-pressed="true"]`);
    await click(app.driver, By.css('[aria-label="Color theme"] button[title="Use dark mode"]'));
    await findVisible(app.driver, pressed("dark"));
    const home = app.home;
    await app.close();
    app = await launchProj({ home, keepHome: true });
    assert.equal(await app.driver.executeScript("return document.documentElement.dataset.theme"), "dark");
    await findVisible(app.driver, pressed("dark"));
    await click(app.driver, By.css('[aria-label="Color theme"] button[title="Use light mode"]'));
    await findVisible(app.driver, pressed("light"));
    assert.equal(await app.driver.executeScript("return document.documentElement.dataset.theme"), "light");
  });

  it("the landing has no horizontal overflow at the narrow 420 px layout", async () => {
    await setWindowSize(app.driver, SIZES.narrow);
    assert.ok((await horizontalOverflow(app.driver)) <= 0, "landing scrolls horizontally at 420 px");
    await setWindowSize(app.driver, SIZES.desktop);
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("landing: Import music sources with no library opens the library onboarding", () => {
  let app;
  const it = failShots(() => app?.driver, "landing-onboarding");
  before(async () => {
    app = await launchProj();
  });
  after(async () => {
    await app?.close();
  });

  it("shows Music sources first and an honest empty Albums view", async () => {
    const { driver } = app;
    await click(driver, byButton("Import music sources"));
    await findVisible(driver, byTestId("apple-library"));
    await findVisible(driver, byTestId("music-sources"));
    await click(driver, byButton("Albums"));
    await findVisible(driver, byLabel("Your first CD"));
    await waitTextContains(driver, By.css(".music-empty-library p"), "Your library is empty.");
    const sources = await driver.findElements(By.css('[aria-label="Included music sources"] input[type="checkbox"]'));
    assert.equal(sources.length, 0, "unimported sources have no filter toggles");
    await findVisible(driver, byButton("Add a source"));
    await click(driver, byButton("Music sources"));
    const cardsImported = await driver.executeScript(
      "return [...document.querySelectorAll('.music-source-card')].map((card) => card.dataset.imported)"
    );
    assert.deepEqual(cardsImported, ["false", "false", "false", "false", "false"]);
  });

  it("New custom CD from the empty library goes back to the landing form", async () => {
    const { driver } = app;
    await startCustomFromLibrary(driver);
    await findVisible(driver, byTestId("landing-screen"));
  });

  it(
    "Import music sources works again after New custom CD",
    async () => {
      const { driver } = app;
      await click(driver, byButton("Import music sources"));
      await findVisible(driver, byTestId("apple-library"), 5_000);
    }
  );

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("landing: damaged project files on disk", () => {
  const it = plainIt;
  it("a corrupt JSON file is quarantined and the valid projects still load", async () => {
    const good = makeProject({ id: "good-one", artist: "Neon Tide", album: "Static Bloom" });
    const app = await launchProj({
      seed: (dirs) => {
        writeProject(dirs, good);
        writeRawProjectFile(dirs, "broken.json", "{not json");
      }
    });
    try {
      await findVisible(app.driver, byTestId("project-card-good-one"), 20_000);
      assert.deepEqual(projectFiles(app.dirs), ["broken.json.corrupt", "good-one.json"]);
      await assertNoPageErrors(app.driver);
    } finally {
      await app.close();
    }
  });

  it(
    "one structurally invalid project (entry: null) does not hide every other project",
    async () => {
      const good = makeProject({ id: "good-one", artist: "Neon Tide", album: "Static Bloom" });
      const app = await launchProj({
        seed: (dirs) => {
          writeProject(dirs, good);
          writeProject(dirs, { ...makeProject({ id: "bad-entry" }), entry: null });
        }
      });
      try {
        await findVisible(app.driver, byTestId("project-card-good-one"), 8_000);
      } finally {
        await app.close();
      }
    }
  );

  it(
    "a project with partial research data does not crash the whole landing",
    async () => {
      const good = makeProject({ id: "good-one", artist: "Neon Tide", album: "Static Bloom" });
      const partial = makeProject({
        id: "partial-research",
        artist: "Iron Meridian",
        album: "Forge Lines",
        research: { album: { artist: "Iron Meridian", album: "Forge Lines", year: 2025, label: "x", tracks: [], coverArtUrls: [], tags: [] } }
      });
      const app = await launchProj({
        seed: (dirs) => {
          writeProject(dirs, good);
          writeProject(dirs, partial);
        }
      });
      try {
        assert.ok(await absent(app.driver, By.css(".app-error-boundary")), "error boundary replaced the landing");
        await findVisible(app.driver, byTestId("project-card-good-one"), 8_000);
      } finally {
        await app.close();
      }
    }
  );
});
