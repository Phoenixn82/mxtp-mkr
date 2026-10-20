// Shared checks for the styles / accessibility / harness specs
// (e2e-native/specs/proj-wp8-*.spec.mjs). Computed styles and geometry are
// read from the real WebKitGTK webview.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { By, Key } from "selenium-webdriver";
import { SIZES, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";

export const PROJ_BIN = path.resolve(import.meta.dirname, "../fixtures/proj/bin");

export const MODES = [
  { name: "desktop-light", size: SIZES.desktop, theme: "light" },
  { name: "desktop-dark", size: SIZES.desktop, theme: "dark" },
  { name: "narrow-light", size: SIZES.narrow, theme: "light" },
  { name: "narrow-dark", size: SIZES.narrow, theme: "dark" }
];

/** How far the page scrolls sideways (<= 0 means it fits). */
export function horizontalOverflow(driver) {
  return driver.executeScript(
    "return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth"
  );
}

/**
 * How far any match of `css` reaches past the window's right edge (<= 0 fits).
 * A container with overflow-x: hidden hides this from horizontalOverflow.
 */
export function clippedOverflow(driver, css) {
  return driver.executeScript(`
    const rights = [...document.querySelectorAll(arguments[0])].filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().right);
    return rights.length ? Math.max(...rights) - window.innerWidth : 0;
  `, css);
}

/** The elements sticking out furthest past the right edge (for failure messages). */
export function overflowCulprits(driver, limit = 4) {
  return driver.executeScript(`
    const width = window.innerWidth;
    const found = [];
    for (const node of document.querySelectorAll("body *")) {
      if (node.closest("[hidden]")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= width + 1) continue;
      if (found.some((item) => item.node.contains(node))) continue;
      found.push({ node, right: Math.round(rect.right - width) });
    }
    return found.sort((a, b) => b.right - a.right).slice(0, arguments[0]).map(({ node, right }) =>
      node.tagName.toLowerCase() + (typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\\s+/).join(".") : "") + (node.dataset.testid ? "[data-testid=" + node.dataset.testid + "]" : "") + " +" + right + "px");
  `, limit);
}

/** Selected computed style properties of the first visible match. */
export function styleOf(driver, css, props) {
  return driver.executeScript(`
    const el = [...document.querySelectorAll(arguments[0])].find((node) => node.getClientRects().length > 0 && !node.closest("[hidden]"));
    if (!el) return null;
    const style = getComputedStyle(el);
    return Object.fromEntries(arguments[1].map((prop) => [prop, style.getPropertyValue(prop)]));
  `, css, props);
}

/** A CSS colour (e.g. var(--focus)) resolved to rgb() the way getComputedStyle reports it. */
export function resolveColor(driver, value) {
  return driver.executeScript(`
    const probe = document.createElement("i");
    probe.style.color = arguments[0];
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  `, value);
}

/** Bounding boxes of every visible match. */
export function boxes(driver, css) {
  return driver.executeScript(`
    return [...document.querySelectorAll(arguments[0])]
      .filter((node) => node.getClientRects().length > 0 && !node.closest("[hidden]"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { label: (node.getAttribute("aria-label") || node.textContent || node.tagName).trim().slice(0, 40), width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
      });
  `, css);
}

/**
 * Give `element` keyboard focus the way a user does: focus it, step back with
 * Shift+Tab, then Tab onto it, so :focus-visible applies.
 */
export async function keyboardFocus(driver, element) {
  await driver.executeScript("arguments[0].scrollIntoView({ block: 'center' }); arguments[0].focus()", element);
  await driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).sendKeys(Key.TAB).perform();
  await settle(driver);
  return driver.executeScript("return document.activeElement === arguments[0]", element);
}

/** tour-wp8-<screen>-<mode>.png in desktop light and dark, and narrow light and dark. */
export async function tour(driver, screen, { before, modes = MODES } = {}) {
  const shots = [];
  for (const mode of modes) {
    await setWindowSize(driver, mode.size);
    await setTheme(driver, mode.theme);
    if (before) await before(mode);
    await driver.executeScript("return document.fonts ? document.fonts.ready.then(() => true) : true");
    const file = await screenshot(driver, `tour-wp8-${screen}-${mode.name}`);
    shots.push({ file, mode: mode.name, overflow: await horizontalOverflow(driver) });
  }
  await setWindowSize(driver, SIZES.desktop);
  await setTheme(driver, "light");
  return shots;
}

/** Environment of this run's app process (the one whose HOME is `home`). */
export function appProcessEnv(home) {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "latin1");
      if (!/mxtp-mkr/.test(cmd.split("\0")[0] ?? "")) continue;
      const env = Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean).map((entry) => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)];
        })
      );
      if (env.HOME === home) return env;
    } catch {
      // process went away
    }
  }
  return null;
}

/** Names the app writes straight into a temp dir (caches, covers, scratch audio). */
export function appTempEntries(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith("mxtp_mkr")).sort();
  } catch {
    return [];
  }
}

/** A library nav button by any of its names (labels change across packages). */
export const navButton = (...names) =>
  By.xpath(`//nav[@aria-label='Music library']/button[${names.map((name) => `starts-with(normalize-space(.), '${name}') or @aria-label='${name}'`).join(" or ")}]`);
