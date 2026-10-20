import { openProjectStudio } from "./wp2.mjs";
// Shared fixtures and drivers for the "art" area specs (album research, cover
// art, booklet layout and print PDFs). Everything is offline: MusicBrainz,
// Cover Art Archive, Cloudflare (cover edits) and FreeLLMAPI are served by a
// local stub; genius.com / lyrics.ovh have no URL override, so all other
// outbound HTTP from the app goes to a dead proxy and lyrics come from the
// app's own on-disk cache, exactly as they do when the network is down.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { By, Key, until } from "selenium-webdriver";
import {
  SIZES,
  installErrorCollector,
  launchApp,
  screenshot,
  setFieldValue,
  setTheme,
  setWindowSize,
  settle,
  waitForReady
} from "../helpers.mjs";

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/art");
const DEAD_PROXY = "http://127.0.0.1:9";

// ---------------------------------------------------------------- files

/** Minimal RGB PNG encoder (stdlib only): a diagonal two-colour gradient. */
export function pngBytes(width, height, from = [200, 40, 60], to = [20, 60, 200]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const offset = y * stride + 1 + x * 3;
      raw[offset] = Math.round(from[0] + (to[0] - from[0]) * t);
      raw[offset + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
      raw[offset + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function writePng(file, width, height, from, to) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, pngBytes(width, height, from, to));
  return file;
}

/** PNG width/height straight from the IHDR chunk. */
export function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 16-bit stereo 44.1 kHz sine WAV (synthetic tone, no recorded audio). */
export function writeSineWav(file, { seconds = 2, hz = 440 } = {}) {
  const rate = 44_100;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.3 * 32767);
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

/** Same slug as research.rs `slug()`: lowercase ASCII alnum runs joined by '-'. */
export function rustSlug(value) {
  return value
    .toLowerCase()
    .split("")
    .map((ch) => (/^[a-z0-9]$/.test(ch) ? ch : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
}

// ---------------------------------------------------------------- app data

/** Paths the app derives from the temp HOME (TMPDIR is set per launch). */
export function artPaths(home) {
  const tmp = path.join(home, "tmp");
  return {
    tmp,
    cache: path.join(tmp, "mxtp_mkr_cache"),
    covers: path.join(tmp, "mxtp_mkr_covers"),
    imagegen: path.join(tmp, "mxtp_mkr_imagegen"),
    appData: path.join(home, ".local/share/com.phoenix.mxtpmkr/MXTP MKR"),
    projects: path.join(home, ".local/share/com.phoenix.mxtpmkr/MXTP MKR/projects"),
    out: path.join(home, "out")
  };
}

/** research.rs cache_key: "<slug>-<16 hex FNV-1a 64 of the UTF-8 key>" (hex only when the slug is empty). */
export function rustCacheKey(key) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(key, "utf8")) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const hex = hash.toString(16).padStart(16, "0");
  const stem = rustSlug(key);
  return stem ? `${stem}-${hex}` : hex;
}

/** Lyrics cache entry exactly where research.rs falls back to it (plain text). */
export function seedLyricsCache(home, artist, title, text) {
  const file = path.join(artPaths(home).cache, "lyrics", `${rustCacheKey(`${artist}-${title}`)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Album cache entry (AlbumInfo, camelCase) used when MusicBrainz is unreachable. */
export function seedAlbumCache(home, info) {
  const file = path.join(artPaths(home).cache, "album", `${rustCacheKey(`${info.artist}-${info.album}`)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(info, null, 2));
  return file;
}

/**
 * A saved CdProject (src/project/catalog.ts shape) written where
 * project_store.rs reads it. playlistUrl is set so the detail view does not
 * start its automatic YouTube album search (out of this area).
 */
export function projectJson({ id, artist, album, research = null, art = [], tracks = [], bookletPages = 16, playlistUrl, updatedAt }) {
  const stamp = updatedAt ?? new Date().toISOString();
  return {
    id,
    name: album,
    kind: "artist",
    saved: true,
    entry: { artist, album, formatId: "jewelcase" },
    burnQueue: [],
    tracks,
    art,
    researchApplied: research ? [`${research.album.artist} - ${research.album.album}`] : [],
    research,
    bookletPages,
    exports: [],
    burnProgress: 0,
    playlistUrl: playlistUrl ?? "https://www.youtube.com/playlist?list=PLe2eArtFixtureOnly",
    createdAt: stamp,
    updatedAt: stamp
  };
}

export function seedProject(home, project) {
  const dir = artPaths(home).projects;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${project.id}.json`), JSON.stringify(project, null, 2));
}

export function readProject(home, id) {
  return JSON.parse(readFileSync(path.join(artPaths(home).projects, `${id}.json`), "utf8"));
}

export function dataUri(file) {
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
}

// ---------------------------------------------------------------- stub services

/**
 * Local MusicBrainz + Cover Art Archive + Cloudflare + FreeLLMAPI stub.
 * albums: { "<artist>|<album>" (lowercase): { id, title, date, label, tracks,
 *   genres, cover: "ok" | "none" | "broken", delayMs, mbStatus } }
 */
export async function startStubServer() {
  const albums = new Map();
  const images = new Map();
  const log = [];
  const state = { mbStatus: 200, editFails: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    log.push({ method: req.method, path: url.pathname, search: url.search, body: body.slice(0, 400), model: parsed?.model, prompt: parsed?.input?.prompt });
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const png = (bytes) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(bytes);
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // MusicBrainz release search
      if (url.pathname === "/ws/2/release") {
        if (state.mbStatus !== 200) return json(state.mbStatus, { error: "stub outage" });
        const query = url.searchParams.get("query") ?? "";
        const match = /artist:"(.*)" AND release:"(.*)"/.exec(query);
        const entry = match ? albums.get(`${match[1]}|${match[2]}`.toLowerCase()) : undefined;
        if (entry?.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
        return json(200, {
          releases: entry ? [{ id: entry.id, title: entry.title, score: 100, genres: entry.genres ?? [], tags: [] }] : []
        });
      }
      const releaseDetail = /^\/ws\/2\/release\/([^/]+)$/.exec(url.pathname);
      if (releaseDetail) {
        if (state.mbStatus !== 200) return json(state.mbStatus, { error: "stub outage" });
        const entry = [...albums.values()].find((item) => item.id === releaseDetail[1]);
        if (!entry) return json(404, { error: "not found" });
        return json(200, {
          id: entry.id,
          title: entry.title,
          date: entry.date,
          "label-info": [{ label: { name: entry.label } }],
          genres: entry.genres ?? [],
          tags: [],
          media: [{ tracks: entry.tracks.map((title) => ({ title, recording: {} })) }]
        });
      }
      if (url.pathname === "/ws/2/artist") return json(200, { artists: [{ id: "artist-e2e" }] });
      if (url.pathname === "/ws/2/release-group") {
        return json(200, {
          "release-groups": [
            { id: "rg-e2e-1", "primary-type": "Album", "secondary-types": [], "first-release-date": "1998-01-01" }
          ]
        });
      }
      // Cover Art Archive
      const caaRelease = /^\/caa\/release\/([^/]+)$/.exec(url.pathname);
      if (caaRelease) {
        const entry = [...albums.values()].find((item) => item.id === caaRelease[1]);
        if (!entry || entry.cover === "none") return json(404, { error: "no art" });
        return json(200, { images: [{ front: true, image: `${base}/img/${entry.cover === "broken" ? "broken" : entry.id}.png` }] });
      }
      if (/^\/caa\/release-group\/[^/]+\/front-500$/.test(url.pathname)) return png(images.get("era"));
      const image = /^\/img\/([^/]+)\.png$/.exec(url.pathname);
      if (image) {
        const bytes = images.get(image[1]);
        if (!bytes) return json(500, { error: "stub image failure" });
        return png(bytes);
      }
      // Cloudflare Workers AI (original-cover edit)
      if (req.method === "POST" && /^\/cf\/accounts\/[^/]+\/ai\/run$/.test(url.pathname)) {
        if (state.editFails || parsed?.input?.prompt?.includes("FAILPLEASE")) {
          return json(500, { success: false, errors: [{ message: "stub edit refused" }] });
        }
        return json(200, { success: true, result: { image: images.get("edited").toString("base64") } });
      }
      // FreeLLMAPI router: down, so the app falls back to its text prompt.
      if (url.pathname.startsWith("/llm/")) return json(503, { error: "router offline (stub)" });
      return json(404, { error: `stub has no route for ${url.pathname}` });
    } catch (error) {
      return json(500, { error: String(error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  images.set("era", pngBytes(320, 320, [240, 220, 40], [40, 40, 40]));
  images.set("edited", pngBytes(512, 512, [30, 200, 120], [250, 250, 250]));
  return {
    base,
    log,
    state,
    addAlbum(entry) {
      albums.set(`${entry.artist}|${entry.title}`.toLowerCase(), entry);
      if (entry.cover !== "none" && entry.cover !== "broken") {
        images.set(entry.id, pngBytes(600, 600, entry.colors?.[0] ?? [220, 60, 40], entry.colors?.[1] ?? [30, 30, 120]));
      }
    },
    /** Logged requests whose path starts with `prefix` (or equals it with exact). */
    requests(prefix, { exact = false } = {}) {
      return log.filter((entry) => (exact ? entry.path === prefix : entry.path.startsWith(prefix)));
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Env for an isolated art launch. Offline by default: every outbound request
 * that is not to the 127.0.0.1 stub hits a dead proxy and fails fast.
 */
export function artEnv(home, stub, extra = {}, { online = false } = {}) {
  const proxies = online
    ? {}
    : {
        HTTP_PROXY: DEAD_PROXY,
        HTTPS_PROXY: DEAD_PROXY,
        ALL_PROXY: DEAD_PROXY,
        http_proxy: DEAD_PROXY,
        https_proxy: DEAD_PROXY,
        all_proxy: DEAD_PROXY,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1"
      };
  const env = {
    TMPDIR: artPaths(home).tmp,
    ...proxies,
    MXTP_YTDLP_PATH: path.join(FIXTURES, "bin/yt-dlp"),
    MXTP_MKR_MUSICBRAINZ_THROTTLE_MS: "0",
    MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS: "0",
    MXTP_MKR_CAA_REQUEST_DELAY_MS: "0",
    MXTP_MKR_CAA_RETRY_DELAY_MS: "0",
    MXTP_MKR_IMAGEGEN: "mock",
    MXTP_MKR_CACHE_DIR: artPaths(home).cache,
    MXTP_MKR_COVER_OUTPUT_DIR: artPaths(home).covers,
    MXTP_MKR_IMAGEGEN_OUTPUT_DIR: artPaths(home).imagegen,
    ...extra
  };
  if (stub) {
    Object.assign(env, {
      MXTP_MKR_MUSICBRAINZ_BASE_URL: `${stub.base}/ws/2`,
      MXTP_MKR_CAA_BASE_URL: `${stub.base}/caa`,
      MXTP_MKR_ALLOW_INSECURE_COVER_URLS: "1",
      FREELLMAPI_BASE_URL: `${stub.base}/llm`
    });
  }
  return { ...env, ...extra };
}

// ---------------------------------------------------------------- driving

export async function textOf(driver, css) {
  return driver.executeScript(`const el = document.querySelector(arguments[0]); return el ? el.textContent : null;`, css);
}

export async function attrOf(driver, css, name) {
  return driver.executeScript(`const el = document.querySelector(arguments[0]); return el ? el.getAttribute(arguments[1]) : null;`, css, name);
}

export async function exists(driver, css) {
  return driver.executeScript(`return Boolean(document.querySelector(arguments[0]));`, css);
}

export async function waitFor(driver, script, { timeout = 60_000, message = script, args = [] } = {}) {
  let last;
  try {
    return await driver.wait(async () => {
      last = await driver.executeScript(script, ...args);
      return last;
    }, timeout);
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new Error(`timed out after ${timeout}ms waiting for: ${message} (last=${JSON.stringify(last)})`);
  }
}

export async function waitForText(driver, css, pattern, options = {}) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  try {
    return await waitFor(
      driver,
      `const el = document.querySelector(arguments[0]); return el && new RegExp(arguments[1], arguments[2]).test(el.textContent) ? el.textContent : false;`,
      { ...options, args: [css, regex.source, regex.flags], message: `${css} text ~ ${regex}` }
    );
  } catch (error) {
    error.message += `; current text: ${JSON.stringify(await textOf(driver, css))}`;
    throw error;
  }
}

export async function find(driver, css, timeout = 60_000) {
  return driver.wait(until.elementLocated(By.css(css)), timeout, `element ${css} never appeared`);
}

export async function scrollTo(driver, css, block = "center") {
  // Vertical only (reset any horizontal scroll), and keep "start" targets
  // clear of the sticky app header.
  await driver.executeScript(
    `const el = document.querySelector(arguments[0]);
     if (!el) return;
     el.scrollIntoView({ block: arguments[1], inline: "nearest" });
     let y = window.scrollY;
     if (arguments[1] === "start") {
       const header = document.querySelector(".app-header");
       const style = header && getComputedStyle(header);
       if (style && (style.position === "sticky" || style.position === "fixed")) y -= header.getBoundingClientRect().height + 8;
     }
     window.scrollTo(0, Math.max(0, y));`,
    css,
    block
  );
  await settle(driver);
}

/** Horizontal overflow at the current width: page scroll width and the elements that start it. */
export async function horizontalOverflow(driver, root = "body") {
  return driver.executeScript(`
    const limit = window.innerWidth + 1;
    const all = [...document.querySelectorAll(arguments[0] + " *")];
    const label = (el) => el.tagName.toLowerCase() + (el.dataset.testid ? "[data-testid=" + el.dataset.testid + "]" : el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
    const culprits = [];
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.right + window.scrollX <= limit) continue;
      const parent = el.parentElement.getBoundingClientRect();
      if (parent.right + window.scrollX > limit) continue;
      culprits.push(label(el) + " right=" + Math.round(rect.right + window.scrollX) + "px");
    }
    return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, culprits: [...new Set(culprits)].slice(0, 8) };
  `, root);
}

/** A real WebDriver click (pointer events, visibility and hit-testing included). */
export async function click(driver, cssOrElement) {
  const element = typeof cssOrElement === "string" ? await find(driver, cssOrElement) : cssOrElement;
  await driver.executeScript(`arguments[0].scrollIntoView({ block: "center", inline: "nearest" });`, element);
  await driver.wait(until.elementIsEnabled(element), 30_000, "element stayed disabled");
  await element.click();
  return element;
}

/** Find a button by its visible text inside an optional container. */
export async function buttonByText(driver, text, within = "body") {
  const located = await waitFor(
    driver,
    `const root = document.querySelector(arguments[0]);
     return root ? [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === arguments[1]) || false : false;`,
    { args: [within, text], message: `button "${text}" in ${within}` }
  );
  return located;
}

/** Replace a controlled input's value by typing, like a user. */
export async function typeInto(driver, css, value) {
  const element = await find(driver, css);
  await driver.executeScript(`arguments[0].scrollIntoView({ block: "center" });`, element);
  return setFieldValue(driver, element, value);
}

/** Choose a <select> option by value through a real option click. */
export async function selectValue(driver, css, value) {
  const select = await find(driver, css);
  await driver.executeScript(`arguments[0].scrollIntoView({ block: "center" });`, select);
  const option = await select.findElement(By.css(`option[value="${value}"]`));
  await option.click();
  const current = await select.getAttribute("value");
  if (current !== String(value)) {
    // WebKitWebDriver clicks on <option> can be ignored for closed menus;
    // fall back to the keyboard, which a user would also use.
    await select.click();
    const options = await driver.executeScript(`return [...arguments[0].options].map((o) => o.value)`, select);
    const from = options.indexOf(current);
    const to = options.indexOf(String(value));
    const key = to > from ? Key.ARROW_DOWN : Key.ARROW_UP;
    for (let i = 0; i < Math.abs(to - from); i += 1) await select.sendKeys(key);
    await select.sendKeys(Key.ENTER);
  }
  await driver.wait(async () => (await select.getAttribute("value")) === String(value), 10_000, `select ${css} never became ${value}`);
}

/** Open a saved project from the landing catalog. */
export async function openProject(driver, id) {
  await openProjectStudio(driver, id);
}

/**
 * Launch the release app on a fresh temp HOME (or `home` to relaunch on the
 * same data) with the offline art env, wait for the UI, arm the error
 * collector and start every spec at desktop size in MXTP light.
 */
export async function startApp({ stub, env = {}, seed, home, keepHome = false, online = false } = {}) {
  const appHome = home ?? mkdtempSync(path.join(tmpdir(), "mxtp-e2e-art-"));
  mkdirSync(artPaths(appHome).tmp, { recursive: true });
  mkdirSync(artPaths(appHome).out, { recursive: true });
  const app = await launchApp({
    home: appHome,
    keepHome,
    seed: seed ? (dirs) => seed(dirs, appHome) : undefined,
    env: artEnv(appHome, stub, env, { online })
  });
  await waitForReady(app.driver, 60_000);
  await installErrorCollector(app.driver);
  await setWindowSize(app.driver, SIZES.desktop);
  await setTheme(app.driver, "light");
  return app;
}

// ---------------------------------------------------------------- native dialogs

/**
 * Answer the next native GTK file dialog (tauri-plugin-dialog -> rfd -> GTK3)
 * by synthesising X key events with XTEST (fixtures/art/xdialog.py). Start it
 * BEFORE clicking the button that opens the dialog; await the returned promise
 * after. mode: "save" types a full path into the name field, "open" uses the
 * Ctrl+L location bar, "cancel" presses Escape.
 */
export function answerFileDialog(mode, filePath = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", path.join(FIXTURES, "xdialog.py"), mode, filePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`xdialog ${mode} failed (${code}): ${output.trim()}`))));
  });
}

// ---------------------------------------------------------------- screenshots

const MODES = {
  "desktop-light": [SIZES.desktop, "light"],
  "desktop-dark": [SIZES.desktop, "dark"],
  "narrow-light": [SIZES.narrow, "light"],
  "narrow-dark": [SIZES.narrow, "dark"]
};

/**
 * tour-art-<screen>-<mode>.png for every requested mode, with `focus` scrolled
 * into view each time. Leaves the window at desktop-light.
 */
export async function tour(driver, screen, focus, modes = ["desktop-light", "desktop-dark", "narrow-light"]) {
  const files = [];
  for (const mode of modes) {
    const [size, theme] = MODES[mode];
    await setWindowSize(driver, size);
    await setTheme(driver, theme);
    if (focus) await scrollTo(driver, focus, "start");
    await settle(driver);
    files.push(await screenshot(driver, `tour-art-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  await setTheme(driver, "light");
  if (focus) await scrollTo(driver, focus, "start");
  return files;
}

// ---------------------------------------------------------------- PDFs

/** Inflate every FlateDecode stream in a PDF and return the decoded contents. */
export async function pdfStreams(file) {
  const { PDFDocument, PDFRawStream, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
  const streams = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.get(PDFName.of("Filter"));
    const subtype = object.dict.get(PDFName.of("Subtype"));
    let bytes = Buffer.from(object.contents);
    if (filter && String(filter) === "/FlateDecode" && String(subtype) !== "/Image") {
      try {
        bytes = zlib.inflateSync(bytes);
      } catch {
        continue;
      }
    }
    streams.push({ dict: object.dict, subtype: subtype ? String(subtype) : "", bytes });
  }
  return { doc, streams };
}

/** Page count, per-page MediaBox (mm) and image XObjects. */
export async function pdfSummary(file) {
  const { doc, streams } = await pdfStreams(file);
  const toMm = (pt) => Math.round((pt / 72) * 25.4 * 100) / 100;
  const pages = doc.getPages().map((page) => {
    const box = page.getMediaBox();
    return { wMm: toMm(box.width), hMm: toMm(box.height) };
  });
  const images = streams.filter((stream) => stream.subtype === "/Image");
  return { pageCount: pages.length, pages, imageCount: images.length, streams };
}

/** Text drawn by pdf-lib (hex strings) or lopdf (literal strings), concatenated. */
export function pdfText(streams) {
  const parts = [];
  for (const { bytes, subtype } of streams) {
    if (subtype === "/Image") continue;
    const content = bytes.toString("latin1");
    for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      parts.push(Buffer.from(match[1].replace(/\s+/g, ""), "hex").toString("latin1"));
    }
    for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      parts.push(match[1].replace(/\\([()\\])/g, "$1").replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
    }
  }
  return parts.join("\n");
}

/**
 * Per printed page: decoded content stream text plus the size of every image
 * XObject it can draw ({ name: { width, height } }).
 */
export async function pdfPages(file) {
  const { PDFDocument, PDFArray, PDFName, PDFRawStream, PDFDict } = await import("pdf-lib");
  const doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
  const decode = (stream) => {
    const raw = Buffer.from(stream.contents);
    const filter = stream.dict.get(PDFName.of("Filter"));
    return filter && String(filter) === "/FlateDecode" ? zlib.inflateSync(raw) : raw;
  };
  return doc.getPages().map((page) => {
    const contents = page.node.get(PDFName.of("Contents"));
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const content = refs
      .map((ref) => doc.context.lookup(ref))
      .filter((stream) => stream instanceof PDFRawStream)
      .map((stream) => decode(stream).toString("latin1"))
      .join("\n");
    const xobjects = {};
    const resources = page.node.Resources();
    const xobjectDict = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    for (const [name, ref] of xobjectDict?.entries() ?? []) {
      const object = doc.context.lookup(ref);
      if (!(object instanceof PDFRawStream)) continue;
      const width = object.dict.get(PDFName.of("Width"));
      const height = object.dict.get(PDFName.of("Height"));
      if (width && height) xobjects[name.asString().slice(1)] = { width: Number(width.asNumber()), height: Number(height.asNumber()) };
    }
    const box = page.getMediaBox();
    return { content, xobjects, widthPt: box.width, heightPt: box.height };
  });
}

/**
 * Image placements in a content stream: tracks q/Q and every `cm`, and for each
 * `/Name Do` reports the current transform (a d = drawn width/height in pt,
 * e f = origin). Works for lopdf (one cm) and pdf-lib (translate/rotate/scale/skew).
 */
export function imagePlacements(content) {
  const multiply = (m, n) => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ];
  const tokens = content.replace(/\(([^)\\]|\\.)*\)/g, " ").split(/\s+/).filter(Boolean);
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const operands = [];
  const placements = [];
  for (const token of tokens) {
    if (token === "q") stack.push(ctm);
    else if (token === "Q") ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (token === "cm") ctm = multiply(operands.slice(-6).map(Number), ctm);
    else if (token === "Do") {
      const [a, b, c, d, e, f] = ctm;
      placements.push({ a, b, c, d, e, f, name: String(operands.at(-1)).replace(/^\//, "") });
    }
    if (/^[A-Za-z'"*]+$/.test(token) && token !== "true" && token !== "false") operands.length = 0;
    else operands.push(token);
  }
  return placements;
}
