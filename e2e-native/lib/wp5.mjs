// WP5 helpers: research caches keyed the way research.rs keys them now
// (slug + FNV-1a 64), and tour screenshots named tour-wp5-<screen>-<mode>.png.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { SIZES, installErrorCollector, launchApp, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";
import { artEnv, artPaths, scrollTo } from "./art.mjs";

// Keep the WP5 names for existing specs; every art fixture uses the same cache key.
export { rustCacheKey, seedLyricsCache as seedLyricsCacheHashed, seedAlbumCache as seedAlbumCacheHashed } from "./art.mjs";

const MODES = {
  "desktop-light": [SIZES.desktop, "light"],
  "desktop-dark": [SIZES.desktop, "dark"],
  "narrow-light": [SIZES.narrow, "light"]
};

/** tour-wp5-<screen>-<mode>.png in desktop light, desktop dark and narrow light; ends at desktop light. */
export async function tourWp5(driver, screen, focus, modes = Object.keys(MODES)) {
  const files = [];
  for (const mode of modes) {
    const [size, theme] = MODES[mode];
    await setWindowSize(driver, size);
    await setTheme(driver, theme);
    if (focus) await scrollTo(driver, focus, "start");
    await settle(driver);
    files.push(await screenshot(driver, `tour-wp5-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  await setTheme(driver, "light");
  if (focus) await scrollTo(driver, focus, "start");
  return files;
}

/**
 * art.mjs startApp, but patient about the first painted frame: on a loaded
 * build host the landing 3D case can hold the main thread past the 30 s script
 * timeout, so settle is retried instead of failing the whole suite (and
 * leaking the app, since `after` never sees it).
 */
export async function startAppPatient({ stub, env = {}, seed, home, keepHome = false } = {}) {
  const appHome = home ?? mkdtempSync(path.join(tmpdir(), "mxtp-e2e-art-"));
  mkdirSync(artPaths(appHome).tmp, { recursive: true });
  mkdirSync(artPaths(appHome).out, { recursive: true });
  const app = await launchApp({
    home: appHome,
    keepHome,
    seed: seed ? (dirs) => seed(dirs, appHome) : undefined,
    env: artEnv(appHome, stub, env)
  });
  try {
    await app.driver.wait(until.elementLocated(By.css("#root > *")), 120_000);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await settle(app.driver);
        break;
      } catch (error) {
        if (attempt >= 6) throw error;
      }
    }
    await installErrorCollector(app.driver);
    await setWindowSize(app.driver, SIZES.desktop);
    await setTheme(app.driver, "light");
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
