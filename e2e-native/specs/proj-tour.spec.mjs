import { openProjectStudio } from "../lib/wp2.mjs";
// Screenshot tour of every app-shell / project-lifecycle screen and state in
// desktop-light, desktop-dark, narrow-light and narrow-dark:
// test-results/e2e-native/tour-proj-<screen>-<mode>.png. Each screen also
// asserts it is actually showing the state it names, and records horizontal
// overflow at 420 px (logged; the landing/library layouts are asserted in the
// functional specs).
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import {
  By,
  LIBRARY_TRACKS,
  assertNoPageErrors,
  byButton,
  byLabel,
  byTestId,
  click,
  find,
  findVisible,
  launchProj,
  openProjectMenu,
  makeProject,
  makeQueueItem,
  makeSpotifySource,
  tour,
  typeInto,
  waitAbsent,
  waitForCondition,
  waitTextContains,
  writeLibraries,
  writeProject,
  writeToneWav
} from "../lib/proj.mjs";

const overflowLog = [];

async function shoot(driver, screen, options) {
  const shots = await tour(driver, screen, options);
  for (const shot of shots) {
    if (shot.overflow > 0) overflowLog.push(`${screen} ${shot.mode}: ${shot.overflow}px horizontal overflow`);
  }
  return shots;
}

function seedProjects(dirs, home) {
  const tones = [440, 494, 523].map((freq, index) => writeToneWav(path.join(home, "audio", `t${index}.wav`), { freq, seconds: 2 }));
  writeProject(dirs, makeProject({
    id: "road-mix",
    name: "Road Mix",
    album: "Road Mix",
    kind: "custom",
    updatedAt: "2026-09-03T12:00:00.000Z",
    queue: [
      ["Glass Harbor", "Neon Tide", "Static Bloom", 201],
      ["Rust Belt Hymn", "Iron Meridian", "Forge Lines", 245],
      ["Paper Satellites", "Neon Tide", "Static Bloom", 188]
    ].map(([title, artist, album, durationSec], index) =>
      makeQueueItem({ id: `road-${index}`, title, artist, album, durationSec, trackNumber: index + 1, wav: tones[index] })
    )
  }));
  writeProject(dirs, makeProject({
    id: "forge-lines",
    name: "Forge Lines",
    artist: "Iron Meridian",
    album: "Forge Lines",
    formatId: "digipak",
    updatedAt: "2026-09-02T12:00:00.000Z",
    queue: ["Rust Belt Hymn", "Anvil Choir", "Molten Psalm"].map((title, index) =>
      makeQueueItem({ id: `forge-${index}`, title, artist: "Iron Meridian", album: "Forge Lines", durationSec: 1_700, trackNumber: index + 1 })
    )
  }));
}

describe("tour: landing and studio (no library)", () => {
  let app;
  before(async () => {
    app = await launchProj();
  });
  after(async () => {
    await app?.close();
  });

  it("landing, empty", async () => {
    await waitTextContains(app.driver, By.css(".catalog-empty"), "Saved projects and completed burns will appear here.");
    await shoot(app.driver, "landing-empty");
  });

  it("studio, unsaved new custom CD", async () => {
    await click(app.driver, byButton("Start custom CD"));
    await findVisible(app.driver, byTestId("detail-view"), 20_000);
    await waitTextContains(app.driver, byTestId("save-project-button"), "Save as project");
    await shoot(app.driver, "studio-unsaved");
  });

  it("library onboarding with an empty library", async () => {
    await click(app.driver, byTestId("catalog-button"));
    await click(app.driver, byButton("Import music sources"));
    await findVisible(app.driver, byTestId("apple-library"));
    await findVisible(app.driver, byTestId("music-sources"));
    await shoot(app.driver, "library-onboarding-sources");
    await click(app.driver, byButton("Albums"));
    await findVisible(app.driver, byLabel("Your first CD"));
    await shoot(app.driver, "library-onboarding-empty");
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("tour: landing with saved projects, studio, delete dialog", () => {
  let app;
  before(async () => {
    app = await launchProj({ seed: (dirs, home) => seedProjects(dirs, home) });
  });
  after(async () => {
    await app?.close();
  });

  it("landing, populated", async () => {
    await findVisible(app.driver, byTestId("project-card-road-mix"), 20_000);
    await findVisible(app.driver, byTestId("project-card-forge-lines"));
    await shoot(app.driver, "landing-populated");
  });

  it("landing, search with no match", async () => {
    await typeInto(app.driver, By.css('[data-testid="recent-projects"] input[type="search"]'), "zzz");
    await waitForCondition(async () => (await app.driver.findElements(By.css(".catalog-card"))).length === 0, "filter did not empty the list");
    await shoot(app.driver, "landing-filtered-empty");
    await typeInto(app.driver, By.css('[data-testid="recent-projects"] input[type="search"]'), "");
  });

  it("studio, saved project", async () => {
    await openProjectStudio(app.driver, "forge-lines");
    await waitTextContains(app.driver, byTestId("save-project-button"), "Saved automatically");
    await shoot(app.driver, "studio-saved");
  });

  it("delete project dialog", async () => {
    const dialog = By.css('section[role="alertdialog"]');
    await shoot(app.driver, "delete-dialog", {
      reset: async () => {
        if ((await app.driver.findElements(dialog)).length > 0) await click(app.driver, byButton("Keep project"));
        await waitAbsent(app.driver, dialog);
      },
      before: async () => {
        if ((await app.driver.findElements(byTestId("delete-project-button"))).length === 0) await click(app.driver, byLabel("Project actions"));
        await click(app.driver, byTestId("delete-project-button"));
        await findVisible(app.driver, dialog);
      }
    });
    await click(app.driver, byButton("Keep project"));
    await waitAbsent(app.driver, By.css('section[role="alertdialog"]'));
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("tour: music library, projects, project mode, curator, help, sources", () => {
  let app;
  before(async () => {
    app = await launchProj({
      seed: (dirs, home) => {
        writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]);
        seedProjects(dirs, home);
      }
    });
    await findVisible(app.driver, byTestId("apple-library"), 20_000);
  });
  after(async () => {
    await app?.close();
  });

  const nav = (name) => By.xpath(`//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), '${name}')]`);

  it("library albums grid", async () => {
    await findVisible(app.driver, byLabel("Open Static Bloom"));
    await shoot(app.driver, "library-albums");
  });

  it("library search with no match", async () => {
    await typeInto(app.driver, By.css('[data-help-target="album-search"] input'), "zzz");
    await findVisible(app.driver, By.css(".music-library-view .music-empty"));
    await shoot(app.driver, "library-search-empty");
    await typeInto(app.driver, By.css('[data-help-target="album-search"] input'), "");
  });

  it("album detail, liked scope (empty for Spotify-only)", async () => {
    await click(app.driver, byLabel("Open Static Bloom"));
    await findVisible(app.driver, byTestId("album-detail"));
    await click(app.driver, By.xpath("//div[@aria-label='Album download scope']/button[normalize-space(.)='My Apple Music songs (0)']"));
    await waitTextContains(app.driver, By.css(".music-empty"), "No songs from this album are in your Apple Music library.");
    await shoot(app.driver, "album-detail-liked-empty");
  });

  it("album detail, full album with tracks selected and a filled burn list", async () => {
    await click(app.driver, By.xpath("//div[@aria-label='Album download scope']/button[starts-with(normalize-space(.), 'Full album (')]"));
    await waitForCondition(async () => (await app.driver.findElements(By.css(".music-tracklist .music-track-row"))).length === 3, "full album rows never appeared", 20_000);
    await click(app.driver, byButton("Select all"));
    await click(app.driver, byButton("Add to burn list"));
    await waitForCondition(async () => (await app.driver.findElements(By.css(".music-queue-item"))).length === 3, "queue not filled");
    await shoot(app.driver, "album-detail-full");
    await click(app.driver, By.xpath("//aside[@aria-label='CD burn list']//div[contains(@class,'music-queue-head')]//button[normalize-space(.)='Clear burn list']"));
  });

  it("projects view", async () => {
    await click(app.driver, nav("Projects"));
    await findVisible(app.driver, By.css('.music-project-card > .music-album-card'));
    await shoot(app.driver, "projects");
  });

  it("projects context menu", async () => {
    await shoot(app.driver, "projects-menu", {
      reset: async () => {
        if ((await app.driver.findElements(By.css('[role="menu"]'))).length > 0) {
          await app.driver.actions().sendKeys(Key.ESCAPE).perform();
          await waitAbsent(app.driver, By.css('[role="menu"]'));
        }
      },
      before: async () => {
        await openProjectMenu(app.driver, byLabel("Open Road Mix"));
      }
    });
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await waitAbsent(app.driver, By.css('[role="menu"]'));
  });

  it("project mode: album layout first, banner, saved queue", async () => {
    await click(app.driver, nav("Projects"));
    await click(app.driver, byLabel("Open Road Mix"));
    await findVisible(app.driver, By.css(".music-project-mode-banner"));
    await shoot(app.driver, "project-mode");
  });

  it("project chat (curator in project mode)", async () => {
    await click(app.driver, byButton("AI Curator"));
    await findVisible(app.driver, By.css('.curator-workspace[data-mode="project"]'));
    await shoot(app.driver, "curator-project");
  });

  it("help coach spotlighting Exit project (opened at each size)", async () => {
    const coach = By.css('.mxtp-coach section[role="dialog"]');
    await shoot(app.driver, "help-coach", {
      reset: async () => {
        if ((await app.driver.findElements(coach)).length > 0) {
          await click(app.driver, byLabel("Close guide"));
          await waitAbsent(app.driver, coach);
        }
      },
      before: async () => {
        await typeInto(app.driver, byLabel("Ask the MXTP curator"), "How do I exit a project?");
        await (await find(app.driver, byLabel("Ask the MXTP curator"))).sendKeys(Key.ENTER);
        await findVisible(app.driver, coach);
        await app.driver.sleep(1_000); // smooth scroll to the target
        await app.driver.actions().sendKeys(Key.ENTER).perform(); // reveal the full text
        await waitTextContains(app.driver, By.css(".mxtp-coach footer"), "to close");
      }
    });
    await click(app.driver, byLabel("Close guide"));
  });

  it("over-capacity burn list", async () => {
    await click(app.driver, byTestId("exit-project-button"));
    await click(app.driver, nav("Projects"));
    await click(app.driver, byLabel("Open Forge Lines"));
    await waitForCondition(
      async () => (await (await find(app.driver, By.css(".music-capacity"))).getAttribute("data-over")) === "true",
      "capacity not flagged"
    );
    await shoot(app.driver, "queue-over-capacity");
    await click(app.driver, byTestId("exit-project-button"));
  });

  it("global curator, empty transcript", async () => {
    await click(app.driver, byButton("AI Curator"));
    await findVisible(app.driver, byButton("My favorites from 2026"));
    await shoot(app.driver, "curator-global");
  });

  it("curator memory editor", async () => {
    await click(app.driver, byButton("Edit memory"));
    await findVisible(app.driver, byTestId("curator-memory"));
    await shoot(app.driver, "curator-memory");
    await click(app.driver, byButton("Edit memory"));
  });

  it("curator proposal awaiting a decision", async () => {
    await typeInto(app.driver, byLabel("Ask the MXTP curator"), "Give me the ultimate heavy metal mixtape");
    await (await find(app.driver, byLabel("Ask the MXTP curator"))).sendKeys(Key.ENTER);
    await findVisible(app.driver, By.css('[aria-label="Recommendation decision"]'), 15_000);
    await shoot(app.driver, "curator-proposal");
    await click(app.driver, byButton("No thanks"));
    await waitTextContains(app.driver, By.css(".curator-transcript"), "No problem");
    await shoot(app.driver, "curator-declined");
  });

  it("music sources", async () => {
    await click(app.driver, nav("Music sources"));
    await findVisible(app.driver, byTestId("music-sources"));
    await shoot(app.driver, "sources");
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});

describe("tour: getting started callout", () => {
  it("library with no projects", async () => {
    const app = await launchProj({ seed: (dirs) => writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]) });
    try {
      await findVisible(app.driver, byLabel("Your first CD"), 20_000);
      await shoot(app.driver, "library-getting-started");
      await assertNoPageErrors(app.driver);
    } finally {
      await app.close();
    }
  });
});

describe("tour: error boundary", () => {
  it("the error recovery screen offers reload and preserves saved projects", async () => {
    const app = await launchProj({
      seed: (dirs) => writeProject(dirs, makeProject({
        id: "partial-research",
        artist: "Iron Meridian",
        album: "Forge Lines",
        research: { album: { artist: "Iron Meridian", album: "Forge Lines", year: 2025, label: "x", tracks: [], coverArtUrls: [], tags: [] } }
      }))
    });
    try {
      await app.driver.executeScript(`
        const root = document.getElementById('root');
        const container = root[Object.keys(root).find((key) => key.startsWith('__reactContainer$'))];
        const visit = (fiber) => {
          if (!fiber) return false;
          if (fiber.stateNode?.constructor?.getDerivedStateFromError && fiber.stateNode.state && 'error' in fiber.stateNode.state) {
            fiber.stateNode.setState({ error: new Error('e2e render failure') });
            return true;
          }
          return visit(fiber.child) || visit(fiber.sibling);
        };
        if (!visit(container?.stateNode?.current || container)) throw new Error('React app boundary not found');
      `);
      await findVisible(app.driver, By.css(".app-error-boundary"), 20_000);
      await findVisible(app.driver, byButton("Reload MXTP MKR"));
      await shoot(app.driver, "error-boundary");
      // Reload replaces the document, so do not wait for animation frames in the old one.
      await (await findVisible(app.driver, byButton("Reload MXTP MKR"))).click();
      await findVisible(app.driver, byTestId("project-card-partial-research"), 20_000);
    } finally {
      await app.close();
    }
  });
});

describe("tour: summary", () => {
  it("logs horizontal overflow seen at any size", () => {
    console.log(`tour overflow report: ${overflowLog.length ? `\n  ${overflowLog.join("\n  ")}` : "none"}`);
    assert.ok(true);
  });
});

