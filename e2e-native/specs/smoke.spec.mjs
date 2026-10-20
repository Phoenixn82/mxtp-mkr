// Cold launch of the real release binary: main UI visible, light + dark at
// desktop and narrow sizes, no page errors, clean close.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import {
  SIZES,
  installErrorCollector,
  launchApp,
  pageErrors,
  screenshot,
  setTheme,
  setWindowSize,
  waitForReady
} from "../helpers.mjs";

describe("cold launch smoke", () => {
  let app;

  before(async () => {
    app = await launchApp();
    await waitForReady(app.driver);
    await installErrorCollector(app.driver);
  });

  after(async () => {
    await app?.close();
  });

  it("shows the landing screen", async () => {
    const landing = await app.driver.findElement(By.css('[data-testid="landing-screen"]'));
    assert.ok(await landing.isDisplayed(), "landing screen is not displayed");
    assert.equal(await app.driver.getTitle(), "MXTP MKR");
  });

  it("has WebGL for the 3D case preview", async () => {
    const renderer = await app.driver.executeScript(`
      const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    `);
    console.log(`webgl renderer: ${renderer}`);
    assert.ok(renderer, "WebGL is unavailable in the webview");
  });

  for (const [sizeName, size] of Object.entries(SIZES)) {
    for (const theme of ["light", "dark"]) {
      it(`renders ${theme} at ${sizeName} ${size.width}x${size.height}`, async () => {
        await setWindowSize(app.driver, size);
        await setTheme(app.driver, theme);
        const landing = await app.driver.findElement(By.css('[data-testid="landing-screen"]'));
        assert.ok(await landing.isDisplayed());
        await screenshot(app.driver, `smoke-${sizeName}-${theme}`);
      });
    }
  }

  it("kept app data inside the temp HOME", () => {
    // WebKit and Tauri create their per-app dirs under XDG_* on launch; finding
    // them here proves the app honoured the temp roots, not the real HOME.
    const created = [app.dirs.XDG_DATA_HOME, app.dirs.XDG_CACHE_HOME].flatMap((dir) => readdirSync(dir));
    assert.ok(created.length > 0, "app wrote nothing under the temp XDG dirs");
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(app.driver), []);
  });
});
