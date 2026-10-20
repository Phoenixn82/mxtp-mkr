// WP4 (Rust backend) native e2e helpers: a yt-dlp wrapper that makes every
// download "partly fail" like a real region-blocked entry, a direct Tauri
// invoke for backend contracts, and the tour-wp4-* screenshots.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SIZES, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";
import { YTDLP_STUB, scrollTop, ytdlpStubEnv } from "./lib.mjs";

export const BLOCKED_ERROR = "ERROR: [youtube] e2eGamma: Video unavailable. This video is not available in your country";

/**
 * The lib yt-dlp stub, except that every --extract-audio run ends the way real
 * yt-dlp does when one entry is blocked: the other files are written, then it
 * prints an ERROR line and exits 1. Progress lines are printed first so an
 * error message that dumps raw output would be obvious.
 */
export function partialYtdlpEnv(home, catalog) {
  const env = ytdlpStubEnv(home, catalog);
  const bin = path.join(home, "wp4-bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "yt-dlp");
  writeFileSync(wrapper, `#!/bin/sh
node ${JSON.stringify(YTDLP_STUB)} "$@"
rc=$?
for arg in "$@"; do
  if [ "$arg" = "--extract-audio" ]; then
    i=0
    while [ $i -lt 50 ]; do echo "[download]  $i.0% of 3.00MiB at 1.00MiB/s ETA 00:03"; i=$((i + 1)); done
    echo ${JSON.stringify(BLOCKED_ERROR)} >&2
    exit 1
  fi
done
exit $rc
`);
  chmodSync(wrapper, 0o755);
  return { ...env, MXTP_YTDLP_PATH: wrapper };
}

/** Call a Tauri command on the real app, bypassing any invoke guard. */
export async function invokeRaw(driver, command, args = {}) {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
      .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error) }));
  `, command, args);
  return result;
}

/** Load a local picture through the asset protocol, as the app's <img> tags do. */
export async function assetLoads(driver, file) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const image = new Image();
    image.onload = () => done(image.naturalWidth > 0);
    image.onerror = () => done(false);
    image.src = window.__TAURI_INTERNALS__.convertFileSrc(arguments[0], "asset");
  `, file);
}

export function scratchWavs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => /^mxtp_mkr_track_.*\.wav$/.test(name)) : [];
}

/**
 * Screenshot the current screen as tour-wp4-<screen>-<mode>.png for each mode
 * (desktop-light, desktop-dark, narrow-light by default), centred on `focus`
 * when given, then restore desktop light.
 */
export async function tour(driver, screen, { focus, modes = ["desktop-light", "desktop-dark", "narrow-light"] } = {}) {
  const files = [];
  for (const mode of modes) {
    const [size, theme] = mode.split("-");
    await setWindowSize(driver, SIZES.desktop);
    const current = await driver.executeScript("return document.documentElement.dataset.theme");
    if (current !== theme) await setTheme(driver, theme);
    if (size === "narrow") await setWindowSize(driver, SIZES.narrow);
    await scrollTop(driver);
    if (focus) {
      const element = await driver.findElement(focus);
      await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' })", element);
      // WebKitGTK under Xvfb can leave a freshly scrolled narrow view unpainted;
      // a second nudge after a frame repaints it.
      await settle(driver);
      await driver.executeScript("window.scrollBy(0, 1); window.scrollBy(0, -1); arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' })", element);
    }
    await settle(driver);
    // Invalidate the whole page once so stale tiles below the fold repaint.
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const root = document.documentElement;
      root.style.outline = "1px solid transparent";
      requestAnimationFrame(() => { root.style.outline = ""; requestAnimationFrame(() => requestAnimationFrame(done)); });
    `);
    files.push(await screenshot(driver, `tour-wp4-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  if ((await driver.executeScript("return document.documentElement.dataset.theme")) !== "light") await setTheme(driver, "light");
  return files;
}
