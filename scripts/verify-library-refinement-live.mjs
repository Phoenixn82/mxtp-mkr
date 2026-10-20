import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "artifacts", "library-refinement-live"));
const cdpPort = Number(process.env.MXTP_CDP_PORT ?? "9333");
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
const tempProjectName = `__MXTP_LIBRARY_VERIFY__${Date.now()}_${process.pid}`;
const desktopViewport = { width: 1280, height: 900 };
const mobileViewport = { width: 390, height: 844 };
const evidence = [];
const browserErrors = [];

fs.mkdirSync(outputDir, { recursive: true });

function record(name, details = "pass") {
  evidence.push({ name, details });
  console.log(`PASS ${name}: ${details}`);
}

function exactText(value) {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

function normalizedTitle(value) {
  return value
    .toLowerCase()
    .replace(/^\s*\d+[.)-]?\s*/, "")
    .replace(/\s*[-–—|:]\s*(official\s+)?(music\s+)?(video|audio|visuali[sz]er|lyric\s+video)\s*$/i, "")
    .replace(/\s*[([]\s*(official\s+)?(music\s+)?(video|audio|visuali[sz]er|lyric\s+video)\s*[)\]]\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function eventually(check, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

async function connectToInstalledApp() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(cdpEndpoint);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Could not connect to installed MXTP at ${cdpEndpoint}: ${lastError?.message ?? "timeout"}`);
}

async function findMxtpPage(browser) {
  return eventually(async () => {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        const title = await candidate.title().catch(() => "");
        if (/MXTP/i.test(title)) return candidate;
        if (await candidate.getByTestId("apple-library").count().catch(() => 0)) return candidate;
      }
    }
    return undefined;
  }, "Installed MXTP page was not exposed over CDP", 60_000);
}

function namedCard(page, name) {
  return page.locator(".music-album-card").filter({
    has: page.locator(":scope > strong").filter({ hasText: exactText(name) })
  });
}

async function waitForProjects(page) {
  await page.getByText("Loading projects…", { exact: true }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await page.locator(".music-library-view .music-album-grid").waitFor({ state: "visible", timeout: 30_000 });
}

async function projectNames(page) {
  await waitForProjects(page);
  return (await page.locator(".music-library-view .music-album-card > strong").allTextContents())
    .map((value) => value.trim())
    .sort((a, b) => a.localeCompare(b));
}

async function queueTitles(page) {
  return (await page.locator(".music-queue-item .music-queue-play strong").allTextContents()).map((value) => value.trim());
}

async function useTheme(page, theme) {
  const label = theme === "dark" ? "Dark" : "Light";
  await page.getByRole("button", { name: label, exact: true }).click();
  await eventually(
    () => page.locator("html").getAttribute("data-theme").then((value) => value === theme),
    `${label} theme did not activate`
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  assert.ok(
    Math.max(dimensions.document, dimensions.body) <= dimensions.viewport + 1,
    `${label} has horizontal overflow (${Math.max(dimensions.document, dimensions.body)}px document in ${dimensions.viewport}px viewport)`
  );
  record(`${label} horizontal fit`, `${dimensions.viewport}px viewport`);
}

async function deleteOnlyTempProject(page) {
  const coach = page.locator(".mxtp-coach");
  if (await coach.count()) await page.getByRole("button", { name: "Close guide", exact: true }).click().catch(() => undefined);

  const activeBanner = page.locator(".music-project-mode-banner");
  if (await activeBanner.count()) {
    const bannerText = (await activeBanner.textContent()) ?? "";
    if (!bannerText.includes(tempProjectName)) {
      throw new Error(`Refusing cleanup while a different project is active: ${bannerText.trim()}`);
    }
    await page.getByTestId("exit-project-button").click();
  }

  const navigation = page.getByRole("navigation", { name: "Music library" });
  await navigation.getByRole("button", { name: /Projects/ }).click();
  await waitForProjects(page);
  const card = namedCard(page, tempProjectName);
  const count = await card.count();
  if (count === 0) return false;
  assert.equal(count, 1, `Cleanup found ${count} cards named ${tempProjectName}; refusing ambiguous deletion`);

  await card.click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Actions for ${tempProjectName}`, exact: true });
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await menu.getByRole("menuitem", { name: /Delete project/ }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${tempProjectName}?`, exact: true });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: "Delete forever", exact: true }).click();
  await card.waitFor({ state: "detached", timeout: 30_000 });
  return true;
}

let browser;
let page;
let originalTheme = "light";
let originalViewport;
let initialProjects = [];
let tempMayExist = false;
let tempDeleted = false;
let primaryError;

try {
  browser = await connectToInstalledApp();
  page = await findMxtpPage(browser);
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  await page.getByTestId("apple-library").waitFor({ state: "visible", timeout: 60_000 });
  originalTheme = (await page.locator("html").getAttribute("data-theme")) === "dark" ? "dark" : "light";
  originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

  const queueCount = await page.locator(".music-queue-item").count();
  const projectNameDraft = await page.getByLabel("Project name", { exact: true }).inputValue();
  const activeProjectCount = await page.locator(".music-project-mode-banner").count();
  const activeAlbumCount = await page.getByTestId("album-detail").count();
  assert.equal(queueCount, 0, "Safety stop: the installed app already has tracks in its burn list");
  assert.equal(projectNameDraft.trim(), "", "Safety stop: the installed app has an unsaved project name");
  assert.equal(activeProjectCount, 0, "Safety stop: the installed app is already editing a project");
  assert.equal(activeAlbumCount, 0, "Safety stop: launch MXTP on the Albums grid so this check does not replace an open album context");

  const navigation = page.getByRole("navigation", { name: "Music library" });
  await navigation.getByRole("button", { name: "AI Curator", exact: true }).click();
  assert.equal(await page.locator(".curator-message").count(), 0, "Safety stop: a non-persisted global curator conversation is open");
  record("clean-state guard", "empty queue, no project, no album detail, no global curator transcript");

  await navigation.getByRole("button", { name: /Projects/ }).click();
  initialProjects = await projectNames(page);
  record("real-project baseline", `${initialProjects.length} saved project(s) recorded for post-cleanup comparison`);

  await navigation.getByRole("button", { name: "Albums", exact: true }).click();
  await page.setViewportSize(desktopViewport);
  const search = page.getByPlaceholder("Artists, albums, genres", { exact: true });
  await search.fill("Psykotic");
  const psykoticCard = namedCard(page, "Psykotic");
  await psykoticCard.first().waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await psykoticCard.count(), 1, "Expected one real Psykotic album in the installed library");
  const cachedCardText = (await psykoticCard.textContent()) ?? "";
  await psykoticCard.click();

  const detail = page.getByTestId("album-detail");
  await detail.waitFor({ state: "visible", timeout: 30_000 });
  const scope = detail.getByRole("group", { name: "Album download scope", exact: true });
  const likedButton = scope.getByRole("button", { name: "Liked songs", exact: true });
  const fullButton = scope.getByRole("button", { name: "Full album", exact: true });
  await likedButton.click();
  assert.equal(await likedButton.getAttribute("aria-pressed"), "true", "Liked songs scope did not activate");
  const likedCount = await detail.locator(".music-track-row").count();
  assert.ok(likedCount > 0, "Psykotic has no liked-song rows to compare");

  await fullButton.click();
  assert.equal(await fullButton.getAttribute("aria-pressed"), "true", "Full album scope did not activate");
  const trackRows = detail.locator(".music-track-row");
  const fullCount = await trackRows.count();
  assert.ok(fullCount >= likedCount, `Full album shrank the release (${fullCount} vs ${likedCount} liked)`);
  const titles = (await detail.locator(".music-track-title > strong").allTextContents()).map((value) => value.trim());
  assert.equal(titles.length, fullCount, "Track title count did not match full-album rows");
  assert.equal(new Set(titles.map(normalizedTitle)).size, titles.length, `Full album contains duplicate canonical titles: ${titles.join(" | ")}`);
  const videoTitles = titles.filter((title) => /(?:official\s+)?music\s+video|official\s+video|lyric\s+video/i.test(title));
  assert.deepEqual(videoTitles, [], `Full album contains music-video entries: ${videoTitles.join(", ")}`);

  const readyCount = await detail.getByText("Audio ready forever", { exact: true }).count();
  const cachePresent = /audio ready forever/i.test(cachedCardText) || readyCount > 0;
  if (cachePresent) {
    assert.equal(fullCount, 17, `Cached Psykotic release should expose 17 safe unique audio tracks, found ${fullCount}`);
    assert.equal(readyCount, 17, `Cached Psykotic release should retain 17 permanent-ready tracks, found ${readyCount}`);
    assert.ok(fullCount > likedCount, `Cached full release did not expand beyond the ${likedCount} liked-song subset`);
    record("Psykotic safe cached release", `${likedCount} liked -> 17 full, 17 permanent-ready, no video/duplicate titles`);
  } else {
    record("Psykotic cache-dependent check", `cache absent; verified ${fullCount} unique non-video library row(s) without downloading`);
  }

  assert.equal(await detail.getByRole("button", { name: "Download", exact: true }).count(), 1, "Album detail must expose one Download action");
  assert.equal(await detail.getByText(/Download full album/i).count(), 0, "Legacy Download full album copy is still present");
  const timing = (await detail.locator(".music-timing-note").textContent()) ?? "";
  assert.match(timing, /7[–-]20 minutes/, "Album detail is missing the truthful 7–20 minute timing note");
  record("album controls", "Liked songs / Full album toggle, one Download action, and 7–20 minute note");

  await useTheme(page, "light");
  await assertNoHorizontalOverflow(page, "desktop light album");
  await page.screenshot({ path: path.join(outputDir, "01-psykotic-full-light.png"), fullPage: true });

  assert.ok(fullCount >= 2, "Need at least two Psykotic rows for non-destructive queue reorder verification");
  await trackRows.nth(0).getByRole("checkbox").check();
  await trackRows.nth(1).getByRole("checkbox").check();
  await detail.getByRole("button", { name: "Add to burn list", exact: true }).click();
  assert.equal(await page.locator(".music-queue-item").count(), 2, "Two selected tracks did not enter the burn list");
  assert.equal(await page.locator(".music-queue-item > i, .music-queue-move").count(), 0, "Queue still renders a green ready dot or legacy move controls");
  assert.equal(await page.getByRole("button", { name: /Move .* (up|down)/i }).count(), 0, "Queue still exposes up/down buttons");

  const originalOrder = await queueTitles(page);
  const handles = page.locator(".music-queue-item .music-drag-handle");
  assert.equal(await handles.count(), 2, "Queue does not expose one reorder handle per track");
  assert.equal(await handles.nth(0).getAttribute("draggable"), "true", "Queue reorder handle is not draggable");
  await handles.nth(0).focus();
  await page.keyboard.press("ArrowDown");
  const keyboardOrder = [originalOrder[1], originalOrder[0]];
  await eventually(() => queueTitles(page).then((value) => sameOrder(value, keyboardOrder)), "ArrowDown did not reorder the burn list");
  record("keyboard queue reorder", `${originalOrder.join(" -> ")} became ${keyboardOrder.join(" -> ")}`);

  let dragMode = "native";
  try {
    await handles.nth(0).dragTo(page.locator(".music-queue-item").nth(1));
  } catch {
    dragMode = "synthetic DataTransfer fallback";
  }
  if (!sameOrder(await queueTitles(page), originalOrder)) {
    dragMode = "synthetic DataTransfer fallback";
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await handles.nth(0).dispatchEvent("dragstart", { dataTransfer });
    await page.locator(".music-queue-item").nth(1).dispatchEvent("dragover", { dataTransfer });
    await page.locator(".music-queue-item").nth(1).dispatchEvent("drop", { dataTransfer });
    await handles.nth(0).dispatchEvent("dragend", { dataTransfer });
    await dataTransfer.dispose();
  }
  await eventually(() => queueTitles(page).then((value) => sameOrder(value, originalOrder)), "Drag reorder did not restore the original order");
  record("drag queue reorder", `${dragMode}; ${originalOrder.join(" -> ")}`);

  await page.getByLabel("Project name", { exact: true }).fill(tempProjectName);
  tempMayExist = true;
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await eventually(() => page.locator(".music-project-mode-banner").textContent().then((text) => text?.includes(tempProjectName)), "Saving did not enter visible project mode");
  assert.match((await page.locator(".music-project-mode-banner").textContent()) ?? "", new RegExp(`Editing project: ${tempProjectName} — changes update this project`));
  assert.ok(await page.getByTestId("exit-project-button").isVisible(), "Right-side Exit project control is missing");

  await navigation.getByRole("button", { name: /Projects/ }).click();
  await waitForProjects(page);
  assert.equal(await namedCard(page, tempProjectName).count(), 1, "Saved project did not appear immediately in Projects");
  record("immediate project visibility", tempProjectName);

  await navigation.getByRole("button", { name: "AI Curator", exact: true }).click();
  assert.equal(await page.locator('.curator-workspace[data-mode="project"]').count(), 1, "Curator did not enter project mode");
  assert.match((await page.locator(".curator-mode-notice.project").textContent()) ?? "", new RegExp(`Project chat modifies ${tempProjectName}`));
  assert.match((await page.getByTestId("curator-context").textContent()) ?? "", /modifies the existing/);
  await useTheme(page, "dark");
  await assertNoHorizontalOverflow(page, "desktop dark project curator");
  await page.screenshot({ path: path.join(outputDir, "02-project-context-dark.png"), fullPage: true });
  record("project-mode safety copy", "main banner, right-side Exit, and project curator labeling visible");

  await page.getByTestId("exit-project-button").click();
  assert.equal(await page.locator(".music-project-mode-banner").count(), 0, "Exit project left the editing banner visible");
  assert.equal(await page.locator(".music-queue-item").count(), 0, "Exit project did not clear the project queue");
  assert.equal(await page.locator('.curator-workspace[data-mode="global"]').count(), 1, "Exit project did not restore global curator mode");
  assert.match((await page.locator(".curator-mode-notice.global").textContent()) ?? "", /Global curator creates a new personal mix/);
  assert.match((await page.getByTestId("curator-context").textContent()) ?? "", /starts and saves a new project/);
  record("exit-to-global safety", "queue cleared and next curator mix is explicitly a new project");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("textbox", { name: "Ask the MXTP curator", exact: true }).fill("How do I download a full album?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const coach = page.locator(".mxtp-coach");
  await coach.waitFor({ state: "visible", timeout: 10_000 });
  await eventually(() => coach.getAttribute("data-target-found").then((value) => value === "true"), "Help spotlight did not find its target");
  const fullHelpText = ((await page.locator("#mxtp-coach-live").textContent()) ?? "").trim();
  assert.ok(fullHelpText.length > 20, "Help guide has no accessible instructions");
  await eventually(async () => {
    const cursor = await page.locator(".mxtp-coach-cursor").count();
    const visible = ((await page.locator(".mxtp-coach-copy").textContent()) ?? "").replace("▮", "").trim();
    return cursor === 1 && visible.length < fullHelpText.length;
  }, "Help guide did not begin its typewriter reveal", 3_000);
  const beforeTyping = ((await page.locator(".mxtp-coach-copy").textContent()) ?? "").replace("▮", "").length;
  await page.waitForTimeout(160);
  const afterTyping = ((await page.locator(".mxtp-coach-copy").textContent()) ?? "").replace("▮", "").length;
  assert.ok(afterTyping > beforeTyping, `Help typewriter did not advance (${beforeTyping} -> ${afterTyping})`);
  const spotlightBox = await page.locator(".mxtp-coach-spotlight").boundingBox();
  assert.ok(spotlightBox && spotlightBox.width > 0 && spotlightBox.height > 0, "Help spotlight has no visible target bounds");
  await page.locator(".mxtp-coach-dialog").click();
  await eventually(async () => {
    const visible = ((await page.locator(".mxtp-coach-copy").textContent()) ?? "").replace("▮", "").trim();
    return visible === fullHelpText && await page.locator(".mxtp-coach-cursor").count() === 0;
  }, "Click did not reveal the full help message");
  await page.screenshot({ path: path.join(outputDir, "03-help-spotlight-dark.png"), fullPage: true });
  record("help spotlight and typewriter", `${beforeTyping} -> ${afterTyping} characters, then click-to-reveal ${fullHelpText.length}`);
  await page.getByRole("button", { name: "Close guide", exact: true }).click();

  await page.reload();
  await page.getByTestId("apple-library").waitFor({ state: "visible", timeout: 60_000 });
  const reloadedNavigation = page.getByRole("navigation", { name: "Music library" });
  await reloadedNavigation.getByRole("button", { name: /Projects/ }).click();
  await waitForProjects(page);
  const reloadedCard = namedCard(page, tempProjectName);
  await reloadedCard.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await reloadedCard.count(), 1, "Temporary saved project did not survive app reload");
  await reloadedCard.click();
  await eventually(() => queueTitles(page).then((value) => sameOrder(value, originalOrder)), "Reloaded project lost its saved burn order");
  assert.match((await page.locator(".music-project-mode-banner").textContent()) ?? "", new RegExp(`Editing project: ${tempProjectName}`));
  record("durable project reload", `saved order survived: ${originalOrder.join(" -> ")}`);

  await page.setViewportSize(mobileViewport);
  await assertNoHorizontalOverflow(page, "mobile dark active project");
  await page.screenshot({ path: path.join(outputDir, "04-mobile-dark.png"), fullPage: true });
  await page.setViewportSize(desktopViewport);

  tempDeleted = await deleteOnlyTempProject(page);
  assert.equal(tempDeleted, true, "Temporary project was not available for exact cleanup");
  await page.reload();
  await page.getByTestId("apple-library").waitFor({ state: "visible", timeout: 60_000 });
  const finalNavigation = page.getByRole("navigation", { name: "Music library" });
  await finalNavigation.getByRole("button", { name: /Projects/ }).click();
  const finalProjects = await projectNames(page);
  assert.deepEqual(finalProjects, initialProjects, "Real saved-project set changed during temporary-project verification");
  assert.equal(await namedCard(page, tempProjectName).count(), 0, "Temporary project returned after cleanup reload");
  record("scoped cleanup", `removed only ${tempProjectName}; ${finalProjects.length} real project(s) preserved`);

  if (browserErrors.length) {
    record("captured browser diagnostics", `${browserErrors.length} console/page error(s); see JSON summary`);
  } else {
    record("browser diagnostics", "no new console or page errors captured");
  }
} catch (error) {
  primaryError = error;
} finally {
  if (page) {
    if (tempMayExist && !tempDeleted) {
      try {
        tempDeleted = await deleteOnlyTempProject(page);
        if (tempDeleted) console.log(`CLEANUP removed ${tempProjectName}`);
        else console.error(`CLEANUP WARNING: ${tempProjectName} was not visible; verify Projects manually`);
      } catch (cleanupError) {
        console.error(`CLEANUP FAILED for ${tempProjectName}: ${cleanupError.message}`);
      }
    }
    try {
      await page.setViewportSize(originalViewport ?? desktopViewport);
      await useTheme(page, originalTheme);
      console.log(`RESTORED theme=${originalTheme} viewport=${JSON.stringify(originalViewport ?? desktopViewport)}`);
    } catch (restoreError) {
      console.error(`RESTORE WARNING: ${restoreError.message}`);
    }
    await browser?.close().catch(() => undefined);
  }
}

console.log(JSON.stringify({
  endpoint: cdpEndpoint,
  outputDir,
  tempProjectName,
  tempDeleted,
  evidence,
  browserErrors
}, null, 2));

if (primaryError) throw primaryError;
console.log("LIBRARY_REFINEMENT_LIVE_OK");
