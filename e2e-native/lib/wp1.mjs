// WP1 library specs (lib-wp1-*.spec.mjs): the screenshot tour named
// tour-wp1-<screen>-<mode>.png in desktop light, desktop dark and narrow light.
import { SIZES, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";
import { scrollTop } from "./lib.mjs";

export const WP1_MODES = ["desktop-light", "desktop-dark", "narrow-light"];

async function theme(driver) {
  return driver.executeScript("return document.documentElement.dataset.theme");
}

/** `prepare` re-runs after every resize for state a resize resets; `keepScroll` skips scroll-to-top. */
export async function tourWp1(driver, screen, { prepare, keepScroll = false, modes = WP1_MODES } = {}) {
  const files = [];
  for (const mode of modes) {
    const [size, wanted] = mode.split("-");
    await setWindowSize(driver, SIZES.desktop);
    if ((await theme(driver)) !== wanted) await setTheme(driver, wanted);
    if (size === "narrow") await setWindowSize(driver, SIZES.narrow);
    if (prepare) await prepare(mode);
    if (!keepScroll) await scrollTop(driver);
    await settle(driver);
    files.push(await screenshot(driver, `tour-wp1-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  if ((await theme(driver)) !== "light") await setTheme(driver, "light");
  return files;
}
