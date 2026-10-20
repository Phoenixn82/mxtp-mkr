// Library-area helpers for the native e2e specs (lib-*.spec.mjs): real-format
// fixtures (Apple Library.musicdb, artwork.sqlite, cached playlist folders,
// synthetic WAV tones), the offline yt-dlp stub wiring, an invoke guard that
// keeps the real app offline and burn-free, and the screenshot tour.
import { createCipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import { By, Key, until } from "selenium-webdriver";
import { SIZES, screenshot, setTheme, setWindowSize, settle } from "../helpers.mjs";

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/lib");
export const REPO_FIXTURES = path.resolve(import.meta.dirname, "../../e2e/fixtures");
export const YTDLP_STUB = path.join(FIXTURES, "yt-dlp-stub.mjs");

const APPLE_EPOCH_OFFSET = 2_082_844_800;
const MUSICDB_KEY = Buffer.from("BHUILuilfghuila3", "latin1");

// ---------------------------------------------------------------- app data

/** <XDG_DATA_HOME>/<identifier>/MXTP MKR: projects/, playlists/, libraries.json. */
export function appDataRoot(dirs) {
  return path.join(dirs.XDG_DATA_HOME, "com.phoenix.mxtpmkr", "MXTP MKR");
}

export function appleLibraryPackage(home) {
  return path.join(home, "Music", "Apple Music", "Apple Music Library.musiclibrary");
}

// ------------------------------------------------------------- WAV + PNG

/** Short stereo 16-bit 44.1 kHz sine tone; no copyrighted audio anywhere. */
export function writeToneWav(file, { seconds = 1.5, frequency = 440 } = {}) {
  const rate = 44_100;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000);
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
}

/** Small striped RGB PNG so artwork rendering is checkable without copyrighted art. */
export function pngBuffer([r, g, b], size = 96) {
  const row = Buffer.alloc(1 + size * 3);
  const raw = [];
  for (let y = 0; y < size; y += 1) {
    const line = Buffer.from(row);
    for (let x = 0; x < size; x += 1) {
      const stripe = Math.floor((x + y) / 12) % 2 === 0;
      line[1 + x * 3] = stripe ? r : 255 - r;
      line[2 + x * 3] = stripe ? g : 255 - g;
      line[3 + x * 3] = stripe ? b : 255 - b;
    }
    raw.push(line);
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ------------------------------------------------- Apple Library.musicdb

function bomaText(subtype, text) {
  const value = Buffer.from(text, "utf16le");
  const block = Buffer.alloc(36 + value.length);
  block.write("boma", 0, "latin1");
  block.writeUInt32LE(block.length, 8);
  block.writeUInt32LE(subtype, 12);
  block.writeUInt32LE(value.length, 24);
  value.copy(block, 36);
  return block;
}

/**
 * Encode tracks/playlists in the record layout src-tauri/src/apple_music.rs
 * parses: hfma header, then zlib(record stream) whose first max_crypt bytes are
 * AES-128-ECB encrypted with the Music app key. Track fields:
 * { id, title, artist, album, albumArtist?, genre?, disc?, track?, year?,
 *   durationMs, plays?, lastPlayedUnix?, like? }.
 */
export function buildMusicDb({ tracks, playlists = [] }) {
  const records = [];
  for (const track of tracks) {
    const itma = Buffer.alloc(192);
    itma.write("itma", 0, "latin1");
    itma.writeUInt32LE(itma.length, 4);
    itma.writeBigUInt64LE(BigInt(track.id), 16);
    itma[62] = track.like ?? 0;
    itma.writeUInt16LE(track.disc ?? 1, 84);
    itma.writeUInt16LE(track.track ?? 0, 160);
    itma.writeInt32LE(track.year ?? 0, 168);
    records.push(itma);
    records.push(bomaText(0x0002, track.title));
    if (track.album) records.push(bomaText(0x0003, track.album));
    records.push(bomaText(0x0004, track.artist));
    if (track.genre) records.push(bomaText(0x0005, track.genre));
    if (track.albumArtist) records.push(bomaText(0x001b, track.albumArtist));
    const plays = Buffer.alloc(36);
    plays.write("boma", 0, "latin1");
    plays.writeUInt32LE(plays.length, 8);
    plays.writeUInt32LE(0x0017, 12);
    plays.writeUInt32LE(track.lastPlayedUnix ? track.lastPlayedUnix + APPLE_EPOCH_OFFSET : 0, 28);
    plays.writeUInt32LE(track.plays ?? 0, 32);
    records.push(plays);
    const numeric = Buffer.alloc(180);
    numeric.write("boma", 0, "latin1");
    numeric.writeUInt32LE(numeric.length, 8);
    numeric.writeUInt32LE(0x0001, 12);
    numeric.writeUInt32LE(256, 108);
    numeric.writeUInt32LE(1_700_000_000 + APPLE_EPOCH_OFFSET, 112);
    numeric.writeUInt32LE(track.durationMs, 176);
    records.push(numeric);
  }
  for (const playlist of playlists) {
    const lpma = Buffer.alloc(48);
    lpma.write("lpma", 0, "latin1");
    lpma.writeUInt32LE(lpma.length, 4);
    lpma.writeBigUInt64LE(BigInt(playlist.id), 30);
    records.push(lpma);
    records.push(bomaText(0x00c8, playlist.name));
    for (const trackId of playlist.trackIds) {
      const item = Buffer.alloc(48);
      item.write("boma", 0, "latin1");
      item.writeUInt32LE(item.length, 8);
      item.writeUInt32LE(0x00ce, 12);
      item.write("ipfa", 20, "latin1");
      item.writeBigUInt64LE(BigInt(trackId), 40);
      records.push(item);
    }
  }
  const compressed = deflateSync(Buffer.concat(records));
  const maxCrypt = 102_400;
  const cryptLength = Math.floor(Math.min(maxCrypt, compressed.length) / 16) * 16;
  const cipher = createCipheriv("aes-128-ecb", MUSICDB_KEY, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(compressed.subarray(0, cryptLength)), cipher.final()]);
  const header = Buffer.alloc(104);
  header.write("hfma", 0, "latin1");
  header.writeUInt32LE(header.length, 4);
  header.write("1.0.0.0 e2e fixture", 16, "latin1");
  header.writeUInt32LE(maxCrypt, 84);
  return Buffer.concat([header, encrypted, compressed.subarray(cryptLength)]);
}

/**
 * Write a Library.musicdb (+ artwork.sqlite and artwork/<id>_sk1.png for
 * tracks with `art: [r,g,b]`) at the default Linux path under `home`.
 */
export function seedAppleLibrary(home, library) {
  const pkg = appleLibraryPackage(home);
  mkdirSync(path.join(pkg, "artwork"), { recursive: true });
  writeFileSync(path.join(pkg, "Library.musicdb"), buildMusicDb(library));
  const withArt = library.tracks.filter((track) => track.art);
  if (withArt.length === 0) return pkg;
  rmSync(path.join(pkg, "artwork.sqlite"), { force: true });
  const db = new DatabaseSync(path.join(pkg, "artwork.sqlite"));
  db.exec("CREATE TABLE item_to_artwork (item_id INTEGER, artwork_id TEXT); CREATE TABLE cache_items (artwork_id TEXT, extension TEXT);");
  const map = db.prepare("INSERT INTO item_to_artwork VALUES (?, ?)");
  const cache = db.prepare("INSERT INTO cache_items VALUES (?, ?)");
  for (const track of withArt) {
    const artworkId = `art${track.id}`;
    map.run(track.id, artworkId);
    cache.run(artworkId, "png");
    writeFileSync(path.join(pkg, "artwork", `${artworkId}_sk1.png`), pngBuffer(track.art));
  }
  db.close();
  return pkg;
}

/**
 * A cached playlist folder exactly as playlist_fetch.py leaves it:
 * <app-data>/MXTP MKR/playlists/<title>/{.mxtp-source.json, NNN - Title.wav, cover.png}.
 */
export function seedCachedPlaylist(dirs, { title, source, tracks, cover }) {
  const folder = path.join(appDataRoot(dirs), "playlists", title);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, ".mxtp-source.json"), `${JSON.stringify({ source, title }, null, 2)}\n`);
  tracks.forEach((name, index) => writeToneWav(path.join(folder, `${String(index + 1).padStart(3, "0")} - ${name}.wav`), { frequency: 330 + index * 55 }));
  if (cover) writeFileSync(path.join(folder, "cover.png"), pngBuffer(cover));
  return folder;
}

// -------------------------------------------------------- yt-dlp stub

/**
 * Point the app (and its python sidecar) at the offline yt-dlp stub. The
 * catalog describes the only "YouTube" that exists in the test:
 * { albums: [{ url, title, channel, artist, album, entries: [{ title, duration }] }],
 *   videos: [{ url, title, channel, duration, query }] }.
 * Every stub call is appended to ytdlp.log.jsonl in the temp HOME.
 */
export function ytdlpStubEnv(home, catalog) {
  chmodSync(YTDLP_STUB, 0o755);
  const catalogFile = path.join(home, "ytdlp-catalog.json");
  writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  return {
    MXTP_YTDLP_PATH: YTDLP_STUB,
    MXTP_E2E_YTDLP_CATALOG: catalogFile,
    MXTP_E2E_YTDLP_LOG: path.join(home, "ytdlp.log.jsonl")
  };
}

export function ytdlpCalls(home) {
  const file = path.join(home, "ytdlp.log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ------------------------------------------------------ invoke guard

/**
 * Route every invokeCommand through the real Tauri IPC, except: list_burners
 * always reports no drive (burns can never start), and anything that would
 * write a disc or reach the network without a stub (lyrics, research, cover
 * generation) is rejected. Calls are logged in window.__e2eInvokes.
 * Startup invokes happen before this is installed and are already local.
 */
export async function installInvokeGuard(driver) {
  await driver.executeScript(`
    if (window.__e2eInvokes) return;
    const internals = window.__TAURI_INTERNALS__;
    if (!internals) throw new Error("not running inside Tauri");
    const allowed = new Set([
      "load_cd_projects", "save_cd_project", "delete_cd_project", "list_cached_playlists",
      "load_imported_music_sources", "save_imported_music_sources", "import_apple_music_library",
      "find_youtube_album_playlist", "find_youtube_track", "download_playlist_best",
      "probe_audio", "ffmpeg_version", "copy_audio_file", "copy_art_file", "cover_edit_available"
    ]);
    const calls = (window.__e2eInvokes = []);
    window.__MXTP_INVOKE__ = (command, args) => {
      calls.push({ command, args: args ?? null });
      if (command === "list_burners") return Promise.resolve([]);
      if (!allowed.has(command)) return Promise.reject(new Error("e2e guard blocked " + command + " (offline, simulate-only test)"));
      return internals.invoke(command, args ?? {});
    };
  `);
}

export async function invokeLog(driver) {
  return driver.executeScript("return window.__e2eInvokes || []");
}

// --------------------------------------------------- DOM conveniences

export async function visible(driver, locator) {
  const elements = await driver.findElements(locator);
  for (const element of elements) {
    try {
      if (await element.isDisplayed()) return element;
    } catch (error) {
      if (error.name !== "StaleElementReferenceError") throw error;
    }
  }
  return undefined;
}

export async function waitVisible(driver, locator, timeoutMs = 15_000, label = String(locator)) {
  let found;
  await driver.wait(async () => (found = await visible(driver, locator)) !== undefined, timeoutMs, `not visible: ${label}`);
  return found;
}

/** A visible <button> whose normalized text content equals `text`. */
export function buttonText(text) {
  return By.xpath(`//button[normalize-space(.)=${xpathLiteral(text)}]`);
}

export function ariaLabel(label, tag = "*") {
  return By.css(`${tag}[aria-label=${JSON.stringify(label)}]`);
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", "',\"'\",'")}')`;
}

export async function clickButton(driver, text, timeoutMs = 15_000) {
  const button = await waitVisible(driver, buttonText(text), timeoutMs, `button "${text}"`);
  await driver.wait(until.elementIsEnabled(button), timeoutMs, `button "${text}" stayed disabled`);
  await button.click();
  return button;
}

/**
 * DOM text (textContent, whitespace collapsed) of the first visible match.
 * Not getText(): that returns CSS-transformed text (uppercase kickers).
 */
export async function textOf(driver, css) {
  const element = await visible(driver, By.css(css));
  return element ? domText(driver, element) : "";
}

export async function domText(driver, element) {
  return driver.executeScript("return arguments[0].textContent.replace(/\\s+/g, ' ').trim()", element);
}

/** Wait until the visible element matching css has text matching `pattern`. */
export async function waitForText(driver, css, pattern, timeoutMs = 20_000) {
  let last = "";
  try {
    await driver.wait(async () => {
      try {
        last = await textOf(driver, css);
        return pattern instanceof RegExp ? pattern.test(last) : last.includes(pattern);
      } catch (error) {
        if (error.name === "StaleElementReferenceError") return false;
        throw error;
      }
    }, timeoutMs);
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new Error(`${css} never matched ${pattern}; last text: ${JSON.stringify(last)}`);
  }
  return last;
}

export async function typeInto(driver, element, text) {
  await element.clear();
  if (text) await element.sendKeys(text);
}

/**
 * Replace a React-controlled field value like a user selecting all and typing.
 * (Ctrl+A through WebKitWebDriver does not select field text, and clear()
 * bypasses React's onChange, so select via the DOM and type over it.)
 */
export async function setFieldValue(driver, element, text) {
  await driver.executeScript("arguments[0].focus(); arguments[0].select()", element);
  await element.sendKeys(text || Key.BACK_SPACE);
}

/**
 * Open a card's context menu. Keyboard Shift+F10 first (real key events);
 * then a WebDriver right-click; then, only if neither produced a menu, a
 * synthetic contextmenu event. Returns which path worked.
 */
export async function openContextMenu(driver, target, { prefer = "keyboard" } = {}) {
  // `target` may be a locator: it is re-found per attempt, because a window
  // blur/focus (a native right-click under Xvfb) can re-render the card.
  const resolve = async () => (typeof target?.getId === "function" ? target : driver.findElement(target));
  const menuShown = async (ms) => {
    try {
      await driver.wait(async () => Boolean(await visible(driver, By.css('[role="menu"]'))), ms);
      return true;
    } catch {
      return false;
    }
  };
  const attempts = {
    keyboard: async () => {
      await driver.executeScript("arguments[0].focus()", await resolve());
      await driver.actions({ async: true }).keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform();
    },
    rightClick: async () => {
      await driver.actions({ async: true }).contextClick(await resolve()).perform();
    },
    syntheticEvent: async () => {
      await driver.executeScript(`const rect = arguments[0].getBoundingClientRect();
        arguments[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 30, clientY: rect.top + 30 }));`, await resolve());
    }
  };
  // Record what reaches the page so a failure says why (menu never mounted,
  // or mounted and closed again by a window blur / stray pointerdown).
  await driver.executeScript(`window.__e2eMenuLog = [];
    if (!window.__e2eMenuSpy) {
      window.__e2eMenuSpy = true;
      const log = (entry) => window.__e2eMenuLog?.push(entry);
      for (const type of ["blur", "focus", "pointerdown", "click", "contextmenu", "keydown"]) window.addEventListener(type, (event) => log(type + (event.key ? ":" + event.key : "")), true);
      new MutationObserver((records) => records.forEach((record) => {
        record.addedNodes.forEach((node) => node.nodeType === 1 && node.matches?.('[role="menu"]') && log("menu+"));
        record.removedNodes.forEach((node) => node.nodeType === 1 && node.matches?.('[role="menu"]') && log("menu-"));
      })).observe(document.body, { childList: true, subtree: true });
    }`);
  // Native right-click goes last: under this WebKitWebDriver it blurs the
  // window and the card goes away, which spoils any attempt after it.
  const order = [prefer, ...["keyboard", "syntheticEvent", "rightClick"].filter((name) => name !== prefer)];
  const failures = [];
  for (const name of order) {
    try {
      await attempts[name]();
    } catch (error) {
      failures.push(`${name}: ${error.name}`);
    }
    // A half-finished pointer or key sequence would block the next attempt.
    await driver.actions({ async: true }).clear().catch(() => {});
    if (await menuShown(2_500)) return name;
  }
  const events = await driver.executeScript("return (window.__e2eMenuLog || []).join(' ')");
  throw new Error(`no project menu opened by keyboard, right-click or contextmenu event; page saw: ${events || "nothing"}; errors: ${failures.join(", ") || "none"}`);
}

/**
 * Choose files on a hidden <input type=file> the way a user's file picker
 * would: WebDriver send-keys with absolute paths (newline-separated).
 */
export async function chooseFiles(driver, input, files) {
  try {
    await input.sendKeys(files.join("\n"));
    return "sendKeys";
  } catch (error) {
    // Fallback if this WebKitWebDriver refuses send-keys on the 1px input:
    // hand the same bytes to the input through a DataTransfer + change event.
    console.log(`chooseFiles: send-keys failed (${error.name}); using DataTransfer`);
    const payload = files.map((file) => ({ name: path.basename(file), text: readFileSync(file, "utf8") }));
    await driver.executeScript(`
      const [input, files] = arguments;
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([file.text], file.name, { type: file.name.endsWith(".csv") ? "text/csv" : "application/json" }));
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    `, input, payload);
    return "DataTransfer";
  }
}

export async function sidebarStats(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('.music-sidebar-stats span')].map((node) => node.textContent.trim())"
  );
}

export async function albumCardTitles(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('.music-library-view .music-album-card strong')].map((node) => node.textContent.trim())"
  );
}

export async function queueTitles(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('.music-queue-item .music-queue-play strong')].map((node) => node.textContent.trim())"
  );
}

/** Synthetic HTML5 drag of an album card onto the burn list (WebKitGTK WebDriver has no native DnD). */
export async function dragAlbumToBurnList(driver, albumTitle) {
  return driver.executeScript(`
    const card = document.querySelector('[aria-label=' + JSON.stringify("Open " + arguments[0]) + ']');
    const target = document.querySelector('aside[aria-label="CD burn list"]');
    if (!card || !target) return false;
    const data = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: data }));
    return data.getData("application/x-mxtp-album-key");
  `, albumTitle);
}

export async function scrollTop(driver) {
  await driver.executeScript("window.scrollTo(0, 0); document.querySelectorAll('.music-main, .music-queue').forEach((node) => node.scrollTo?.(0, 0));");
}

// ------------------------------------------------------ screenshot tour

/**
 * Screenshot the current screen as tour-lib-<screen>-<mode>.png in
 * desktop-light, narrow-light, desktop-dark and narrow-dark (theme changes are
 * made at desktop width), then restore desktop light. `prepare` re-runs after
 * every resize for state that a resize resets (open menus).
 */
export async function tour(driver, screen, { prepare, modes = ["desktop-light", "narrow-light", "desktop-dark", "narrow-dark"] } = {}) {
  const files = [];
  for (const mode of modes) {
    const [size, theme] = mode.split("-");
    await setWindowSize(driver, SIZES.desktop);
    const current = await driver.executeScript("return document.documentElement.dataset.theme");
    if (current !== theme) await setTheme(driver, theme);
    if (size === "narrow") await setWindowSize(driver, SIZES.narrow);
    if (prepare) await prepare();
    await scrollTop(driver);
    await settle(driver);
    files.push(await screenshot(driver, `tour-lib-${screen}-${mode}`));
  }
  await setWindowSize(driver, SIZES.desktop);
  if ((await driver.executeScript("return document.documentElement.dataset.theme")) !== "light") await setTheme(driver, "light");
  return files;
}
