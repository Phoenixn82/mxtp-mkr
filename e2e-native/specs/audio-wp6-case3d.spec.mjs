// WP6: 3D previews on the real app (software WebGL under Xvfb). The procedural jewel
// case opens and ejects from the keyboard and carries tray and disc art; non-jewel
// cases offer Rotate and Flip only with no flat overlay; a missing art file degrades
// to the 2D fallback instead of crashing the studio; the landing case renders.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import { pageErrors, settle } from "../helpers.mjs";
import {
  byTestId,
  clickWhenEnabled,
  launchStudio,
  makeProject,
  mxtpDir,
  openProjectFromLanding,
  pixelDiff,
  resourceFailures,
  seedArt,
  seedProject,
  slotArt
} from "../lib/audio.mjs";
import { startCustomFromLibrary } from "../lib/wp2.mjs";
import { canvasHasContent, caseState, sceneCanvas, stableShot, tourWp6 } from "../lib/wp6.mjs";

const CHANGED = 0.02; // > 2% of pixels differ = a visible change
const MISSING = "missing-front.png";

describe("WP6 3D previews", () => {
  let app;
  let driver;
  const projects = {};
  let ejectedShot;

  before(async () => {
    app = await launchStudio({
      seed(dirs) {
        const art = seedArt(dirs);
        const missing = path.join(mxtpDir(dirs), "e2e-art", MISSING);
        const allArt = [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.disc)];
        projects.jewel = seedProject(dirs, makeProject({ id: "wp6-jewel", album: "Jewel Case", art: allArt }));
        projects.otherDisc = seedProject(dirs, makeProject({ id: "wp6-other-disc", album: "Other Disc", art: [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.front)] }));
        projects.dvd = seedProject(dirs, makeProject({ id: "wp6-dvdcase", album: "DVD Case", formatId: "dvdcase", art: allArt }));
        projects.cassetteMissing = seedProject(dirs, makeProject({ id: "wp6-cassette-missing", album: "Lost Cover", formatId: "cassette", art: [slotArt("front", missing), slotArt("tray", art.tray)] }));
        projects.jewelMissing = seedProject(dirs, makeProject({ id: "wp6-jewel-missing", album: "Lost Jewel Cover", art: [slotArt("front", missing), slotArt("disc", art.disc)] }));
      }
    });
    driver = app.driver;
  });

  after(async () => app?.close());

  async function openProject(project, { canvas = true } = {}) {
    await openProjectFromLanding(driver, project);
    const scene = await driver.wait(until.elementLocated(byTestId("case-scene")), 15_000);
    if (canvas) await driver.wait(until.elementLocated(By.css("[data-testid=case-scene] canvas")), 15_000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", scene);
    await settle(driver);
    return scene;
  }

  async function keyOnScene(key) {
    const scene = await driver.findElement(byTestId("case-scene"));
    await driver.executeScript("arguments[0].focus()", scene);
    await scene.sendKeys(key);
  }

  it("renders the jewel case and opens and ejects it from the keyboard", async () => {
    const scene = await openProject(projects.jewel);
    assert.equal(await scene.getAttribute("tabindex"), "0");
    assert.equal(await scene.getAttribute("role"), "group");
    assert.match(await (await driver.findElement(byTestId("preview-hint"))).getText(), /press Enter to open .* press E to eject/);
    assert.equal((await driver.findElements(byTestId("case-front-cover"))).length, 0, "no flat cover over the 3D model");
    const closed = await stableShot(driver, await sceneCanvas(driver));
    assert.ok(canvasHasContent(closed), "the WebGL canvas rendered a case, not a blank frame");
    await tourWp6(driver, "case3d-jewel-closed", { focus: scene });

    await keyOnScene(Key.ENTER);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000, "Enter did not open the case");
    const opened = await stableShot(driver, await sceneCanvas(driver));
    assert.ok(pixelDiff(opened, closed) > CHANGED, "the lid visibly opened");

    await keyOnScene("e");
    await driver.wait(async () => (await caseState(driver)) === "ejected", 10_000, "E did not eject the disc");
    ejectedShot = await stableShot(driver, await sceneCanvas(driver));
    await tourWp6(driver, "case3d-jewel-ejected", { focus: byTestId("case-scene") });
  });

  it("prints the project's disc art on the ejected disc", async () => {
    await openProject(projects.otherDisc);
    await keyOnScene(Key.ENTER);
    await driver.wait(async () => (await caseState(driver)) === "open", 10_000);
    await keyOnScene("e");
    await driver.wait(async () => (await caseState(driver)) === "ejected", 10_000);
    const other = await stableShot(driver, await sceneCanvas(driver));
    const diff = pixelDiff(other, ejectedShot);
    assert.ok(diff > CHANGED, `a different disc label renders a different ejected disc (${(diff * 100).toFixed(2)}% of pixels differ)`);
  });

  it("shows the tray art on the back of the jewel case", async () => {
    await openProject(projects.jewel);
    const canvas = await sceneCanvas(driver);
    const front = await stableShot(driver, canvas);
    const rect = await canvas.getRect();
    // OrbitControls turns 2π per canvas height of horizontal drag: half a height is a half turn.
    await driver.actions({ async: true })
      .move({ origin: canvas, x: 0, y: 0 })
      .press()
      .move({ origin: canvas, x: Math.round(rect.height / 4), y: 0, duration: 300 })
      .move({ origin: canvas, x: Math.round(rect.height / 2) - 4, y: 0, duration: 300 })
      .release()
      .perform();
    const back = await stableShot(driver, canvas);
    assert.ok(pixelDiff(back, front) > CHANGED, "dragging turned the case");
    assert.equal(await caseState(driver), "closed", "a drag is not a click");
    await tourWp6(driver, "case3d-jewel-back", { focus: byTestId("case-scene") });
  });

  it("keeps a jewel case with a missing front art file on screen", async () => {
    const scene = await openProject(projects.jewelMissing);
    assert.equal((await driver.findElements(By.css(".app-error-boundary"))).length, 0, "the studio crashed");
    assert.ok(canvasHasContent(await stableShot(driver, await scene.findElement(By.css("canvas")))), "bare case still renders");
  });

  it("offers Rotate and Flip only for a DVD case, with no flat overlay", async () => {
    const scene = await openProject(projects.dvd);
    for (const gone of ["open-lid", "spin-disc", "case-front-cover", "preview-hint"]) {
      assert.equal((await driver.findElements(byTestId(gone))).length, 0, `${gone} should not render`);
    }
    const canvas = await scene.findElement(By.css("canvas"));
    let before = await stableShot(driver, canvas);
    assert.ok(canvasHasContent(before), "the DVD case rendered");
    for (const control of ["rotate-preview", "flip-booklet"]) {
      await clickWhenEnabled(driver, byTestId(control));
      const afterShot = await stableShot(driver, canvas);
      assert.ok(pixelDiff(afterShot, before) > CHANGED, `${control} changed the rendered case`);
      before = afterShot;
    }
    await tourWp6(driver, "case3d-dvdcase", { focus: scene });
  });

  it("shows the 2D fallback, not a crash, when a non-jewel case's art file is missing", async () => {
    const scene = await openProject(projects.cassetteMissing, { canvas: false });
    const note = await driver.wait(until.elementLocated(By.css("[data-testid=case-scene] .canvas-fallback")), 20_000);
    assert.equal(await note.getText(), "3D preview unavailable");
    assert.equal((await driver.findElements(By.css(".app-error-boundary"))).length, 0, "the studio crashed");
    assert.ok(await driver.findElement(byTestId("detail-view")).isDisplayed());
    assert.equal(await driver.executeScript("const img = document.querySelector('[data-testid=case-front-cover]'); return !img || img.hidden"), true, "a broken cover image is hidden");
    await tourWp6(driver, "case3d-missing-art", { focus: scene });
  });

  it("renders the landing case for the jewel case and another format", async () => {
    await clickWhenEnabled(driver, byTestId("catalog-button"));
    await startCustomFromLibrary(driver);
    const model = await driver.findElement(byTestId("landing-case-model"));
    const canvas = await driver.wait(until.elementLocated(By.css("[data-testid=landing-case-model] canvas")), 15_000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", model);
    assert.ok(canvasHasContent(await stableShot(driver, canvas)), "landing jewel case rendered");
    await tourWp6(driver, "landing-jewel", { focus: model });
    await driver.executeScript(
      "const s = document.querySelector('.landing-format-field select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'vinyl'); s.dispatchEvent(new Event('change', { bubbles: true }))"
    );
    await driver.wait(async () => (await model.getAttribute("data-model-id")) === "vinyl", 5_000);
    const vinyl = await driver.wait(until.elementLocated(By.css("[data-testid=landing-case-model] canvas")), 15_000);
    assert.ok(canvasHasContent(await stableShot(driver, vinyl)), "landing vinyl rendered");
    await tourWp6(driver, "landing-vinyl", { focus: model });
  });

  it("raised no page errors besides the deliberately missing art file", async () => {
    const isMissingArt = (text) => typeof text === "string" && text.includes(MISSING.replace(".png", ""));
    assert.deepEqual((await resourceFailures(driver)).filter((failure) => !isMissingArt(failure.src)), []);
    assert.deepEqual(((await pageErrors(driver)) ?? []).filter((error) => !isMissingArt(error.message)), []);
  });
});
