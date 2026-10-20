// WP3 (persisted data model) native helpers: a three-mode screenshot tour
// named tour-wp3-<screen>-<mode>.png. Everything else comes from lib/proj.mjs.
import { SIZES, screenshot, setWindowSize, settle } from "../helpers.mjs";
import { applyTheme, horizontalOverflow } from "./proj.mjs";

export const WP3_MODES = [
  { name: "desktop-light", size: SIZES.desktop, theme: "light" },
  { name: "desktop-dark", size: SIZES.desktop, theme: "dark" },
  { name: "narrow-light", size: SIZES.narrow, theme: "light" }
];

/** Scroll vertically so `css` sits just below the sticky app header; never scrolls sideways. */
export async function scrollToTop(driver, css) {
  await driver.executeScript(
    `const el = document.querySelector(arguments[0]);
     if (!el) return;
     const header = document.querySelector(".app-header");
     const style = header && getComputedStyle(header);
     const offset = style && (style.position === "sticky" || style.position === "fixed") ? header.getBoundingClientRect().height + 8 : 8;
     window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset));`,
    css
  );
  await settle(driver);
}

/** Screenshot the current screen in each mode; returns [{ file, mode, overflow }]. */
export async function tourWp3(driver, screen, { before } = {}) {
  const shots = [];
  for (const mode of WP3_MODES) {
    await setWindowSize(driver, mode.size);
    await applyTheme(driver, mode.theme);
    if (before) await before(mode);
    await driver.executeScript("return document.fonts ? document.fonts.ready.then(() => true) : true");
    await settle(driver);
    const file = await screenshot(driver, `tour-wp3-${screen}-${mode.name}`);
    shots.push({ file, mode: mode.name, overflow: await horizontalOverflow(driver) });
  }
  await setWindowSize(driver, SIZES.desktop);
  await applyTheme(driver, "light");
  return shots;
}
