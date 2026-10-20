// Styles, accessibility and responsive layout on the real app (WebKitGTK), plus
// the harness isolation it relies on: studio overflow and header hierarchy,
// Y2K dark parity in the burn list, over-capacity cues, target sizes, the
// keyboard focus ring, the landing fold, and launchApp's temp/offline/stub
// options and richer resource-error reports. Offline, burn-safe stubs.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  SIZES,
  click,
  failShots,
  installErrorCollector,
  launchApp,
  pageErrors,
  pixelDiff,
  scrollToElement,
  scrollToTop,
  setFieldValue,
  setTheme,
  setWindowSize,
  settle,
  stubCalls,
  textOf,
  waitForReady
} from "../helpers.mjs";
import { LIBRARY_TRACKS, makeProject, makeQueueItem, makeSpotifySource, writeLibraries, writeProject } from "../lib/proj.mjs";
import {
  MODES,
  PROJ_BIN,
  appProcessEnv,
  appTempEntries,
  boxes,
  clippedOverflow,
  horizontalOverflow,
  keyboardFocus,
  navButton,
  overflowCulprits,
  resolveColor,
  styleOf,
  tour
} from "../lib/wp8.mjs";

const byTestId = (id) => By.css(`[data-testid="${id}"]`);
const GREEN_LIGHT = "rgb(140, 234, 85)"; // #8cea55, the light primary gradient
const GREEN_DARK = "rgb(139, 255, 91)"; // #8bff5b, the Y2K primary gradient
const systemTmp = tmpdir();
const tmpBefore = appTempEntries(systemTmp);

async function launch(seed) {
  const app = await launchApp({ seed, offline: true, stubBin: PROJ_BIN });
  try {
    await waitForReady(app.driver);
    await installErrorCollector(app.driver);
    await setWindowSize(app.driver, SIZES.desktop);
    await setTheme(app.driver, "light");
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

async function assertFits(driver, where) {
  const overflow = await horizontalOverflow(driver);
  assert.ok(overflow <= 0, `${where}: page is ${overflow}px wider than the window: ${JSON.stringify(await overflowCulprits(driver))}`);
}

describe("studio and landing: overflow, header hierarchy, fold, harness isolation", () => {
  let app;
  const it = failShots(() => app?.driver, "wp8-studio");

  before(async () => {
    app = await launch();
    await app.driver.wait(until.elementLocated(byTestId("landing-screen")), 20_000);
  });

  after(async () => {
    await app?.close();
  });

  it("the app runs with its temp data, caches and network stubs inside the test HOME", () => {
    const env = appProcessEnv(app.home);
    assert.ok(env, "found the app process for this HOME");
    const tmp = path.join(app.home, "tmp");
    assert.equal(env.TMPDIR, tmp);
    assert.equal(env.MXTP_MKR_CACHE_DIR, path.join(tmp, "mxtp_mkr_cache"));
    assert.equal(env.MXTP_MKR_COVER_OUTPUT_DIR, path.join(tmp, "mxtp_mkr_covers"));
    assert.equal(env.MXTP_MKR_IMAGEGEN_OUTPUT_DIR, path.join(tmp, "mxtp_mkr_imagegen"));
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9", "offline preset reaches the app");
    assert.equal(env.MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS, "0");
    const bin = path.join(app.home, "e2e-bin");
    assert.ok(env.PATH.startsWith(`${bin}:`), "the stub bin copy is first on PATH");
    assert.equal(env.MXTP_E2E_STUB_LOG, app.stubLog);
    assert.equal(env.MXTP_YTDLP_PATH, path.join(bin, "yt-dlp"));
  });

  it("landing: the Projects heading is above the fold at 1440x950 and the form labels line up", async () => {
    const { driver } = app;
    const heading = await driver.executeScript("const r = document.getElementById('catalog-heading').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, viewport: innerHeight }");
    assert.ok(heading.bottom <= heading.viewport, `Projects heading ends at ${Math.round(heading.bottom)}px in a ${heading.viewport}px window`);
    const fields = await boxes(driver, ".landing-field");
    const controls = await boxes(driver, ".landing-field :is(input, select)");
    assert.equal(fields.length, 3);
    assert.ok(Math.max(...fields.map((box) => box.top)) - Math.min(...fields.map((box) => box.top)) <= 2, `labels start at ${fields.map((box) => Math.round(box.top))}`);
    assert.ok(Math.max(...controls.map((box) => box.height)) - Math.min(...controls.map((box) => box.height)) <= 1, `field heights ${controls.map((box) => box.height)}`);
    const shots = await tour(driver, "landing", {
      before: async (mode) => {
        // .landing-screen clips sideways (the 3D case canvas is full-bleed by
        // design), so check that the content boxes end inside the window.
        const clipped = await clippedOverflow(driver, ".catalog, .landing-core, .landing-form");
        assert.ok(clipped <= 0, `${mode.name}: landing content runs ${clipped}px off the right edge`);
      }
    });
    for (const shot of shots) assert.ok(shot.overflow <= 0, `${shot.mode}: landing overflows by ${shot.overflow}px`);
  });

  it("a long offline research error wraps instead of widening the 1440 px studio", async () => {
    const { driver } = app;
    const field = (label) => By.xpath(`//main[@data-testid='landing-screen']//label[contains(normalize-space(.), '${label}')]//input`);
    await setFieldValue(driver, field("Artist"), "Neon Tide");
    await setFieldValue(driver, field("Album"), "Static Bloom");
    await click(driver, By.css(".landing-submit"));
    await driver.wait(until.elementLocated(byTestId("detail-view")), 20_000);
    await driver.wait(until.elementLocated(byTestId("research-error")), 30_000);
    await assertFits(driver, "1440 px studio with the research error");
    // Detect drives runs the stub cdrskin from the stubBin dir on PATH, which
    // logs to MXTP_E2E_STUB_LOG.
    await click(driver, byTestId("detect-burners"));
    await driver.wait(() => stubCalls(app).some((line) => line.startsWith("cdrskin")), 20_000, `the stub cdrskin never logged a call: ${JSON.stringify(stubCalls(app))}`);
  });

  it("the studio header has at most one green primary, in both themes", async (t) => {
    const { driver } = app;
    await click(driver, byTestId("save-project-button"));
    await driver.wait(async () => /Save project|Saved automatically/.test(await textOf(driver, byTestId("save-project-button"))), 10_000);
    for (const [theme, green] of [["light", GREEN_LIGHT], ["dark", GREEN_DARK]]) {
      await setTheme(driver, theme);
      const primaries = await driver.executeScript(`
        return [...document.querySelectorAll(".app-header button")]
          .filter((button) => button.getClientRects().length > 0 && getComputedStyle(button).backgroundImage.includes(arguments[0]))
          .map((button) => button.dataset.testid || button.textContent.trim());
      `, green);
      assert.ok(primaries.length <= 1, `${theme}: header primaries ${JSON.stringify(primaries)}`);
      if (primaries.length === 1) assert.equal(primaries[0], "go-button", `${theme}: the one header primary is GO`);
      const save = await styleOf(driver, '.app-header [data-testid="save-project-button"]', ["background-image"]);
      assert.equal(save["background-image"], "none", `${theme}: Save is an outline, not a gradient pill`);
      const back = await styleOf(driver, ".app-header .studio-back", ["background-image", "box-shadow"]);
      if (back) assert.deepEqual(back, { "background-image": "none", "box-shadow": "none" }, `${theme}: ← Library is a ghost link`);
      else t.diagnostic("no .studio-back yet (WP2 header not merged)");
    }
  });

  it("Y2K dark keeps the theme toggle segments and Delete distinct in the studio header", async () => {
    const { driver } = app;
    await setTheme(driver, "dark");
    const off = await styleOf(driver, '.app-header .theme-toggle button[aria-pressed="false"]', ["background-image", "background-color"]);
    const on = await styleOf(driver, '.app-header .theme-toggle button[aria-pressed="true"]', ["background-image"]);
    assert.equal(off["background-image"], "none", "the inactive segment is flat");
    assert.equal(off["background-color"], "rgba(0, 0, 0, 0)");
    assert.match(on["background-image"], /gradient/, "the active segment is raised");
    const deleteButton = await styleOf(driver, '.app-header [data-testid="delete-project-button"]', ["color"]);
    if (deleteButton) assert.equal(deleteButton.color, "rgb(255, 140, 178)", "Delete keeps its danger colour");
    await setTheme(driver, "light");
  });

  it("the studio fits a 420 px window in both themes and the background has no stray circles", async (t) => {
    const { driver } = app;
    await scrollToTop(driver);
    for (const theme of ["light", "dark"]) {
      await setWindowSize(driver, SIZES.narrow);
      await setTheme(driver, theme);
      await assertFits(driver, `420 px studio (${theme})`);
      const header = await boxes(driver, ".app-header");
      t.diagnostic(`${theme}: 420 px studio header is ${Math.round(header[0].height)}px tall`);
      if ((await boxes(driver, ".app-header .studio-back")).length) {
        assert.ok(header[0].height < 120, `${theme}: the 420 px studio header is ${Math.round(header[0].height)}px tall`);
        const [back, title] = [await boxes(driver, ".app-header .studio-back"), await boxes(driver, ".app-header .studio-title")];
        assert.ok(Math.abs(back[0].top + back[0].height / 2 - (title[0].top + title[0].height / 2)) < 8, `${theme}: back and title share the first row`);
      }
    }
    await setTheme(driver, "light");
    const background = await styleOf(driver, '[data-testid="detail-view"]', ["background-image"]);
    assert.doesNotMatch(background["background-image"], /radial-gradient/, "MXTP light: no white circles behind the assigned strip");
    await setWindowSize(driver, SIZES.desktop);
    const shots = await tour(driver, "studio", { before: () => scrollToTop(driver) });
    for (const shot of shots) assert.ok(shot.overflow <= 0, `${shot.mode}: studio overflows by ${shot.overflow}px`);
    await tour(driver, "studio-rail", { before: () => scrollToElement(driver, '[data-testid="assigned-strip"]', "start") });
  });

  it("a failed resource load reports the element tag, raw src and test id", async () => {
    const { driver } = app;
    await driver.executeScript(`const audio = document.createElement("audio"); audio.id = "wp8-probe"; audio.dataset.testid = "wp8-probe"; audio.setAttribute("src", ""); document.body.append(audio);`);
    const entry = await driver.wait(async () => ((await pageErrors(driver)) || []).find((error) => error.testid === "wp8-probe"), 10_000, "no resource error for the probe <audio src=''>");
    assert.equal(entry.type, "resource");
    assert.equal(entry.tag, "audio");
    assert.equal(entry.src, "");
    await driver.executeScript(`document.getElementById("wp8-probe").remove(); window.__e2eErrors.length = 0;`);
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(app.driver), []);
  });
});

describe("library: dark parity, capacity, targets, focus ring, sticky project banner", () => {
  let app;
  const it = failShots(() => app?.driver, "wp8-library");
  // A project card, not the album card of the same name. Before WP1 the card
  // is labelled by album and opens the ⋯ menu itself; with WP1 it is labelled
  // by project name and sits in .music-project-card.
  const projectCard = (...labels) => By.xpath(`//button[contains(@class,'music-album-card') and (${labels.map((label) => `@aria-label='Open ${label}'`).join(" or ")}) and (@aria-haspopup='menu' or parent::div[contains(@class,'music-project-card')])]`);

  async function openProject(...labels) {
    const { driver } = app;
    await click(driver, navButton("Projects"));
    await click(driver, projectCard(...labels));
    await driver.wait(until.elementLocated(byTestId("album-detail")), 15_000);
    await settle(driver);
  }

  before(async () => {
    app = await launch((dirs) => {
      writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]);
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
    });
    await app.driver.wait(until.elementLocated(byTestId("apple-library")), 20_000);
  });

  after(async () => {
    await app?.close();
  });

  it("this WebKit supports :has(), which the narrow burn-list layout depends on", async () => {
    assert.equal(await app.driver.executeScript("return CSS.supports('selector(:has(a))')"), true);
  });

  it("a 960 px window (half a 1920 screen) fits with an album open and 3 queued tracks", async () => {
    const { driver } = app;
    await openProject("Static Bloom", "Bloom Sessions");
    assert.equal((await driver.findElements(By.css(".music-queue-item"))).length, 3);
    await setWindowSize(driver, { width: 960, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await setTheme(driver, theme);
      await assertFits(driver, `960 px library (${theme})`);
    }
    await setTheme(driver, "light");
    await setWindowSize(driver, SIZES.desktop);
    await tour(driver, "library-album");
  });

  it("Y2K dark: undownloaded burn-list titles stay at full opacity and list controls are not pills", async () => {
    const { driver } = app;
    await setTheme(driver, "dark");
    const play = await styleOf(driver, ".music-queue-play:disabled", ["opacity", "filter"]);
    assert.equal(play.opacity, "1");
    assert.equal(play.filter, "none");
    for (const css of [".music-queue-item > button:last-child", ".music-queue-head button", ".music-sidebar nav button:not(.active):not([aria-current])"]) {
      const style = await styleOf(driver, css, ["background-image", "box-shadow"]);
      assert.equal(style["background-image"], "none", `${css} has no gloss`);
    }
    const secondary = await styleOf(driver, ".music-secondary-action", ["background-image"]);
    if (secondary) assert.equal(secondary["background-image"], "none", "New custom CD is an outline in dark");
    await setTheme(driver, "light");
    const lightSecondary = await styleOf(driver, ".music-secondary-action", ["background-image"]);
    if (lightSecondary) assert.equal(lightSecondary["background-image"], "none", "New custom CD is an outline in light");
  });

  it("burn-list, banner and theme controls are at least 24 px (remove buttons 28 px) in both themes", async () => {
    const { driver } = app;
    for (const theme of ["light", "dark"]) {
      await setTheme(driver, theme);
      const removes = await boxes(driver, ".music-queue-item > button:last-child");
      assert.equal(removes.length, 3);
      for (const box of removes) assert.ok(box.width >= 28 && box.height >= 28, `${theme}: remove ${JSON.stringify(box)}`);
      for (const css of [".music-queue-head button", ".music-project-mode-banner button", ".music-queue-project-mode button", ".music-sidebar .theme-toggle button"]) {
        const found = await boxes(driver, css);
        assert.ok(found.length > 0, `${theme}: ${css} rendered`);
        for (const box of found) assert.ok(box.width >= 24 && box.height >= 24, `${theme}: ${css} ${JSON.stringify(box)}`);
      }
    }
    await setTheme(driver, "light");
  });

  it("keyboard focus shows the --focus ring on album cards, the queue handle, the curator box and import buttons", async () => {
    const { driver } = app;
    for (const theme of ["light", "dark"]) {
      await setTheme(driver, theme);
      const focus = await resolveColor(driver, "var(--focus)");
      assert.equal(focus, theme === "light" ? "rgb(10, 127, 160)" : "rgb(66, 230, 255)");
      const ring = async (element, ringCss, what) => {
        assert.ok(await keyboardFocus(driver, element), `${theme}: Tab reaches ${what}`);
        const style = await driver.executeScript(
          "const el = arguments[1] ? arguments[0].closest(arguments[1]) : arguments[0]; const s = getComputedStyle(el); return { color: s.outlineColor, style: s.outlineStyle, width: s.outlineWidth };",
          element,
          ringCss
        );
        assert.deepEqual(style, { color: focus, style: "solid", width: "3px" }, `${theme}: ${what} ring`);
      };
      await ring(await driver.findElement(By.css(".music-queue-item .music-drag-handle")), null, "the queue handle");
      await click(driver, navButton("Albums"));
      await ring(await driver.wait(until.elementLocated(By.css(".music-album-grid .music-album-card")), 10_000), null, "an album card");
      const lift = await styleOf(driver, ".music-album-card:focus-visible", ["transform"]);
      assert.notEqual(lift?.transform ?? "none", "none", `${theme}: a focused album card lifts like hover`);
      await click(driver, navButton("AI Curator"));
      await ring(await driver.wait(until.elementLocated(By.css(".curator-composer textarea")), 10_000), null, "the curator box");
      await click(driver, navButton("Sources", "Music sources"));
      await ring(await driver.wait(until.elementLocated(By.css(".music-import-button input")), 10_000), ".music-import-button", "an import button");
      if (theme === "light") await tour(driver, "sources");
    }
    await setTheme(driver, "light");
  });

  it("over capacity: the bar is red in both themes, the time is red, and Burn CD reads as unavailable", async () => {
    const { driver } = app;
    await openProject("Marathon");
    await driver.wait(until.elementLocated(By.css('.music-capacity[data-over="true"]')), 10_000);
    for (const [theme, red, timeColor] of [["light", "rgb(221, 63, 104)", "rgb(194, 38, 79)"], ["dark", "rgb(255, 63, 122)", "rgb(255, 140, 178)"]]) {
      await setTheme(driver, theme);
      const bar = await styleOf(driver, ".music-capacity b", ["background-image"]);
      assert.ok(bar["background-image"].includes(red), `${theme}: bar ${bar["background-image"]}`);
      const time = await styleOf(driver, '.music-capacity[data-over="true"] > div span:first-child', ["color", "font-weight"]);
      assert.equal(time.color, timeColor);
      assert.equal(time["font-weight"], "800");
      const burn = await styleOf(driver, ".music-queue-actions .primary:disabled", ["background-image", "opacity"]);
      assert.deepEqual(burn, { "background-image": "none", opacity: "1" }, `${theme}: disabled Burn CD`);
    }
    await setTheme(driver, "light");
    await tour(driver, "queue-over-capacity", { before: () => scrollToElement(driver, ".music-capacity") });
  });

  it("the project banner stays in view after scrolling the narrow library", async () => {
    const { driver } = app;
    await setWindowSize(driver, SIZES.narrow);
    await driver.executeScript("window.scrollTo(0, document.documentElement.scrollHeight)");
    await settle(driver);
    const banner = await driver.executeScript(`
      const banner = document.querySelector(".music-project-mode-banner");
      const rect = banner.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, scrollY, viewport: innerHeight };
    `);
    await setWindowSize(driver, SIZES.desktop);
    assert.ok(banner.scrollY > 300, `the narrow library scrolled (${banner.scrollY}px)`);
    assert.ok(banner.top >= -1 && banner.bottom <= banner.viewport, `banner at ${Math.round(banner.top)}..${Math.round(banner.bottom)} after scrolling`);
  });

  it("the narrow burn-list peek bar stays docked, with its Burn CD, in both themes", async (t) => {
    const { driver } = app;
    await setWindowSize(driver, SIZES.narrow);
    if (!(await boxes(driver, ".music-queue-peek")).length) {
      t.diagnostic("no .music-queue-peek yet (WP1 burn list not merged)");
      await setWindowSize(driver, SIZES.desktop);
      return;
    }
    for (const theme of ["light", "dark"]) {
      await setTheme(driver, theme);
      await driver.executeScript("window.scrollTo(0, document.documentElement.scrollHeight)");
      await settle(driver);
      const bar = await driver.executeScript(`
        const bar = document.querySelector(".music-queue-peek-bar").getBoundingClientRect();
        const peek = document.querySelector(".music-queue-peek").getBoundingClientRect();
        return { top: bar.top, bottom: bar.bottom, height: bar.height, peekWidth: peek.width, viewport: innerHeight };
      `);
      assert.ok(bar.bottom <= bar.viewport + 1 && bar.top >= 0, `${theme}: peek bar at ${Math.round(bar.top)}..${Math.round(bar.bottom)}`);
      assert.ok(bar.height >= 56 && bar.height < 90, `${theme}: peek bar is ${Math.round(bar.height)}px tall`);
      assert.ok(bar.peekWidth > 150, `${theme}: the peek toggle is ${Math.round(bar.peekWidth)}px wide`);
      await assertFits(driver, `420 px library with the peek bar (${theme})`);
    }
    await setTheme(driver, "light");
    await tour(driver, "library-peek", {
      modes: [MODES[2], MODES[3]],
      before: () => driver.executeScript("window.scrollTo(0, document.documentElement.scrollHeight)")
    });
  });

  it("two screenshots of a still screen match within a tolerant pixel diff", async () => {
    const { driver } = app;
    await scrollToTop(driver);
    const first = await driver.takeScreenshot();
    await settle(driver);
    const second = await driver.takeScreenshot();
    assert.ok(pixelDiff(first, second) < 0.02);
  });

  it("raised no page errors and wrote nothing into the machine's temp dir", async () => {
    assert.deepEqual(await pageErrors(app.driver), []);
    assert.deepEqual(appTempEntries(systemTmp), tmpBefore, `new app files in ${systemTmp}`);
  });
});
