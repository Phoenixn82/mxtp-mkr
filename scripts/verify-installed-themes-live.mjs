import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = process.env.MXTP_VERIFY_OUT ?? path.join(os.tmpdir(), "mxtp-mkr-verify");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
  }
}
if (!page) throw new Error("Installed MXTP MKR page not found");

await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
const originalTheme = await page.locator("html").getAttribute("data-theme");
await page.getByRole("button", { name: "Light" }).click();
if ((await page.locator("html").getAttribute("data-theme")) !== "light") throw new Error("Installed light mode failed");
await page.screenshot({ path: `${out}/mxtp-installed-light-library.png`, fullPage: true });

await page.getByRole("button", { name: "Dark" }).click();
if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Installed dark mode failed");
await page.screenshot({ path: `${out}/mxtp-installed-dark-library.png`, fullPage: true });
await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Installed dark mode was not restored after reload");

const navigation = page.getByRole("navigation", { name: "Music library" });
await navigation.getByRole("button", { name: /Projects/ }).click();
const project = page.locator(".music-album-card", { hasText: "Some Rap Songs" }).first();
await project.waitFor();
await project.click();
const playable = page.getByRole("button", { name: /^Play / }).first();
await playable.click();
const audio = page.getByTestId("burn-list-audio-player");
await audio.waitFor();
if ((await audio.evaluate((node) => getComputedStyle(node).colorScheme)) !== "dark") throw new Error("Installed player did not adopt dark controls");
await page.screenshot({ path: `${out}/mxtp-installed-dark-player.png`, fullPage: true });

await page.getByRole("button", { name: "Open cover + booklet studio" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 30_000 });
await page.getByTestId("case-scene").waitFor({ timeout: 30_000 });
await page.screenshot({ path: `${out}/mxtp-installed-dark-studio.png`, fullPage: true });
await page.getByRole("button", { name: "Light" }).click();
await page.screenshot({ path: `${out}/mxtp-installed-light-studio.png`, fullPage: true });

await page.getByRole("button", { name: originalTheme === "dark" ? "Dark" : "Light" }).click();
console.log(`RESTORED_THEME=${originalTheme}`);
console.log("INSTALLED_THEMES_LIVE_OK");
await browser.close();
