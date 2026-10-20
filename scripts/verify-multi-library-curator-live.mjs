import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const out = process.env.MXTP_VERIFY_OUT ?? path.join(os.tmpdir(), "mxtp-mkr-verify");
fs.mkdirSync(out, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
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
if (!page) throw new Error("Installed MXTP MKR page not found");

await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
const nav = page.getByRole("navigation", { name: "Music library" });
await nav.getByRole("button", { name: "Sources" }).click();
await page.getByTestId("music-sources").waitFor();

await page.getByRole("button", { name: "Light" }).click();
await page.screenshot({ path: `${out}/mxtp-multi-sources-light.png`, fullPage: true });
await page.getByRole("button", { name: "Update Apple Music" }).click();
await page.getByRole("status").filter({ hasText: "Apple Music updated" }).waitFor({ timeout: 60_000 });

const fixtures = {
  Spotify: `${root}/e2e/fixtures/spotify-extended-history.json`,
  SoundCloud: `${root}/e2e/fixtures/soundcloud-library.json`,
  "YouTube Music": `${root}/e2e/fixtures/youtube-music-history.json`
};
for (const [source, path] of Object.entries(fixtures)) {
  const card = page.locator(".music-source-card", { hasText: source });
  await card.locator('input[type="file"]').setInputFiles(path);
  await page.getByRole("status").filter({ hasText: `${source} imported` }).waitFor();
}

const songsText = await page.locator(".music-sidebar-stats span").first().innerText();
const combinedSongs = Number(songsText.replace(/\D/g, ""));
const spotifyToggle = page.locator(".music-source-toggles label", { hasText: "Spotify" }).locator("input");
await spotifyToggle.uncheck();
const withoutSpotify = Number((await page.locator(".music-sidebar-stats span").first().innerText()).replace(/\D/g, ""));
assert(withoutSpotify < combinedSongs, "Spotify toggle did not change the combined track count");
await spotifyToggle.check();
assert(Number((await page.locator(".music-sidebar-stats span").first().innerText()).replace(/\D/g, "")) === combinedSongs, "Combined count did not restore after re-enabling Spotify");

await page.getByRole("button", { name: "Dark" }).click();
await page.screenshot({ path: `${out}/mxtp-multi-sources-dark.png`, fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Sources view overflows horizontally on mobile");
await page.screenshot({ path: `${out}/mxtp-multi-sources-mobile-dark.png`, fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });

// Keep the live curator fixture deterministic while the Apple refresh above
// still verifies the owner's real synced library independently.
const appleToggle = page.locator(".music-source-toggles label", { hasText: "Apple Music" }).locator("input");
await appleToggle.uncheck();

await nav.getByRole("button", { name: "AI Curator" }).click();
const editMemory = page.getByRole("button", { name: "Edit memory" });
if ((await editMemory.getAttribute("aria-expanded")) !== "true") await editMemory.click();
await page.getByLabel("Artists to avoid").fill("");
await page.getByLabel("Preferred genres").fill("");
await page.waitForTimeout(500);
await page.getByPlaceholder("Ask for a mix, then revise it naturally…").fill("Make a mixtape of my 2 favorite tracks from 2026");
await page.getByRole("button", { name: "Curate + prepare" }).click();
await page.locator(".curator-message.assistant").filter({ hasText: "ranked mix" }).last().waitFor();
assert((await page.locator(".music-queue-item").count()) === 2, "Curator did not create a two-track ordered burn list");
const dislikedArtist = (await page.locator(".music-queue-item").first().locator("small").innerText()).split("·")[0].trim();
await page.screenshot({ path: `${out}/mxtp-curator-dark-working.png`, fullPage: true });
await page.getByRole("status").filter({ hasText: /downloaded and ready|could not be matched|tracks are ready/i }).waitFor({ timeout: 300_000 });

await page.getByPlaceholder("Ask for a mix, then revise it naturally…").fill(`I don't like ${dislikedArtist}; replace those songs with 2 tracks that are more grunge`);
await page.getByRole("button", { name: "Curate + prepare" }).click();
await page.locator(".curator-message.assistant").filter({ hasText: "replaced the conflicts" }).last().waitFor();
assert((await page.locator(".music-queue-item", { hasText: dislikedArtist }).count()) === 0, "Follow-up did not remove the disliked artist");
assert((await page.getByLabel("Artists to avoid").inputValue()).includes(dislikedArtist), "Project memory did not expose the disliked artist");

await page.getByRole("button", { name: "Light" }).click();
await page.screenshot({ path: `${out}/mxtp-curator-light-memory.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Curator view overflows horizontally on mobile");
await page.screenshot({ path: `${out}/mxtp-curator-mobile-light.png`, fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(1200);
await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
await page.getByRole("navigation", { name: "Music library" }).getByRole("button", { name: /Projects/ }).click();
const project = page.locator(".music-album-card", { hasText: "2026 MXTP" }).first();
await project.waitFor();
await project.click();
await page.getByTestId("curator-chat").waitFor();
assert((await page.locator(".curator-message").count()) >= 4, "Project-scoped curator transcript did not survive reload");

console.log(`COMBINED_SONGS=${combinedSongs}`);
console.log("MULTI_LIBRARY_CURATOR_LIVE_OK");
await browser.close();
