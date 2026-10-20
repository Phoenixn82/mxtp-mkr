import { openProjectStudio } from "../lib/wp2.mjs";
// WP3 persisted data model on the real app: damaged or partial project files
// do not hide the good ones, non-Latin projects and albums keep their own
// identity, and a booklet saved at a non-printable page count reopens at the
// nearest printable count. Fixture names are fictional; offline stubs from
// lib/proj.mjs.
import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import {
  By,
  absent,
  assertNoPageErrors,
  byTestId,
  click,
  failShots,
  findVisible,
  launchProj,
  makeProject,
  makeSpotifySource,
  waitForCondition,
  waitTextContains,
  writeLibraries,
  writeProject
} from "../lib/proj.mjs";
import { scrollToTop, tourWp3 } from "../lib/wp3.mjs";

const BOOKLET_PAGES = '[data-testid="booklet-pages"]';

const PROJECTS = [
  makeProject({ id: "good-one", artist: "Neon Tide", album: "Static Bloom", updatedAt: "2026-09-05T12:00:00.000Z" }),
  { ...makeProject({ id: "bad-entry", album: "Broken" }), entry: null },
  makeProject({
    id: "partial-research",
    artist: "Iron Meridian",
    album: "Forge Lines",
    updatedAt: "2026-09-04T12:00:00.000Z",
    research: { album: { artist: "Iron Meridian", album: "Forge Lines", year: 2025, label: "x", tracks: [], coverArtUrls: [], tags: [] } }
  }),
  makeProject({ id: "cyrillic-one", artist: "Северный Ветер", album: "Тихая Гавань", updatedAt: "2026-09-03T12:00:00.000Z" }),
  makeProject({ id: "cyrillic-two", artist: "Северный Ветер", album: "Ночной Город", updatedAt: "2026-09-02T12:00:00.000Z" }),
  makeProject({ id: "fold-left", artist: "Glass Owl", album: "Paper Fold", bookletPages: 2, updatedAt: "2026-09-01T12:00:00.000Z" })
];

describe("wp3: stored projects load safely", () => {
  let app;
  const it = failShots(() => app?.driver, "wp3-landing");

  before(async () => {
    app = await launchProj({ seed: (dirs) => PROJECTS.forEach((project) => writeProject(dirs, project)) });
  });
  after(async () => {
    await app?.close();
  });

  it("one invalid project file and one with partial research do not hide the others", async () => {
    const { driver } = app;
    for (const id of ["good-one", "partial-research", "cyrillic-one", "cyrillic-two", "fold-left"]) {
      await findVisible(driver, byTestId(`project-card-${id}`), 20_000);
    }
    assert.ok(await absent(driver, byTestId("project-card-bad-entry")), "the project with entry:null is skipped");
    assert.ok(await absent(driver, By.css(".app-error-boundary")), "error boundary replaced the landing");
    const names = await driver.executeScript(
      "return [...document.querySelectorAll('[data-testid=recent-projects] .catalog-card strong')].map((node) => node.textContent.trim())"
    );
    assert.ok(names.includes("Тихая Гавань") && names.includes("Ночной Город"), `non-Latin names: ${names.join(" | ")}`);
    const shots = await tourWp3(driver, "landing", { before: () => scrollToTop(driver, '[data-testid="recent-projects"]') });
    for (const shot of shots) assert.ok(shot.overflow <= 1, `${shot.mode}: ${shot.overflow}px horizontal overflow`);
  });

  it("a booklet saved at 2 pages reopens at 8, a printable count", async () => {
    const { driver } = app;
    await openProjectStudio(driver, "fold-left");
    await findVisible(driver, byTestId("detail-view"), 20_000);
    await waitTextContains(driver, byTestId("booklet-pages"), "8 pages");
    const valid = await driver.executeScript("return [...document.querySelectorAll('[aria-labelledby=booklet-heading] [data-testid=layout-options] button strong')].map((node) => Number(node.textContent))");
    assert.ok(valid.includes(8), `valid counts: ${valid.join(", ")}`);
    await tourWp3(driver, "booklet", { before: () => scrollToTop(driver, BOOKLET_PAGES) });
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("wp3: a non-Latin library keeps every album", () => {
  let app;
  const it = failShots(() => app?.driver, "wp3-library");
  const tracks = [
    { title: "Первый Свет", artist: "Северный Ветер", album: "Тихая Гавань", durationSec: 201, plays: 9 },
    { title: "Пристань", artist: "Северный Ветер", album: "Тихая Гавань", durationSec: 188, plays: 7 },
    { title: "Огни", artist: "Северный Ветер", album: "Ночной Город", durationSec: 222, plays: 5 },
    { title: "Κύμα", artist: "Αστέρια", album: "Θάλασσα", durationSec: 245, plays: 4 }
  ];

  before(async () => {
    app = await launchProj({ seed: (dirs) => writeLibraries(dirs, [makeSpotifySource(tracks)]) });
  });
  after(async () => {
    await app?.close();
  });

  it("Cyrillic and Greek albums each get their own card", async () => {
    const { driver } = app;
    await findVisible(driver, byTestId("apple-library"), 20_000);
    const titles = () => driver.executeScript(
      "return [...document.querySelectorAll('.music-library-view .music-album-card strong')].map((node) => node.textContent.trim())"
    );
    await waitForCondition(async () => (await titles()).length >= 3, "album cards never rendered");
    assert.deepEqual([...(await titles())].sort(), ["Θάλασσα", "Ночной Город", "Тихая Гавань"]);
    await tourWp3(driver, "library");
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});
