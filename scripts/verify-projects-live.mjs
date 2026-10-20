import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectName = `MXTP project verification ${Date.now()}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  console.log(`[projects-live] ${message}`);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const out = process.env.MXTP_VERIFY_OUT ?? path.join(os.tmpdir(), "mxtp-mkr-verify");
fs.mkdirSync(out, { recursive: true });
let page;
const deadline = Date.now() + 60_000;
while (!page && Date.now() < deadline) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
    }
  }
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) throw new Error("MXTP MKR page not found");

await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
const originalTheme = await page.locator("html").getAttribute("data-theme");
assert(!(await page.locator("body").innerText()).includes("Recent CDs"), "Legacy Recent CDs label is still visible");

const navigation = page.getByRole("navigation", { name: "Music library" });
await navigation.getByRole("button", { name: /Projects/ }).click();
await page.getByRole("heading", { name: "Projects" }).waitFor();
for (const label of ["All", "Artist releases", "Custom CDs"]) {
  await page.getByRole("button", { name: label, exact: true }).click();
}
await page.getByRole("button", { name: "All", exact: true }).click();
log("Projects surface and all three filters work");

await navigation.getByRole("button", { name: "Albums", exact: true }).click();
await page.getByPlaceholder("Artists, albums, genres").fill("Pretti Loves U 2");
await page.getByRole("button", { name: "Open Pretti Loves U 2" }).first().click();
await page.getByTestId("album-detail").waitFor();

const checkboxes = page.locator('.music-tracklist input[type="checkbox"]');
assert((await checkboxes.count()) >= 2, "Album needs at least two tracks for queue verification");
await checkboxes.nth(0).check();
await checkboxes.nth(1).check();
await page.getByRole("button", { name: "Add to burn list" }).click();

let rows = page.locator(".music-queue-item");
assert((await rows.count()) === 2, "Two selected tracks were not added to the burn list");
assert((await rows.nth(0).getAttribute("draggable")) === "true", "Burn-list rows are not draggable");
const originalFirst = (await rows.nth(0).locator("strong").innerText()).trim();
const originalSecond = (await rows.nth(1).locator("strong").innerText()).trim();

await rows.nth(1).dragTo(rows.nth(0));
rows = page.locator(".music-queue-item");
assert((await rows.nth(0).locator("strong").innerText()).trim() === originalSecond, "Drag-and-drop did not reorder the burn list");
log(`Drag reorder works: ${originalSecond} moved above ${originalFirst}`);

const playable = page.getByRole("button", { name: `Play ${originalSecond}` });
assert(!(await playable.isDisabled()), "Downloaded queue track is not playable");
await playable.click();
const player = page.getByTestId("burn-list-audio-player");
await player.waitFor();
assert(Boolean(await player.getAttribute("src")), "Audio player has no downloaded source");
log("Single-click downloaded-track playback exposes the native audio player");

await page.getByLabel("Project name").fill(projectName);
await page.getByRole("button", { name: "Save project", exact: true }).click();
await page.waitForTimeout(750);
await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
await page.getByRole("navigation", { name: "Music library" }).getByRole("button", { name: /Projects/ }).click();
const card = page.locator(".music-album-card", { hasText: projectName });
await card.waitFor();
await card.click();
rows = page.locator(".music-queue-item");
assert((await rows.count()) === 2, "Saved project did not restore its burn list");
assert((await rows.nth(0).locator("strong").innerText()).trim() === originalSecond, "Saved project did not preserve queue order");
log("Saved project reopens with its exact persisted track order");

await page.getByRole("button", { name: `Move ${originalSecond} down` }).click();
await page.waitForTimeout(750);
await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
await page.getByRole("navigation", { name: "Music library" }).getByRole("button", { name: /Projects/ }).click();
await page.locator(".music-album-card", { hasText: projectName }).click();
rows = page.locator(".music-queue-item");
assert((await rows.nth(0).locator("strong").innerText()).trim() === originalFirst, "Saved-project reorder was not written atomically");
log("Later queue edits auto-save and overwrite the same project safely");

await page.getByRole("button", { name: "← Projects" }).click();
const savedCard = page.locator(".music-album-card", { hasText: projectName });
await page.getByRole("button", { name: "Light" }).click();
await savedCard.click({ button: "right" });
await page.getByRole("menu", { name: `Actions for ${projectName}` }).waitFor();
await page.screenshot({ path: `${out}/mxtp-installed-project-menu-light.png` });
await page.keyboard.press("Escape");

await page.getByRole("button", { name: "Dark" }).click();
await savedCard.click({ button: "right" });
await page.screenshot({ path: `${out}/mxtp-installed-project-menu-dark.png` });
await page.getByRole("menuitem", { name: /Burn project/ }).click();
await page.getByRole("status").filter({ hasText: "Connect a CD writer" }).waitFor();
assert((await page.locator(".music-queue-item").count()) === 2, "Context-menu burn did not load the exact saved project into the burn list");
log("Right-click Burn project loads the saved order and starts the writer check");

await savedCard.click({ button: "right" });
await page.getByRole("menuitem", { name: /Delete project/ }).click();
await page.getByRole("alertdialog", { name: `Delete ${projectName}?` }).waitFor();
await page.screenshot({ path: `${out}/mxtp-installed-project-delete-warning-dark.png` });
await page.getByRole("button", { name: "Keep project" }).click();
assert(await savedCard.isVisible(), "Canceling deletion removed the project");

await page.getByRole("button", { name: "Light" }).click();
await savedCard.click({ button: "right" });
await page.getByRole("menuitem", { name: /Delete project/ }).click();
await page.screenshot({ path: `${out}/mxtp-installed-project-delete-warning-light.png` });
await page.getByRole("button", { name: "Delete forever" }).click();
await savedCard.waitFor({ state: "detached" });
await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
await page.getByRole("navigation", { name: "Music library" }).getByRole("button", { name: /Projects/ }).click();
assert((await page.locator(".music-album-card", { hasText: projectName }).count()) === 0, "Deleted project returned after reload");
log("Warning cancel is safe and Delete forever removes the project persistently");

const savedProject = page.locator(".music-album-card", { hasText: "Some Rap Songs" }).first();
await savedProject.click();
await page.getByRole("button", { name: "Delete project" }).click();
await page.getByRole("alertdialog", { name: "Delete Some Rap Songs?" }).waitFor();
await page.getByRole("button", { name: "Keep project" }).click();
await page.getByRole("button", { name: "Open cover + booklet studio" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 30_000 });
await page.getByTestId("delete-project-button").click();
await page.getByRole("alertdialog", { name: "Delete Some Rap Songs?" }).waitFor();
await page.getByRole("button", { name: "Keep project" }).click();
log("Opened-project and studio delete actions both route through the warning screen");

await page.getByRole("button", { name: originalTheme === "dark" ? "Dark" : "Light" }).click();

console.log(`PROJECT_NAME=${projectName}`);
await browser.close();
log("PROJECTS_LIVE_OK");
