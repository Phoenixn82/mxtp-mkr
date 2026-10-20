// WP7 helpers (curator, help coach, theme toggle). Screenshots are
// tour-wp7-<screen>-<mode>.png in desktop light, desktop dark and narrow light.
import { SIZES, screenshot, setWindowSize, settle } from "../helpers.mjs";
import { applyTheme, horizontalOverflow } from "./proj.mjs";

export const WP7_MODES = [
  { name: "desktop-light", size: SIZES.desktop, theme: "light" },
  { name: "desktop-dark", size: SIZES.desktop, theme: "dark" },
  { name: "narrow-light", size: SIZES.narrow, theme: "light" }
];

/**
 * Screenshot one screen in every WP7 mode. `reset` closes overlays so the theme
 * goes through the app's own toggle; `before` reopens the state at this size.
 */
export async function tourWp7(driver, screen, { reset, before } = {}) {
  const shots = [];
  for (const mode of WP7_MODES) {
    if (reset) await reset(mode);
    await setWindowSize(driver, mode.size);
    await applyTheme(driver, mode.theme);
    if (before) await before(mode);
    await settle(driver);
    const file = await screenshot(driver, `tour-wp7-${screen}-${mode.name}`);
    shots.push({ file, mode: mode.name, overflow: await horizontalOverflow(driver) });
  }
  await setWindowSize(driver, SIZES.desktop);
  await applyTheme(driver, "light");
  return shots;
}

/** Whether the element's centre is the topmost thing there once `.mxtp-coach` is ignored. */
export async function uncoveredUnderCoach(driver, selector) {
  return driver.executeScript(`
    const node = document.querySelector(arguments[0]);
    if (!node) return { found: false };
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const coach = document.querySelector(".mxtp-coach");
    const onTop = document.elementFromPoint(x, y);
    if (coach) coach.style.pointerEvents = "none";
    const beneath = document.elementFromPoint(x, y);
    if (coach) coach.style.pointerEvents = "";
    const describe = (el) => el ? el.tagName.toLowerCase() + (el.className ? "." + String(el.className).trim().split(/\\s+/).join(".") : "") : "nothing";
    return {
      found: true,
      inView: rect.top >= 0 && rect.bottom <= innerHeight,
      coachOnTop: Boolean(coach && coach.contains(onTop)),
      uncovered: Boolean(beneath && (beneath === node || node.contains(beneath))),
      beneath: describe(beneath),
      rect: [rect.top, rect.bottom].map(Math.round),
      viewport: innerHeight
    };
  `, selector);
}
