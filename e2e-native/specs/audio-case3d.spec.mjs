import { stableShot } from "../lib/wp6.mjs";
// 3D case studio (studio Preview panel): the procedural jewel case opens and ejects
// its disc from canvas clicks, non-jewel formats answer Rotate / Flip, and every case format renders under WebKitGTK's (software) WebGL.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import { pageErrors, settle } from "../helpers.mjs";
import {
  byTestId,
  clickWhenEnabled,
  launchStudio,
  makeProject,
  openProjectFromLanding,
  pixelDiff,
  resourceFailures,
  seedArt,
  seedProject,
  slotArt,
  tour,
  TOUR_MODES
} from "../lib/audio.mjs";

const OTHER_FORMATS = ["vinyl", "gatefold", "vinyl7", "digipak", "cassette", "bluray", "slimcd", "cardsleeve", "minidisc", "8track"];

// Software WebGL never repaints byte-identically; compare pixels with a tolerance.
const CHANGED = 0.02; // > 2% of pixels differ = a visible change

/** Pointer click at a fraction of the element's box (WebDriver offsets are from the centre). */
async function clickAt(driver, element, fx, fy) {
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", element);
  const rect = await element.getRect();
  await driver.actions({ async: true })
    .move({ origin: element, x: Math.round((fx - 0.5) * rect.width), y: Math.round((fy - 0.5) * rect.height) })
    .press()
    .release()
    .perform();
}

const caseState = (driver) => driver.executeScript("return document.querySelector('[data-testid=case-scene]').dataset.caseState");

describe("3D case studio", () => {
  let app;
  let driver;
  const projects = {};
  let ejectedShot;

  before(async () => {
    app = await launchStudio({
      seed(dirs) {
        const art = seedArt(dirs);
        const allArt = [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.disc)];
        projects.jewel = seedProject(dirs, makeProject({ id: "e2e-jewel", album: "Jewel Case", art: allArt }));
        projects.dvd = seedProject(dirs, makeProject({ id: "e2e-dvdcase", album: "DVD Case", formatId: "dvdcase", art: allArt }));
        // Same front and tray, different disc label: the ejected disc must differ.
        projects.otherDisc = seedProject(dirs, makeProject({ id: "e2e-jewel-other-disc", album: "Other Disc", art: [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.front)] }));
        projects.bare = seedProject(dirs, makeProject({ id: "e2e-jewel-bare", album: "No Art Yet", art: [] }));
        for (const formatId of OTHER_FORMATS) {
          projects[formatId] = seedProject(dirs, makeProject({ id: `e2e-format-${formatId}`, album: `Format ${formatId}`, formatId, art: allArt }));
        }
      }
    });
    driver = app.driver;
  });

  after(async () => app?.close());

  async function openProject(project) {
    await openProjectFromLanding(driver, project);
    const scene = await driver.wait(until.elementLocated(byTestId("case-scene")), 15_000);
    await driver.wait(until.elementLocated(By.css("[data-testid=case-scene] canvas")), 15_000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", scene);
    await settle(driver);
    return scene;
  }

  // ---------- jewel case ----------

  it("shows the jewel case closed, textured with the project's art", async () => {
    const scene = await openProject(projects.jewel);
    assert.equal(await caseState(driver), "closed");
    assert.equal(await (await driver.findElement(byTestId("preview-hint"))).getText(), "drag to orbit · click or press Enter to open · click the disc or press E to eject");
    for (const slot of ["front", "back", "disc"]) {
      assert.match(await scene.getAttribute(`data-${slot}`), /art-(front|tray|disc)\.png$/, `${slot} texture`);
    }
    const shot = await stableShot(driver, await scene.findElement(By.css("canvas")));
    assert.ok(Buffer.from(shot, "base64").length > 20_000, "the WebGL canvas rendered a real image, not a blank frame");
    await tour(driver, "case3d-jewel-closed", { focus: scene });
  });

  it("opens the case when it is clicked", async () => {
    const canvas = await driver.findElement(By.css("[data-testid=case-scene] canvas"));
    const closed = await stableShot(driver, canvas);
    await clickAt(driver, canvas, 0.54, 0.52);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000, "the case never opened");
    assert.equal(await (await driver.findElement(byTestId("case-scene"))).getAttribute("data-open"), "true");
    const diff = pixelDiff(await stableShot(driver, canvas), closed);
    assert.ok(diff > CHANGED, `the lid visibly moved (${(diff * 100).toFixed(1)}% of pixels changed)`);
    await tour(driver, "case3d-jewel-open", { focus: byTestId("case-scene") });
  });

  it("ejects the disc when the open disc is clicked, and seats it again on a second click", async () => {
    const canvas = await driver.findElement(By.css("[data-testid=case-scene] canvas"));
    await stableShot(driver, canvas);
    await clickAt(driver, canvas, 0.62, 0.54);
    await driver.wait(async () => (await caseState(driver)) === "ejected", 10_000, "the disc never ejected");
    assert.equal(await (await driver.findElement(byTestId("case-scene"))).getAttribute("data-ejected"), "true");
    ejectedShot = await stableShot(driver, canvas);
    await tour(driver, "case3d-jewel-ejected", { focus: byTestId("case-scene") });
    await stableShot(driver, canvas);
    await clickAt(driver, canvas, 0.62, 0.54);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000, "the disc never went back in");
  });

  it("can be opened from the keyboard", async () => {
    const scene = await driver.findElement(byTestId("case-scene"));
    assert.equal(await scene.getAttribute("tabindex"), "0", "the case is keyboard reachable");
    await scene.sendKeys(Key.ENTER);
    await driver.wait(async () => (await caseState(driver)) === "closed", 10_000, "Enter never closed the open case");
    await scene.sendKeys(Key.ENTER);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000, "Enter never opened the case");
  });

  it("prints the project's disc art on the ejected disc", async () => {
    await openProject(projects.otherDisc);
    const canvas = await driver.findElement(By.css("[data-testid=case-scene] canvas"));
    await stableShot(driver, canvas);
    await clickAt(driver, canvas, 0.54, 0.52);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000, "the case never opened");
    await stableShot(driver, canvas);
    await clickAt(driver, canvas, 0.62, 0.54);
    await driver.wait(async () => (await caseState(driver)) === "ejected", 10_000, "the disc never ejected");
    const diff = pixelDiff(await stableShot(driver, canvas), ejectedShot);
    assert.ok(diff > CHANGED, `a different disc label should render a different ejected disc (${(diff * 100).toFixed(2)}% of pixels differ)`);
  });

  it("shows an untextured case when no art is assigned yet", async () => {
    const scene = await openProject(projects.bare);
    assert.equal(await scene.getAttribute("data-front"), "");
    assert.equal(await caseState(driver), "closed");
    await tour(driver, "case3d-jewel-no-art", { focus: scene });
  });

  // ---------- non-jewel formats ----------

  it("turns a DVD case with Rotate and Flip", async () => {
    const scene = await openProject(projects.dvd);
    assert.equal((await driver.findElements(byTestId("preview-hint"))).length, 0);
    const canvas = await scene.findElement(By.css("canvas"));
    let before = await stableShot(driver, canvas);
    for (const control of ["rotate-preview", "flip-booklet"]) {
      await clickWhenEnabled(driver, byTestId(control));
      const after = await stableShot(driver, canvas);
      const diff = pixelDiff(after, before);
      assert.ok(diff > CHANGED, `${control} did not change the rendered case (${(diff * 100).toFixed(2)}% of pixels)`);
      before = after;
    }
    await tour(driver, "case3d-dvdcase", { focus: scene });
  });

  it("non-jewel cases have no Lid or Spin buttons", async () => {
    assert.equal((await driver.findElements(byTestId("open-lid"))).length, 0);
    assert.equal((await driver.findElements(byTestId("spin-disc"))).length, 0);
  });

  it("draws no flat cover overlay while the 3D case renders", async () => {
    assert.equal((await driver.findElements(byTestId("case-front-cover"))).length, 0);
    assert.equal((await driver.findElements(By.css("[data-testid=case-scene] canvas"))).length, 1);
  });

  it("renders every other case format", async () => {
    for (const formatId of OTHER_FORMATS) {
      const scene = await openProject(projects[formatId]);
      assert.equal(await scene.getAttribute("data-case-state"), "closed", formatId);
      assert.equal((await driver.findElements(By.css(".app-error-boundary"))).length, 0, `${formatId} crashed the view`);
      const shot = await stableShot(driver, await scene.findElement(By.css("canvas")));
      assert.ok(Buffer.from(shot, "base64").length > 20_000, `${formatId} canvas looks blank`);
      await tour(driver, `preview-${formatId}`, { focus: scene, modes: TOUR_MODES.slice(0, 3) });
    }
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await resourceFailures(driver), []);
    assert.deepEqual(await pageErrors(driver), []);
  });
});
