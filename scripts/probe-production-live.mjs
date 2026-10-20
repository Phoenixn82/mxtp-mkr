// Production probe: verifies the REAL app behavior with no image backend -
// album + theme + lyrics apply, the error line is actionable, and the booklet
// falls back to washing pages with the REAL album artwork (the learned theme).
import { chromium } from "@playwright/test";
import path from "node:path";

const out = process.argv[2];

function log(message) {
  console.log(`[prod] ${message}`);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
const pageDeadline = Date.now() + 60_000;
while (!page && Date.now() < pageDeadline) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
    }
  }
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) throw new Error("MXTP MKR page not found");

await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30_000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
log("submitted via UI");

const applied = page.getByTestId("research-applied");
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const text = (await applied.textContent()) ?? "";
  if (text.includes("Radiohead - In Rainbows")) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
log(`research: ${((await applied.textContent()) ?? "").trim()}`);
log(`lyrics: ${await page.getByTestId("lyrics-coverage").textContent().catch(() => "none")}`);

// Theme learned from the REAL album artwork
const themeArt = page.getByTestId("theme-source-art");
await themeArt.waitFor({ timeout: 10_000 });
const swatches = await page.getByTestId("theme-swatches").locator("i").count();
log(`theme block: real artwork rendered, ${swatches} learned swatches`);
log(`theme tokens: ${await page.getByTestId("theme-tokens").textContent()}`);

// Honest failure surface: no image backend -> actionable error, no fake cover
const errorLine = (await page.getByTestId("research-error").textContent().catch(() => "")) ?? "";
log(`error line: ${errorLine.slice(0, 140)}`);
const hasCover = await page.getByTestId("cover-thumb").isVisible().catch(() => false);
log(`generated cover present: ${hasCover} (expected false without credentials)`);

// Booklet preview washes with the REAL album artwork (theme fallback)
const preview = page.getByTestId("booklet-preview");
await preview.waitFor({ timeout: 10_000 });
const tiles = await preview.locator(".bp-page").count();
const washes = await preview.locator(".bp-bg").count();
const coverTile = await preview.locator(".bp-cover").count();
log(`booklet preview: ${tiles} pages, cover tile from real artwork: ${coverTile}, washed text pages: ${washes}`);
await page.getByTestId("export-booklet").scrollIntoViewIfNeeded();
await page
  .locator("section.panel", { has: page.getByTestId("export-booklet") })
  .screenshot({ path: path.join(out, "prod-booklet-real-art.png") });
await page
  .locator("section.panel", { has: page.getByTestId("run-research") })
  .screenshot({ path: path.join(out, "prod-research-panel.png") });
log("shots saved");
await browser.close();
log("PROD_PROBE_DONE");
