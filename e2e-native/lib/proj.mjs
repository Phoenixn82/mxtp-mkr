// Shared helpers for the app-shell + project-lifecycle native specs
// (e2e-native/specs/proj-*.spec.mjs). Data formats mirror the app source:
//   projects   -> src/project/catalog.ts CdProject, stored by
//                 src-tauri/src/project_store.rs at
//                 <app_local_data_dir>/MXTP MKR/projects/<id>.json
//   libraries  -> src/library/multiLibrary.ts ImportedMusicSource[], stored at
//                 <app_local_data_dir>/MXTP MKR/libraries.json
// app_local_data_dir on Linux = $XDG_DATA_HOME/com.phoenix.mxtpmkr (identifier
// in tauri.conf.json, app_data.rs).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import {
  SIZES,
  installErrorCollector,
  launchApp,
  pageErrors,
  screenshot,
  setTheme,
  setWindowSize,
  settle,
  waitForReady
} from "../helpers.mjs";

export { By, Key, until };
export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/proj");
const STUB_BIN = path.join(FIXTURES, "bin");
// A closed local port: every HTTP call the app makes fails fast instead of
// reaching the internet.
const DEAD_URL = "http://127.0.0.1:9";

/**
 * Offline, burn-safe environment for every launch:
 * - yt-dlp stub (MXTP_YTDLP_PATH) fails every lookup/download;
 * - cdrskin stub first on PATH fails `--device_links`, so no burner is ever
 *   detected (burn.rs list_burners_linux) and no real burn can start;
 * - MusicBrainz / Cover Art Archive / image backends point at a dead port;
 * - HTTP(S)_PROXY to a dead port catches the remaining reqwest calls (lyrics),
 *   localhost stays direct for tauri-driver/WebKitWebDriver.
 */
export function offlineEnv(extra = {}) {
  return {
    PATH: `${STUB_BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    MXTP_YTDLP_PATH: path.join(STUB_BIN, "yt-dlp"),
    MXTP_MKR_IMAGEGEN: "mock",
    MXTP_MKR_MUSICBRAINZ_BASE_URL: DEAD_URL,
    MXTP_MKR_CAA_BASE_URL: DEAD_URL,
    MXTP_MKR_POLLINATIONS_BASE_URL: DEAD_URL,
    MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS: "0",
    MXTP_MKR_CAA_RETRY_DELAY_MS: "0",
    MXTP_MKR_MUSICBRAINZ_THROTTLE_MS: "0",
    FREELLMAPI_BASE_URL: DEAD_URL,
    HTTP_PROXY: DEAD_URL,
    HTTPS_PROXY: DEAD_URL,
    http_proxy: DEAD_URL,
    https_proxy: DEAD_URL,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...extra
  };
}

// ---------------------------------------------------------------- app data

export function appDataDir(dirs) {
  return path.join(dirs.XDG_DATA_HOME, "com.phoenix.mxtpmkr");
}

export function projectsDir(dirs) {
  return path.join(appDataDir(dirs), "MXTP MKR", "projects");
}

export function writeProject(dirs, project) {
  mkdirSync(projectsDir(dirs), { recursive: true });
  writeFileSync(path.join(projectsDir(dirs), `${project.id}.json`), JSON.stringify(project, null, 2));
}

export function writeRawProjectFile(dirs, fileName, text) {
  mkdirSync(projectsDir(dirs), { recursive: true });
  writeFileSync(path.join(projectsDir(dirs), fileName), text);
}

export function projectFiles(dirs) {
  const dir = projectsDir(dirs);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export function readProject(dirs, id) {
  const file = path.join(projectsDir(dirs), `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function savedProjectsOnDisk(dirs) {
  return projectFiles(dirs)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(projectsDir(dirs), name), "utf8")));
}

export function writeLibraries(dirs, sources) {
  const dir = path.join(appDataDir(dirs), "MXTP MKR");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "libraries.json"), JSON.stringify(sources));
}

/** Short synthetic stereo 44.1 kHz 16-bit sine WAV (no copyrighted audio). */
export function writeToneWav(file, { freq = 440, seconds = 2 } = {}) {
  const rate = 44_100;
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767);
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// ---------------------------------------------------------------- fixtures

function normalizeKey(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

/** albumIdentity / albumKey from catalog.ts + appleMusic.ts. */
export function albumKey(artist, album) {
  return `${normalizeKey(artist)}::${normalizeKey(album)}`;
}

/** A saved CdProject exactly as save_cd_project writes it. */
export function makeProject({
  id,
  name,
  artist = "",
  album = "",
  formatId = "jewelcase",
  kind,
  saved = true,
  queue = [],
  updatedAt = "2026-09-01T12:00:00.000Z",
  curator,
  ...rest
}) {
  const tracks = queue.flatMap((item) => (item.ready ? [item.ready] : []));
  return {
    id,
    name: name ?? (album || "Untitled CD"),
    kind: kind ?? (artist && album ? "artist" : "custom"),
    saved,
    entry: { artist, album, formatId },
    burnQueue: queue,
    tracks,
    art: [],
    researchApplied: [],
    research: null,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt,
    ...(curator ? { curator } : {}),
    ...rest
  };
}

/** A CdBurnItem; pass `wav` (absolute path) to make it "audio ready". */
export function makeQueueItem({ id, title, artist, album, durationSec = 180, trackNumber, wav }) {
  return {
    id,
    albumKey: albumKey(artist, album),
    title,
    artist,
    album,
    durationSec,
    trackNumber,
    ...(wav ? { ready: { id: `${id}-audio`, title, artist, album, durationSec, path: wav, sampleRate: 44_100, channels: 2 } } : {})
  };
}

/**
 * A Spotify ImportedMusicSource as parseMusicExport/addSourceTrack builds it
 * (sourceStats[0] carries the per-source stats; ids are spotify:<hash>).
 * Track/artist names are fictional.
 */
export function makeSpotifySource(tracks, importedAt = "2026-09-01T10:00:00.000Z") {
  const limitations = [
    "Extended Streaming History provides dated lifetime listening events and milliseconds played; library exports add saved-track state.",
    "Genre, track number, and artwork are not present in Spotify privacy-history JSON."
  ];
  return {
    source: "spotify",
    sourcePath: "Streaming_History_Audio_2026.json",
    importedAt,
    playlists: [],
    limitations,
    tracks: tracks.map((track, index) => {
      const lastPlayed = Date.parse(track.lastPlayed ?? "2026-08-01T12:00:00Z") - index * 60_000;
      return {
        id: `spotify:fixture${index}`,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumArtist: track.artist,
        genre: track.genre ?? "",
        durationSec: track.durationSec ?? 200,
        playCount: track.plays ?? 3,
        lastPlayedUnixMs: lastPlayed,
        likeStatus: track.liked ? 1 : 0,
        sourceStats: [
          {
            source: "spotify",
            sourceTrackId: `spotify:track:fixture${index}`,
            playCount: track.plays ?? 3,
            totalPlayMs: (track.plays ?? 3) * 200_000,
            playsByYear: { [String(new Date(lastPlayed).getUTCFullYear())]: track.plays ?? 3 },
            firstPlayedUnixMs: lastPlayed - 86_400_000,
            lastPlayedUnixMs: lastPlayed,
            liked: Boolean(track.liked),
            limitations
          }
        ]
      };
    })
  };
}

/** Fictional two-album library used by the library/curator specs. */
export const LIBRARY_TRACKS = [
  { title: "Glass Harbor", artist: "Neon Tide", album: "Static Bloom", genre: "Electronic", durationSec: 201, plays: 9, liked: true },
  { title: "Paper Satellites", artist: "Neon Tide", album: "Static Bloom", genre: "Electronic", durationSec: 188, plays: 7 },
  { title: "Low Orbit", artist: "Neon Tide", album: "Static Bloom", genre: "Electronic", durationSec: 222, plays: 5 },
  { title: "Rust Belt Hymn", artist: "Iron Meridian", album: "Forge Lines", genre: "Heavy Metal", durationSec: 245, plays: 12, liked: true },
  { title: "Anvil Choir", artist: "Iron Meridian", album: "Forge Lines", genre: "Heavy Metal", durationSec: 260, plays: 8 },
  { title: "Molten Psalm", artist: "Iron Meridian", album: "Forge Lines", genre: "Heavy Metal", durationSec: 231, plays: 4 }
];

// ---------------------------------------------------------------- launching

/** launchApp + offline env + ready + error collector. */
export async function launchProj({ seed, env, home, keepHome, size = SIZES.desktop, theme } = {}) {
  const app = await launchApp({ seed, env: offlineEnv(env), home, keepHome });
  try {
    await waitForReady(app.driver);
    await installErrorCollector(app.driver);
    await setWindowSize(app.driver, size);
    if (theme) await setTheme(app.driver, theme);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

export async function assertNoPageErrors(driver) {
  assert.deepEqual(await pageErrors(driver), [], "page raised errors");
}

// ---------------------------------------------------------------- UI helpers

const xpathLiteral = (text) => (text.includes("'") ? `concat('${text.split("'").join(`', "'", '`)}')` : `'${text}'`);

export const byTestId = (id) => By.css(`[data-testid="${id}"]`);
export const byLabel = (label) => By.css(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
/** Button whose whole visible text is exactly `text` (whitespace-normalised). */
export const byButton = (text) => By.xpath(`//button[normalize-space(.)=${xpathLiteral(text)}]`);
/** Button whose visible text starts with `text`. */
export const byButtonStart = (text) => By.xpath(`//button[starts-with(normalize-space(.), ${xpathLiteral(text)})]`);
/** Any element whose own text node contains `text`. */
export const byText = (text) => By.xpath(`//*[contains(text(), ${xpathLiteral(text)})]`);

export async function find(driver, locator, timeoutMs = 10_000) {
  const element = await driver.wait(until.elementLocated(locator), timeoutMs, `not found: ${locator}`);
  return element;
}

export async function findVisible(driver, locator, timeoutMs = 10_000) {
  const element = await find(driver, locator, timeoutMs);
  await driver.wait(until.elementIsVisible(element), timeoutMs, `not visible: ${locator}`);
  return element;
}

export async function click(driver, locator, timeoutMs = 10_000) {
  const element = await findVisible(driver, locator, timeoutMs);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", element);
  try {
    await element.click();
  } catch (error) {
    if (error?.name !== "ElementClickInterceptedError") throw error;
    // Say what is on top, so a covered control is diagnosable from the log.
    const cover = await driver.executeScript(`
      const rect = arguments[0].getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const describe = (node) => node ? node.tagName.toLowerCase() + (node.className ? "." + String(node.className).trim().split(/\\s+/).join(".") : "") + (node.getAttribute && node.getAttribute("aria-label") ? "[" + node.getAttribute("aria-label") + "]" : "") : "nothing";
      return { top: describe(top), rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round), viewport: [innerWidth, innerHeight] };
    `, element);
    throw new Error(`click on ${locator} intercepted by ${cover.top} at ${JSON.stringify(cover.rect)} (viewport ${cover.viewport})`);
  }
  await settle(driver);
  return element;
}

export async function absent(driver, locator) {
  return (await driver.findElements(locator)).length === 0;
}

export async function waitAbsent(driver, locator, timeoutMs = 10_000) {
  await driver.wait(async () => absent(driver, locator), timeoutMs, `still present: ${locator}`);
}

export async function waitFor(driver, predicate, message, timeoutMs = 10_000) {
  return driver.wait(predicate, timeoutMs, message);
}

/** Wait until the element's visible text contains `expected`. */
export async function waitTextContains(driver, locator, expected, timeoutMs = 10_000) {
  let last = "";
  await driver.wait(async () => {
    const elements = await driver.findElements(locator);
    if (elements.length === 0) return false;
    last = await elements[0].getText();
    return last.includes(expected);
  }, timeoutMs).catch(() => {
    throw new Error(`text of ${locator} never contained ${JSON.stringify(expected)}; last ${JSON.stringify(last)}`);
  });
  return last;
}

export async function textOf(driver, locator) {
  return (await find(driver, locator)).getText();
}

/** Rendered text via innerText (WebKitWebDriver's getText drops text inside 3D-transformed cards). */
export async function innerText(driver, element) {
  return driver.executeScript("return arguments[0].innerText", element);
}

/** Replace the value of a React-controlled input/textarea by typing. */
export async function typeInto(driver, locator, text, { clear = true } = {}) {
  const element = await findVisible(driver, locator);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'}); arguments[0].focus()", element);
  if (clear) {
    await driver.executeScript("arguments[0].select()", element);
    await element.sendKeys(text || Key.BACK_SPACE);
  } else if (text) await element.sendKeys(text);
  await settle(driver);
  return element;
}

export async function activeElementLabel(driver) {
  return driver.executeScript("return document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent)");
}

/** Titles of the burn-list queue rows, in order. */
export async function queueTitles(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('.music-queue-item .music-queue-play strong')].map((node) => node.textContent)"
  );
}

/** Wait for an on-disk project JSON to satisfy `predicate` (autosave is async). */
export async function waitForProjectOnDisk(dirs, id, predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let project = null;
  while (Date.now() < deadline) {
    try {
      project = readProject(dirs, id);
    } catch {
      project = null; // mid-rename read; retry
    }
    if (project && predicate(project)) return project;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message ?? "project on disk never matched"}; last: ${JSON.stringify(project)?.slice(0, 600)}`);
}

export async function waitForCondition(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

/** The elements sticking out furthest past the right edge of the viewport. */
export async function overflowCulprits(driver, limit = 3) {
  return driver.executeScript(`
    const width = window.innerWidth;
    const found = [];
    for (const node of document.querySelectorAll("body *")) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= width + 1) continue;
      let parent = node.parentElement;
      let nested = false;
      while (parent) { if (found.some((item) => item.node === parent)) { nested = true; break; } parent = parent.parentElement; }
      if (nested) continue;
      found.push({ node, right: Math.round(rect.right - width) });
    }
    return found.sort((a, b) => b.right - a.right).slice(0, arguments[0]).map(({ node, right }) =>
      node.tagName.toLowerCase() + (node.className && typeof node.className === "string" ? "." + node.className.trim().split(/\\s+/).join(".") : "") + (node.dataset.testid ? "[data-testid=" + node.dataset.testid + "]" : "") + " +" + right + "px " + JSON.stringify((node.innerText || "").slice(0, 60)));
  `, limit);
}

/** Record the input events the page actually receives (for menu/keyboard diagnostics). */
export async function installInputProbe(driver) {
  await driver.executeScript(`
    window.__inputProbe = [];
    if (window.__inputProbeInstalled) return;
    window.__inputProbeInstalled = true;
    for (const type of ["keydown", "contextmenu", "pointerdown", "mousedown", "mouseup", "click", "auxclick", "blur", "focus"]) {
      window.addEventListener(type, (event) => {
        const parts = [type];
        if (event.key) parts.push(event.key + (event.shiftKey ? "+shift" : ""));
        if (typeof event.button === "number" && type !== "keydown") parts.push("button" + event.button);
        parts.push(document.querySelector('[role="menu"]') ? "menu-open" : "menu-closed");
        window.__inputProbe.push(parts.join(":"));
      }, true);
    }
  `);
}

export async function inputProbe(driver) {
  return driver.executeScript("return window.__inputProbe || []");
}

/**
 * Open the Projects context menu for a project card with the keyboard
 * (focus + Shift+F10), the path that works reliably through WebKitWebDriver.
 * A WebDriver right-click on WebKitGTK opens and immediately closes the menu
 * and also activates the card (see proj-library right-click test).
 */
export async function openProjectMenu(driver, cardLocator) {
  const card = await findVisible(driver, cardLocator);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'}); arguments[0].focus()", card);
  await driver.actions().keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform();
  return findVisible(driver, By.css('[role="menu"]'), 5_000);
}

/** Screenshot + rethrow, so every failing step leaves visual evidence. */
export function failShots(getDriver, prefix) {
  return (name, options, fn) => {
    const body = typeof options === "function" ? options : fn;
    const opts = typeof options === "function" ? {} : options;
    return it(name, opts, async (context) => {
      try {
        await body(context);
      } catch (error) {
        const driver = getDriver();
        if (driver) {
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
          await screenshot(driver, `fail-${prefix}-${slug}`).catch(() => undefined);
        }
        throw error;
      }
    });
  };
}

export async function horizontalOverflow(driver) {
  return driver.executeScript(
    "return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth"
  );
}

// ---------------------------------------------------------------- tour

export const TOUR_MODES = [
  { name: "desktop-light", size: SIZES.desktop, theme: "light" },
  { name: "desktop-dark", size: SIZES.desktop, theme: "dark" },
  { name: "narrow-light", size: SIZES.narrow, theme: "light" },
  { name: "narrow-dark", size: SIZES.narrow, theme: "dark" }
];

/**
 * Screenshot one screen in every mode: tour-proj-<screen>-<mode>.png. The
 * theme is switched through the app's own toggle; when the current screen has
 * no visible toggle (e.g. a modal covers it) the theme is applied with the
 * same mechanism the toggle uses (html[data-theme] + localStorage), recorded
 * in the returned list. Returns [{ file, mode, overflow }].
 */
export async function tour(driver, screen, { modes = TOUR_MODES, reset, before } = {}) {
  const shots = [];
  try {
    for (const mode of modes) {
      // reset: close overlays so the theme goes through the app's own toggle;
      // before: (re)open the state at this size, as a user would.
      if (reset) await reset(mode);
      await setWindowSize(driver, mode.size);
      await applyTheme(driver, mode.theme);
      if (before) await before(mode);
      await driver.executeScript("return document.fonts ? document.fonts.ready.then(() => true) : true");
      await settle(driver);
      const file = await screenshot(driver, `tour-proj-${screen}-${mode.name}`);
      shots.push({ file, mode: mode.name, overflow: await horizontalOverflow(driver) });
    }
  } finally {
    await setWindowSize(driver, SIZES.desktop);
  }
  return shots;
}

export async function applyTheme(driver, theme) {
  const toggles = await driver.findElements(By.css(`[aria-label="Color theme"] button[title="Use ${theme} mode"]`));
  for (const toggle of toggles) {
    if (await toggle.isDisplayed().catch(() => false)) {
      try {
        await toggle.click();
        await driver.wait(
          () => driver.executeScript(`return document.documentElement.dataset.theme === ${JSON.stringify(theme)}`),
          5_000
        );
        await settle(driver);
        return "toggle";
      } catch {
        break; // covered by an overlay: fall through to the storage path
      }
    }
  }
  await driver.executeScript(
    `document.documentElement.dataset.theme = arguments[0]; document.documentElement.style.colorScheme = arguments[0];
     try { localStorage.setItem("mxtp:color-theme:v1", arguments[0]); } catch {}`,
    theme
  );
  await settle(driver);
  return "script";
}
