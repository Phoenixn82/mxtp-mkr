import { openProjectStudio } from "./wp2.mjs";
import { writePng } from "./art.mjs";
// Shared helpers for the audio / downloads / capacity / burn / 3D studio specs.
// Everything here writes real MXTP MKR data formats (project JSON, playlist
// cache folders, imported-library JSON) into the launch's temp XDG dirs.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { ROOT, SIZES, installErrorCollector, launchApp, screenshot, setFieldValue, setTheme, setWindowSize, settle, waitForReady } from "../helpers.mjs";

export const FIXTURES = path.join(ROOT, "e2e-native/fixtures/audio");
const REPO_ART = path.join(ROOT, "e2e/fixtures");

// ---------- app data layout (src-tauri/src/app_data.rs, project_store.rs, commands.rs) ----------

/** $XDG_DATA_HOME/com.phoenix.mxtpmkr — Tauri's app_local_data_dir on Linux. */
export const appDataDir = (dirs) => path.join(dirs.XDG_DATA_HOME, "com.phoenix.mxtpmkr");
export const mxtpDir = (dirs) => path.join(appDataDir(dirs), "MXTP MKR");
export const projectsDir = (dirs) => path.join(mxtpDir(dirs), "projects");
export const playlistsDir = (dirs) => path.join(mxtpDir(dirs), "playlists");
export const librariesPath = (dirs) => path.join(mxtpDir(dirs), "libraries.json");

// ---------- synthetic audio ----------

/** 16-bit PCM stereo 44.1 kHz sine tone. No recorded or copyrighted audio. */
export function writeWav(file, { seconds = 5, freq = 440, sampleRate = 44100, channels = 2 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.3 * 32767);
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(sample, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// ---------- projects (src/project/catalog.ts CdProject) ----------

export function makeTrack(dir, { title, seconds = 5, freq = 440, artist, album, durationSec } = {}) {
  const file = writeWav(path.join(dir, `${title}.wav`), { seconds, freq });
  return { id: file, title, durationSec: durationSec ?? seconds, path: file, ...(artist ? { artist } : {}), ...(album ? { album } : {}) };
}

/** Copy the repo's print-art fixtures into app data so the asset protocol scope can serve them. */
export function seedArt(dirs) {
  const dir = path.join(mxtpDir(dirs), "e2e-art");
  mkdirSync(dir, { recursive: true });
  const art = {};
  for (const slot of ["front", "tray", "disc"]) {
    art[slot] = path.join(dir, `art-${slot}.png`);
    // The tray's bleed box needs at least 1847 px across at 300 dpi.
    if (slot === "tray") writePng(art[slot], 1900, 1600, [40, 100, 160], [220, 170, 40]);
    else copyFileSync(path.join(REPO_ART, `art-${slot}.png`), art[slot]);
  }
  return art;
}

export const slotArt = (slotId, imageRef, imageSource = "manual") => ({
  slotId,
  imageRef,
  imageSource,
  transform: { x: 0, y: 0, scale: 1, rotation: 0 }
});

/**
 * A saved CdProject. Research with lyrics and a sourcePath keep the studio's
 * automatic YouTube match, album lookup and lyric enrichment from firing.
 */
export function makeProject({ id, artist = "Test Ensemble", album = "Sine Studies", formatId = "jewelcase", tracks = [], art = [], research, sourcePath, ...rest }) {
  const now = new Date().toISOString();
  return {
    id,
    name: album,
    kind: "artist",
    saved: true,
    entry: { artist, album, formatId },
    burnQueue: [],
    tracks,
    art,
    researchApplied: [],
    research: research === undefined
      ? {
          album: { artist, album, year: 2026, label: "E2E fixture", tracks: tracks.map((track) => track.title), coverArtUrls: [], tags: ["ambient"] },
          lyricsByTrack: tracks.length > 0 ? [{ title: tracks[0].title, lyrics: "la la la\nsine wave hum" }] : [{ title: "Intro", lyrics: "hum" }]
        }
      : research,
    bookletPages: 16,
    exports: [],
    burnProgress: 0,
    playlistUrl: "",
    createdAt: now,
    updatedAt: now,
    ...(sourcePath === undefined ? { sourcePath: path.dirname(tracks[0]?.path ?? "/nonexistent/e2e") } : sourcePath ? { sourcePath } : {}),
    ...rest
  };
}

export function seedProject(dirs, project) {
  mkdirSync(projectsDir(dirs), { recursive: true });
  writeFileSync(path.join(projectsDir(dirs), `${project.id}.json`), JSON.stringify(project, null, 2));
  return project;
}

export function readProject(dirs, id) {
  const file = path.join(projectsDir(dirs), `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

export function listProjects(dirs) {
  const dir = projectsDir(dirs);
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")))
    : [];
}

// ---------- imported library (src/library/multiLibrary.ts ImportedMusicSource) ----------

/**
 * One imported YouTube Music source holding the given albums. Apple Music's
 * encrypted Library.musicdb cannot be synthesized, so tracks that stand in for
 * "saved in Apple Music" (liked: true) carry inAppleLibrary: true, the field
 * the app reads for the Liked songs scope.
 */
export function seedLibrary(dirs, { artist, albums, year = 2026, genre = "Ambient" }) {
  let n = 0;
  const tracks = albums.flatMap(({ album, tracks: albumTracks }, albumIndex) => albumTracks.map((track, index) => {
    n += 1;
    return {
      id: `e2e-${n}`,
      title: track.title,
      artist,
      album,
      albumArtist: artist,
      genre,
      trackNumber: index + 1,
      year,
      durationSec: track.duration,
      playCount: 10 - index,
      lastPlayedUnixMs: Date.parse("2026-09-01T00:00:00Z") - albumIndex * 60_000 - index * 1000,
      likeStatus: track.liked ? 1 : 0,
      ...(track.liked ? { inAppleLibrary: true } : {})
    };
  }));
  const source = {
    source: "youtubeMusic",
    sourcePath: "e2e-youtube-music-history.json",
    importedAt: new Date().toISOString(),
    tracks,
    playlists: [],
    limitations: []
  };
  mkdirSync(mxtpDir(dirs), { recursive: true });
  writeFileSync(librariesPath(dirs), JSON.stringify([source]));
  return source;
}

/** A playlist cache folder exactly as playlist_fetch.py leaves it. */
export function seedPlaylistCache(dirs, { title, listId, tracks }) {
  const folder = path.join(playlistsDir(dirs), title);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, ".mxtp-source.json"), JSON.stringify({ source: `youtube-playlist:${listId}`, title }, null, 2) + "\n");
  tracks.forEach((track, index) => writeWav(path.join(folder, `${String(index + 1).padStart(3, "0")} - ${track.title}.wav`), { seconds: track.duration, freq: 330 + index * 40 }));
  return folder;
}

// ---------- external tool stubs ----------

/**
 * Put the cdrskin / yt-dlp stand-ins first on PATH and make every other
 * network call fail fast (dead proxy), so specs are deterministic offline.
 * Real python3 runs the real playlist_fetch.py sidecar; real ffmpeg/ffprobe
 * probe and convert the synthetic WAVs.
 */
export function toolEnv(home, { cdrskin = "none", catalog = { playlists: [] }, realCdrskin = false } = {}) {
  const bin = path.join(home, "e2e-bin");
  mkdirSync(bin, { recursive: true });
  const tools = realCdrskin ? ["yt-dlp"] : ["cdrskin", "yt-dlp"];
  for (const tool of tools) {
    copyFileSync(path.join(FIXTURES, "bin", tool), path.join(bin, tool));
    chmodSync(path.join(bin, tool), 0o755);
  }
  const catalogPath = path.join(home, "e2e-yt-catalog.json");
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  const dead = "http://127.0.0.1:9";
  const tmp = path.join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(home, "e2e-cdrskin-mode"), cdrskin);
  return {
    // prepare_pcm's scratch WAVs land here, so specs can see what is left behind.
    TMPDIR: tmp,
    PATH: `${bin}:${process.env.PATH}`,
    MXTP_YTDLP_PATH: path.join(bin, "yt-dlp"),
    MXTP_E2E_YT_CATALOG: catalogPath,
    MXTP_E2E_YT_LOG: path.join(home, "e2e-yt.log"),
    MXTP_E2E_CDRSKIN_MODE: cdrskin,
    MXTP_E2E_CDRSKIN_MODE_FILE: path.join(home, "e2e-cdrskin-mode"),
    MXTP_E2E_CDRSKIN_LOG: path.join(home, "e2e-cdrskin.log"),
    HTTP_PROXY: dead,
    HTTPS_PROXY: dead,
    ALL_PROXY: dead,
    http_proxy: dead,
    https_proxy: dead,
    all_proxy: dead,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  };
}

/**
 * launchApp with the tool stubs wired in. A fresh temp HOME is made here so the
 * stub env can point into it; pass `home` to relaunch on the same data.
 */
export async function launchStudio({ seed, tools = {}, home, keepHome = false, env = {} } = {}) {
  const runHome = home ?? mkdtempSync(path.join(tmpdir(), "mxtp-e2e-home-"));
  const app = await launchApp({ seed, home: runHome, keepHome, env: { ...toolEnv(runHome, tools), ...env } });
  try {
    await waitForReady(app.driver);
    await installErrorCollector(app.driver);
    await installResourceProbe(app.driver);
  } catch (error) {
    // Never leak a running app: node:test would wait on it forever.
    await app.close();
    throw error;
  }
  return app;
}

/** Plug the fake drive in or out ("none" | "drive" | "nomedia") without relaunching. */
export const setDriveMode = (home, mode) => writeFileSync(path.join(home, "e2e-cdrskin-mode"), mode);

export const updateCatalog = (home, catalog) => writeFileSync(path.join(home, "e2e-yt-catalog.json"), JSON.stringify(catalog, null, 2));

function readLog(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
export const ytCalls = (home) => readLog(path.join(home, "e2e-yt.log"));
export const cdrskinCalls = (home) => readLog(path.join(home, "e2e-cdrskin.log"));

/** A catalog album: entries are what the fake YouTube playlist holds, in order. */
export function catalogPlaylist({ id, title, channel, entries }) {
  return { id, title, channel, entries: entries.map((entry, index) => ({ id: `${id}-v${index + 1}`, freq: 400 + index * 60, ...entry })) };
}

// ---------- native dialogs ----------

/**
 * plugin-dialog's ask()/open() become IPC calls 'plugin:dialog|message' /
 * 'plugin:dialog|open' that render a native GTK dialog WebDriver cannot reach.
 * window.__TAURI_INTERNALS__.invoke is non-writable, but Tauri's IPC transport
 * (tauri scripts/ipc-protocol.js) POSTs every call with fetch() to
 * ipc://localhost/<cmd> and reads the answer from the response. Wrap fetch:
 * answer those two commands in the page and log them; every other command
 * still reaches the real Rust backend. With no answer configured a burn
 * confirmation is CANCELLED (fail closed).
 */
export async function stubDialogs(driver, { confirmBurn = false, openPaths = null } = {}) {
  return driver.executeScript(`
    window.__e2eDialog = Object.assign(window.__e2eDialog || { calls: [] }, { confirmBurn: arguments[0], openPaths: arguments[1] });
    if (window.__e2eFetchWrapped) return "already";
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = decodeURIComponent(typeof input === "string" ? input : input && input.url || "");
      const cmd = url.startsWith("ipc://localhost/") ? url.slice("ipc://localhost/".length) : "";
      const match = cmd === "plugin:dialog|message" || cmd === "plugin:dialog|open" ? [cmd, cmd] : null;
      if (!match) return realFetch(input, init);
      const state = window.__e2eDialog;
      let args = {};
      try { args = JSON.parse(init && init.body || "{}"); } catch (error) {}
      let answer = null;
      if (match[1] === "plugin:dialog|message") {
        state.calls.push({ cmd: match[1], message: args.message, title: args.title });
        const buttons = args.buttons && args.buttons.OkCancelCustom;
        answer = buttons ? (state.confirmBurn ? buttons[0] : buttons[1]) : "Ok";
      } else {
        state.calls.push({ cmd: match[1], options: args.options });
        answer = state.openPaths;
      }
      return Promise.resolve(new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" }
      }));
    };
    window.__e2eFetchWrapped = window.fetch !== realFetch;
    return window.__e2eFetchWrapped ? "wrapped" : "failed";
  `, confirmBurn, openPaths);
}

/**
 * helpers.mjs reports a failed resource load only by URL. Record the element
 * too, so a failure can be attributed (e.g. an <audio src=""> loading the page).
 */
export async function installResourceProbe(driver) {
  await driver.executeScript(`
    if (window.__e2eResources) return;
    window.__e2eResources = [];
    window.addEventListener("error", (event) => {
      const el = event.target;
      if (el && el !== window && el.tagName) {
        window.__e2eResources.push({ tag: el.tagName.toLowerCase(), src: el.getAttribute("src"), testid: el.getAttribute("data-testid") });
      }
    }, true);
  `);
}
export const resourceFailures = (driver) => driver.executeScript("return window.__e2eResources || []");

export const dialogCalls = (driver) => driver.executeScript("return (window.__e2eDialog && window.__e2eDialog.calls) || []");

// ---------- DOM helpers ----------

export const byTestId = (id) => By.css(`[data-testid="${id}"]`);

export async function text(driver, locator) {
  return (await driver.findElement(locator)).getText();
}

/** Wait until the element's text matches; return it. */
export async function waitForText(driver, locator, pattern, timeoutMs = 20_000) {
  let last = "";
  try {
    await driver.wait(async () => {
      const elements = await driver.findElements(locator);
      if (elements.length === 0) return false;
      last = await elements[0].getText();
      return pattern instanceof RegExp ? pattern.test(last) : last.includes(pattern);
    }, timeoutMs);
  } catch (error) {
    throw new Error(`text never matched ${pattern} (last: ${JSON.stringify(last)}): ${error.message}`);
  }
  return last;
}

export async function clickWhenEnabled(driver, locator, timeoutMs = 15_000) {
  // A transient overlay (toast, sticky header mid-scroll) can sit over the
  // target, or React can replace the node, for a moment; retry briefly and
  // name the blocker if it persists.
  const deadline = Date.now() + 5_000;
  for (;;) {
    const element = await driver.wait(until.elementLocated(locator), timeoutMs);
    try {
      await driver.wait(until.elementIsEnabled(element), timeoutMs);
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", element);
      await element.click();
      return element;
    } catch (error) {
      const retryable = error.name === "ElementClickInterceptedError" || error.name === "StaleElementReferenceError";
      if (!retryable || Date.now() > deadline) {
        if (error.name !== "ElementClickInterceptedError") throw error;
        const blocker = await driver.executeScript(
          "const r = arguments[0].getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el ? el.outerHTML.slice(0, 300) : null",
          element
        );
        error.message = `${error.message} (click on ${locator} blocked by ${blocker})`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export const buttonByText = (label) => By.xpath(`//button[normalize-space(.)=${JSON.stringify(label)}]`);
export const byAria = (label) => By.css(`[aria-label=${JSON.stringify(label)}]`);

/** Landing screen -> saved project card -> studio detail view. */
export async function openProjectFromLanding(driver, project) {
  await openProjectStudio(driver, project);
}

export async function trackTitles(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('[data-testid=track-list] li .track-title-input')].map((input) => input.value)"
  );
}

/** The studio track-list <li> whose title input currently holds `title`. */
export async function trackRow(driver, title) {
  const row = await driver.executeScript(
    "return [...document.querySelectorAll('[data-testid=track-list] li')].find((li) => li.querySelector('.track-title-input').value === arguments[0]) || null",
    title
  );
  assert.ok(row, `no track row titled ${title}`);
  return row;
}

export async function trackDurations(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('[data-testid=track-list] li > span')].map((span) => span.textContent)"
  );
}

/** Replace a React-controlled input's text the way a person would (select all, type). */
export async function typeInto(driver, element, value) {
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", element);
  return setFieldValue(driver, element, value);
}

/** Horizontal overflow of the page at the current window size (0 = fits). */
export const horizontalOverflow = (driver) =>
  driver.executeScript("return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth");

/** Poll the project JSON on disk until predicate(project) holds. */
export async function waitForProjectFile(dirs, id, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let project;
  while (Date.now() < deadline) {
    try {
      project = readProject(dirs, id);
    } catch {
      project = undefined; // mid atomic replace
    }
    if (project && predicate(project)) return project;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`project ${id} on disk never matched: ${JSON.stringify(project)?.slice(0, 600)}`);
}

// ---------- PDFs ----------

/** Minimal structural PDF check: header, EOF, page count and MediaBox sizes (mm). */
export function inspectPdf(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-"), `${file} is not a PDF`);
  assert.ok(/%%EOF\s*$/.test(text), `${file} has no %%EOF trailer`);
  const pages = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  const mediaBoxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+)\]/g)].map((match) => {
    const [x0, y0, x1, y1] = match[1].trim().split(/\s+/).map(Number);
    return { wMm: ((x1 - x0) * 25.4) / 72, hMm: ((y1 - y0) * 25.4) / 72 };
  });
  return { pages, mediaBoxes, bytes: bytes.length, hasImage: /\/Subtype\s*\/Image/.test(text) };
}

// ---------- canvas pixels ----------

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what WebDriver screenshots are). */
export function decodePng(base64) {
  const buf = Buffer.from(base64, "base64");
  let offset = 8;
  let width, height, colorType;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      assert.ok(body[8] === 8 && (colorType === 2 || colorType === 6) && body[12] === 0, "unsupported PNG layout");
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

/** Fraction of pixels whose RGB differs by more than `threshold` on any channel. */
export function pixelDiff(base64A, base64B, threshold = 24) {
  const a = decodePng(base64A);
  const b = decodePng(base64B);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0; i < a.width * a.height; i += 1) {
    for (let ch = 0; ch < 3; ch += 1) {
      if (Math.abs(a.data[i * a.bpp + ch] - b.data[i * b.bpp + ch]) > threshold) {
        changed += 1;
        break;
      }
    }
  }
  return changed / (a.width * a.height);
}

// ---------- screenshot tour ----------

export const TOUR_MODES = [
  ["desktop-light", SIZES.desktop, "light"],
  ["desktop-dark", SIZES.desktop, "dark"],
  ["narrow-light", SIZES.narrow, "light"],
  ["narrow-dark", SIZES.narrow, "dark"]
];

/**
 * tour-audio-<screen>-<mode>.png for every mode. `focus` (optional locator or
 * element) is scrolled into view first so the state being toured is on screen.
 */
export async function tour(driver, screen, { focus, modes = TOUR_MODES } = {}) {
  const files = [];
  for (const [mode, size, theme] of modes) {
    await setWindowSize(driver, size);
    await setTheme(driver, theme);
    if (focus) {
      const elements = typeof focus.getTagName === "function" ? [focus] : await driver.findElements(focus);
      if (elements[0]) await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", elements[0]);
    }
    // WebKitGTK can hand back a stale tile for a region that changed while the
    // main thread was busy with the software-rendered 3D canvas; give it time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle(driver);
    await settle(driver);
    files.push(await screenshot(driver, `tour-audio-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  await setTheme(driver, "light");
  return files;
}
