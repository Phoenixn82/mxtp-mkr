// Native Linux e2e helpers: drive the REAL release binary (WebKitGTK webview)
// through tauri-driver -> WebKitWebDriver. Runs inside the compose `e2e`
// service under xvfb-run + dbus-run-session (see run-in-container.sh).
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { inflateSync } from "node:zlib";
import { Builder, By, Capabilities, Key, until } from "selenium-webdriver";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const APP = process.env.MXTP_E2E_APP ?? path.join(ROOT, "src-tauri/target/release/mxtp-mkr");
export const RESULTS = path.join(ROOT, "test-results/e2e-native");
export const SIZES = {
  desktop: { width: 1440, height: 950 },
  narrow: { width: 420, height: 900 }
};

const DRIVER_LOG = path.join(RESULTS, "tauri-driver.log");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`tauri-driver exited early (code ${child.exitCode}); see ${DRIVER_LOG}`);
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tauri-driver did not listen on ${port} within ${timeoutMs}ms`);
}

/** PIDs whose environment carries this run's temp HOME: driver, app, WebKit helpers. */
function pidsWithHome(home) {
  const entry = `HOME=${home}`;
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(entry);
      } catch {
        return false;
      }
    })
    .map(Number);
}

/**
 * Killing tauri-driver does not wait for the app and its WebKit helper
 * processes; they keep flushing into the temp HOME for a moment, which made
 * rmSync fail with ENOTEMPTY. Wait for every process launched with this HOME
 * to exit, SIGKILL stragglers after the timeout, and report them.
 */
async function waitForProcessesToExit(home, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let pids = pidsWithHome(home);
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pids = pidsWithHome(home);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return pids;
}

// A closed local port: an HTTP call to it fails at once.
const DEAD_URL = "http://127.0.0.1:9";

/**
 * Opt-in offline preset (launchApp({ offline: true })): every remote base the
 * app can override points at a dead local port, a dead HTTP(S)_PROXY catches
 * the hosts it cannot override (lyrics, YouTube), localhost stays direct for
 * tauri-driver/WebKitWebDriver, and retry/throttle delays are zero so failures
 * are fast and deterministic. `env` passed to launchApp still wins.
 */
export const OFFLINE_ENV = Object.freeze({
  MXTP_MKR_MUSICBRAINZ_BASE_URL: DEAD_URL,
  MXTP_MKR_CAA_BASE_URL: DEAD_URL,
  MXTP_MKR_POLLINATIONS_BASE_URL: DEAD_URL,
  FREELLMAPI_BASE_URL: DEAD_URL,
  MXTP_MKR_MUSICBRAINZ_THROTTLE_MS: "0",
  MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS: "0",
  MXTP_MKR_CAA_REQUEST_DELAY_MS: "0",
  MXTP_MKR_CAA_RETRY_DELAY_MS: "0",
  HTTP_PROXY: DEAD_URL,
  HTTPS_PROXY: DEAD_URL,
  ALL_PROXY: DEAD_URL,
  http_proxy: DEAD_URL,
  https_proxy: DEAD_URL,
  all_proxy: DEAD_URL,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost"
});

/** Session creation lost to a dropped driver connection (infra, not the app). */
function isConnectionDrop(error) {
  return /ECONNRESET|socket hang up/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`);
}

async function startDriver(env, home) {
  const port = await freePort();
  const nativePort = await freePort();
  appendFileSync(DRIVER_LOG, `\n=== ${new Date().toISOString()} launch ${APP} home=${home}\n`);
  const child = spawn("tauri-driver", ["--port", String(port), "--native-port", String(nativePort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const log = (chunk) => appendFileSync(DRIVER_LOG, chunk);
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForPort(port, child);
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  return { child, exited, port };
}

/**
 * Cold-launch the release binary with every app data root in a fresh temp dir.
 * tauri-driver -> WebKitWebDriver -> app inherit this env, so the app never
 * sees the real HOME, the real /tmp or the network (with `offline`).
 */
export async function launchApp({ seed, env: extraEnv = {}, home: reuseHome, keepHome = false, offline = false, stubBin } = {}) {
  // seed(dirs, home) pre-populates app data before launch; env adds/overrides
  // variables (e.g. MXTP_YTDLP_PATH stubs); home + keepHome relaunch on the same
  // data to prove persistence (the last close() should drop keepHome).
  // offline: OFFLINE_ENV. stubBin: a fixtures bin dir whose scripts are put
  // first on PATH (its yt-dlp, if any, becomes MXTP_YTDLP_PATH); stubs append
  // their calls to MXTP_E2E_STUB_LOG (<home>/e2e-stub.log), read back with
  // stubCalls(). The scripts are copied into <home>/e2e-bin and made
  // executable there: git (core.fileMode=false) checks them out as 0644.
  mkdirSync(RESULTS, { recursive: true });
  const home = reuseHome ?? mkdtempSync(path.join(tmpdir(), "mxtp-e2e-home-"));
  const dirs = {
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache")
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  // The app keeps research caches, covers and generated art under
  // std::env::temp_dir() unless told otherwise; keep them in this HOME so
  // runs never share (or leak into) the machine's /tmp.
  const tmp = path.join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const isolation = {
    TMPDIR: tmp,
    MXTP_MKR_CACHE_DIR: path.join(tmp, "mxtp_mkr_cache"),
    MXTP_MKR_COVER_OUTPUT_DIR: path.join(tmp, "mxtp_mkr_covers"),
    MXTP_MKR_IMAGEGEN_OUTPUT_DIR: path.join(tmp, "mxtp_mkr_imagegen")
  };
  const stubLog = path.join(home, "e2e-stub.log");
  let stubs = {};
  if (stubBin) {
    const bin = path.join(home, "e2e-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of readdirSync(stubBin)) {
      copyFileSync(path.join(stubBin, name), path.join(bin, name));
      chmodSync(path.join(bin, name), 0o755);
    }
    stubs = {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      MXTP_E2E_STUB_LOG: stubLog,
      ...(existsSync(path.join(bin, "yt-dlp")) ? { MXTP_YTDLP_PATH: path.join(bin, "yt-dlp") } : {})
    };
  }
  if (seed) await seed(dirs, home);
  const env = {
    ...process.env,
    ...dirs,
    HOME: home,
    ...isolation,
    MXTP_MKR_IMAGEGEN: "mock",
    ...(offline ? OFFLINE_ENV : {}),
    ...stubs,
    ...extraEnv
  };

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: APP });
  let driver;
  let child;
  let exited;
  // One retry when the WebDriver connection drops during session creation
  // (seen on a loaded build host); logged as infra so it is not read as an app bug.
  for (let attempt = 1; ; attempt += 1) {
    const started = await startDriver(env, home);
    ({ child, exited } = started);
    try {
      driver = await new Builder().withCapabilities(capabilities).usingServer(`http://127.0.0.1:${started.port}/`).build();
      await driver.executeScript("return 1"); // session health check
      // settle() waits on animation frames, which the software-rendered 3D
      // landing can hold off for well over the 30 s default on a loaded build host.
      await driver.manage().setTimeouts({ script: 90_000 });
      break;
    } catch (error) {
      await driver?.quit().catch(() => undefined);
      driver = undefined;
      child.kill();
      await exited;
      await waitForProcessesToExit(home);
      if (attempt >= 2 || !isConnectionDrop(error)) throw error;
      const note = `infra: WebDriver session creation failed (${error.code ?? error.name}: ${error.message}); retrying once`;
      appendFileSync(DRIVER_LOG, `${note}\n`);
      console.warn(`e2e-native ${note}`);
    }
  }

  return {
    driver,
    home,
    dirs,
    stubLog,
    async close() {
      try {
        await driver.quit();
      } finally {
        child.kill();
        await exited;
        const stopStart = Date.now();
        const stragglers = await waitForProcessesToExit(home);
        appendFileSync(
          DRIVER_LOG,
          stragglers.length > 0
            ? `force-killed processes still running after 10s: ${stragglers.join(", ")}\n`
            : `app processes exited ${Date.now() - stopStart}ms after tauri-driver stopped\n`
        );
        if (!keepHome) rmSync(home, { recursive: true, force: true });
      }
    }
  };
}

/**
 * Wait until React has mounted, the document finished loading and the first
 * frames painted. Under Mesa's software rasterizer the landing 3D case keeps
 * the main thread busy for ~5 s before the first animation frame.
 */
export async function waitForReady(driver, timeoutMs = 30_000) {
  // React replaces the loading shell; returning its element handle races that swap.
  await driver.wait(
    () => driver.executeScript("return document.readyState === 'complete' && Boolean(document.querySelector('#root > :not(.app-loading)'))"),
    timeoutMs,
    "app never left the loading shell"
  );
  await settle(driver);
}

/**
 * Capture uncaught errors, unhandled rejections and failed resource loads from
 * here on. Errors thrown before this runs are not seen; React render errors
 * still surface through the ErrorBoundary UI.
 */
export async function installErrorCollector(driver) {
  await driver.executeScript(`
    if (window.__e2eErrors) return;
    const errors = (window.__e2eErrors = []);
    window.addEventListener("error", (event) => {
      const el = event.target;
      if (el && el !== window) {
        // tag + the raw src attribute + testid say which element failed:
        // "failed to load tauri://localhost" alone hides an <audio src="">.
        errors.push({
          type: "resource",
          message: "failed to load " + (el.src || el.href || el.tagName),
          tag: el.tagName ? el.tagName.toLowerCase() : null,
          src: el.getAttribute ? el.getAttribute("src") : null,
          testid: el.getAttribute ? el.getAttribute("data-testid") : null
        });
      } else {
        errors.push({ type: "error", message: String(event.message), source: event.filename + ":" + event.lineno });
      }
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      errors.push({ type: "unhandledrejection", message: String((reason && reason.stack) || reason) });
    });
  `);
}

export async function pageErrors(driver) {
  return driver.executeScript("return window.__e2eErrors || null");
}

/** Resize the native window, then wait for the webview viewport to follow. */
export async function setWindowSize(driver, { width, height }) {
  await driver.manage().window().setRect({ x: 0, y: 0, width, height });
  await driver.wait(
    () => driver.executeScript(`return Math.abs(window.innerWidth - ${width}) <= 16`),
    5_000,
    `webview width never reached ~${width}px`
  );
  await settle(driver);
}

/** Switch between MXTP light ("light") and Y2K dark ("dark") via the app's own toggle. */
export async function setTheme(driver, theme) {
  const buttons = await driver.findElements(By.css(`[aria-label="Color theme"] button[title="Use ${theme} mode"]`));
  let clicked = false;
  for (const button of buttons) {
    if (await button.isDisplayed()) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error(`no visible theme toggle for ${theme}`);
  await driver.wait(
    () => driver.executeScript(`return document.documentElement.dataset.theme === ${JSON.stringify(theme)}`),
    5_000,
    `theme never became ${theme}`
  );
  await settle(driver);
}

/** Two animation frames so layout and paint catch up before a screenshot. */
export async function settle(driver) {
  await driver.executeAsyncScript(
    "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()));"
  );
}

/**
 * WebKitGTK can hand back a stale tile for a region repainted while the main
 * thread was busy with software WebGL, so wait 300 ms and settle twice first.
 */
export async function screenshot(driver, name) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle(driver);
  await settle(driver);
  mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${name}.png`);
  writeFileSync(file, await driver.takeScreenshot(), "base64");
  return file;
}

// ---------------------------------------------------------------------------
// Shared driving helpers (promoted from the area libs, which keep their own
// copies). Notes on this WebKitWebDriver:
// - getText() returns CSS text-transformed text (uppercase kickers), drops text
//   inside 3D-transformed or ellipsis elements and returns "" for visually
//   hidden text: use domText/textOf (textContent) or innerText instead.
// - Ctrl+A does not select field text and clear() bypasses React's onChange:
//   use setFieldValue.
// - actions().contextClick() blurs the window under Xvfb, so apps that close
//   menus on blur never show a right-click menu and the target may re-render
//   (stale element): use openContextMenu, which tries the keyboard first.
// ---------------------------------------------------------------------------

/** Lines a fixtures stub appended to MXTP_E2E_STUB_LOG (launchApp stubBin). */
export function stubCalls(app) {
  try {
    return readFileSync(app.stubLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const asLocator = (target) => (typeof target === "string" ? By.css(target) : target);
const isElement = (target) => typeof target?.getId === "function";

async function resolveElement(driver, target, timeoutMs = 10_000) {
  if (isElement(target)) return target;
  const locator = asLocator(target);
  return driver.wait(until.elementLocated(locator), timeoutMs, `not found: ${locator}`);
}

/** DOM text (textContent, whitespace collapsed) of an element. */
export async function domText(driver, element) {
  return driver.executeScript("return arguments[0].textContent.replace(/\\s+/g, ' ').trim()", element);
}

/** domText of a CSS selector, By locator or element. */
export async function textOf(driver, target) {
  return domText(driver, await resolveElement(driver, target));
}

/** Rendered text (innerText): line breaks as laid out, hidden text left out. */
export async function innerText(driver, target) {
  return driver.executeScript("return arguments[0].innerText", await resolveElement(driver, target));
}

/**
 * Replace a React-controlled field value like a user selecting all and typing
 * over it (select via the DOM, then real key events).
 */
export async function setFieldValue(driver, target, text) {
  const element = await resolveElement(driver, target);
  await driver.executeScript("arguments[0].focus(); arguments[0].select()", element);
  await element.sendKeys(text || Key.BACK_SPACE);
  return element;
}

/** What sits on top of an element's centre (for intercepted-click errors). */
async function describeCover(driver, element) {
  return driver.executeScript(`
    const rect = arguments[0].getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const describe = (node) => node ? node.tagName.toLowerCase() + (typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\\s+/).join(".") : "") + (node.getAttribute && node.getAttribute("data-testid") ? "[data-testid=" + node.getAttribute("data-testid") + "]" : "") + (node.getAttribute && node.getAttribute("aria-label") ? "[" + node.getAttribute("aria-label") + "]" : "") : "nothing";
    return describe(top) + " at " + JSON.stringify([rect.left, rect.top, rect.width, rect.height].map(Math.round)) + " (viewport " + innerWidth + "x" + innerHeight + ")";
  `, element);
}

/** Scroll into view and click; an intercepted click names what was on top. */
export async function click(driver, target, timeoutMs = 10_000) {
  const element = await resolveElement(driver, target, timeoutMs);
  await driver.wait(until.elementIsVisible(element), timeoutMs, `not visible: ${target}`);
  await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' })", element);
  try {
    await element.click();
  } catch (error) {
    if (error?.name !== "ElementClickInterceptedError") throw error;
    error.message = `${error.message} (click on ${target} intercepted by ${await describeCover(driver, element)})`;
    throw error;
  }
  await settle(driver);
  return element;
}

/**
 * Click once the control is enabled. React may replace the node and a
 * transient overlay may cover it for a moment, so stale and intercepted
 * clicks are retried for 5 s; a persistent blocker is named in the error.
 */
export async function clickWhenEnabled(driver, target, timeoutMs = 15_000) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const element = await resolveElement(driver, target, timeoutMs);
    try {
      await driver.wait(until.elementIsEnabled(element), timeoutMs, `still disabled: ${target}`);
      await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' })", element);
      await element.click();
      return element;
    } catch (error) {
      const retryable = error.name === "ElementClickInterceptedError" || (error.name === "StaleElementReferenceError" && !isElement(target));
      if (!retryable || Date.now() > deadline) {
        if (error.name === "ElementClickInterceptedError") {
          error.message = `${error.message} (click on ${target} blocked by ${await describeCover(driver, element).catch(() => "unknown")})`;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * Open a context menu ([role=menu]) for `target` (a locator, re-found per
 * attempt). Keyboard Shift+F10 first, then a dispatched contextmenu event,
 * then a native right-click last (it blurs the window, see above). Returns
 * the path that worked; on failure the error lists the events the page saw.
 */
export async function openContextMenu(driver, target, { prefer = "keyboard", menu = '[role="menu"]' } = {}) {
  const resolve = () => resolveElement(driver, target);
  const menuShown = async (ms) => {
    try {
      await driver.wait(async () => {
        for (const element of await driver.findElements(By.css(menu))) if (await element.isDisplayed().catch(() => false)) return true;
        return false;
      }, ms);
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
    syntheticEvent: async () => {
      await driver.executeScript(`const rect = arguments[0].getBoundingClientRect();
        arguments[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 30, clientY: rect.top + 30 }));`, await resolve());
    },
    rightClick: async () => {
      await driver.actions({ async: true }).contextClick(await resolve()).perform();
    }
  };
  await driver.executeScript(`window.__e2eMenuLog = [];
    if (!window.__e2eMenuSpy) {
      window.__e2eMenuSpy = true;
      const log = (entry) => window.__e2eMenuLog && window.__e2eMenuLog.push(entry);
      for (const type of ["blur", "focus", "pointerdown", "click", "contextmenu", "keydown"]) window.addEventListener(type, (event) => log(type + (event.key ? ":" + event.key : "")), true);
    }`);
  const order = [prefer, ...["keyboard", "syntheticEvent", "rightClick"].filter((name) => name !== prefer)];
  const failures = [];
  for (const name of order) {
    try {
      await attempts[name]();
    } catch (error) {
      failures.push(`${name}: ${error.name}`);
    }
    await driver.actions({ async: true }).clear().catch(() => {});
    if (await menuShown(2_500)) return name;
  }
  const events = await driver.executeScript("return (window.__e2eMenuLog || []).join(' ')");
  throw new Error(`no menu opened by keyboard, contextmenu event or right-click; page saw: ${events || "nothing"}; errors: ${failures.join(", ") || "none"}`);
}

/**
 * Scroll vertically to a target (CSS selector, locator or element), reset
 * any sideways scroll, and keep "start" targets clear of a sticky header
 * (.app-header in the studio, .music-toolbar in the library).
 */
export async function scrollToElement(driver, target, block = "center") {
  const element = await resolveElement(driver, target);
  await driver.executeScript(
    `const el = arguments[0];
     el.scrollIntoView({ block: arguments[1], inline: "nearest" });
     let y = window.scrollY;
     if (arguments[1] === "start") {
       for (const header of document.querySelectorAll(".app-header, .music-toolbar")) {
         const style = getComputedStyle(header);
         if ((style.position === "sticky" || style.position === "fixed") && header.getBoundingClientRect().height > 0 && !header.closest("[hidden]")) {
           y -= header.getBoundingClientRect().height + 8;
           break;
         }
       }
     }
     window.scrollTo(0, Math.max(0, y));`,
    element,
    block
  );
  await settle(driver);
  return element;
}

/** Scroll the page back to the top-left corner. */
export async function scrollToTop(driver) {
  await driver.executeScript("window.scrollTo(0, 0)");
  await settle(driver);
}

/**
 * node:test `it` that saves fail-<prefix>-<test>.png when the test throws.
 * Usage: const it = failShots(() => app?.driver, "area");
 */
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

/**
 * Answer plugin-dialog calls in the page: ask()/message() and open() become
 * IPC POSTs to ipc://localhost/plugin:dialog|message and |open that would
 * otherwise open a native GTK dialog WebDriver cannot reach. Tauri's
 * __TAURI_INTERNALS__.invoke is non-configurable, so window.fetch is wrapped;
 * every other command still reaches the real backend. A confirmation is
 * CANCELLED unless `confirm` is true (fail closed); open() returns
 * `openPaths`. Calls are logged: read them with dialogCalls().
 */
export async function stubDialogs(driver, { confirm = false, openPaths = null } = {}) {
  return driver.executeScript(`
    window.__e2eDialog = Object.assign(window.__e2eDialog || { calls: [] }, { confirm: arguments[0], openPaths: arguments[1] });
    if (window.__e2eFetchWrapped) return "already";
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = decodeURIComponent(typeof input === "string" ? input : (input && input.url) || "");
      const cmd = url.startsWith("ipc://localhost/") ? url.slice("ipc://localhost/".length) : "";
      if (cmd !== "plugin:dialog|message" && cmd !== "plugin:dialog|open") return realFetch(input, init);
      const state = window.__e2eDialog;
      let args = {};
      try { args = JSON.parse((init && init.body) || "{}"); } catch (error) {}
      let answer = null;
      if (cmd === "plugin:dialog|message") {
        state.calls.push({ cmd, message: args.message, title: args.title });
        const buttons = args.buttons && args.buttons.OkCancelCustom;
        answer = buttons ? (state.confirm ? buttons[0] : buttons[1]) : "Ok";
      } else {
        state.calls.push({ cmd, options: args.options });
        answer = state.openPaths;
      }
      return Promise.resolve(new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" }
      }));
    };
    window.__e2eFetchWrapped = window.fetch !== realFetch;
    return window.__e2eFetchWrapped ? "wrapped" : "failed";
  `, confirm, openPaths);
}

export const dialogCalls = (driver) => driver.executeScript("return (window.__e2eDialog && window.__e2eDialog.calls) || []");

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what WebDriver screenshots are). */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "base64");
  let offset = 8;
  let width;
  let height;
  let colorType;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error("unsupported PNG layout");
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
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

/**
 * Fraction of pixels whose RGB differs by more than `threshold` on any
 * channel (1 when the sizes differ). Software WebGL never repaints
 * byte-identically, so compare against a small fraction, never a hash.
 */
export function pixelDiff(a, b, threshold = 24) {
  const left = decodePng(a);
  const right = decodePng(b);
  if (left.width !== right.width || left.height !== right.height) return 1;
  let changed = 0;
  for (let i = 0; i < left.width * left.height; i += 1) {
    for (let ch = 0; ch < 3; ch += 1) {
      if (Math.abs(left.data[i * left.bpp + ch] - right.data[i * right.bpp + ch]) > threshold) {
        changed += 1;
        break;
      }
    }
  }
  return changed / (left.width * left.height);
}
