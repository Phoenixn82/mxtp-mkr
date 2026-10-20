// WP6 (studio audio panel + 3D previews) helpers on top of lib/audio.mjs.
import { By } from "selenium-webdriver";
import { SIZES, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";
import { decodePng, pixelDiff } from "./audio.mjs";

export const WP6_MODES = [
  ["desktop-light", SIZES.desktop, "light"],
  ["desktop-dark", SIZES.desktop, "dark"],
  ["narrow-light", SIZES.narrow, "light"]
];

/** tour-wp6-<screen>-<mode>.png in desktop light, desktop dark and narrow light. */
export async function tourWp6(driver, screen, { focus } = {}) {
  const files = [];
  for (const [mode, size, theme] of WP6_MODES) {
    await setWindowSize(driver, size);
    await setTheme(driver, theme);
    if (focus) {
      const elements = typeof focus.getTagName === "function" ? [focus] : await driver.findElements(focus);
      if (elements[0]) await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", elements[0]);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle(driver);
    await settle(driver);
    files.push(await screenshot(driver, `tour-wp6-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  await setTheme(driver, "light");
  return files;
}

/** Element screenshot once the canvas stops changing (software WebGL never repaints byte-identically).
 * 180 s: under a loaded build host the software-GL spring and lerp animations run at 1-2 fps. */
export async function stableShot(driver, element, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = await element.takeScreenshot();
  let lastDiff = 1;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const next = await element.takeScreenshot();
    lastDiff = pixelDiff(previous, next);
    if (lastDiff < 0.003) return next;
    previous = next;
  }
  throw new Error(`canvas never settled within ${timeoutMs}ms (last diff ${(lastDiff * 100).toFixed(2)}%)`);
}

/**
 * A rendered WebGL frame, not a blank or single-colour one: at least `minShare` of
 * pixels differ from the frame's dominant colour.
 */
export function canvasHasContent(base64, minShare = 0.02) {
  const png = decodePng(base64);
  const counts = new Map();
  const step = 4;
  let total = 0;
  for (let i = 0; i < png.width * png.height; i += step) {
    const o = i * png.bpp;
    const key = `${png.data[o] >> 4},${png.data[o + 1] >> 4},${png.data[o + 2] >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  const dominant = Math.max(...counts.values());
  return (total - dominant) / total >= minShare;
}

export const caseState = (driver) => driver.executeScript("return document.querySelector('[data-testid=case-scene]').dataset.caseState");
export const sceneCanvas = (driver) => driver.findElement(By.css("[data-testid=case-scene] canvas"));
