// Demonstration: cover-art preview + formatted booklet lyric-page preview,
// driven entirely through UI elements on the real Tauri app.
import { chromium } from "@playwright/test";
import path from "node:path";

const out = process.argv[2];

function log(message) {
  console.log(`[demo] ${message}`);
}

async function connect() {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9333");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError ?? new Error("CDP connect timeout");
}

const browser = await connect();
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

// --- UI: landing -> Create (auto-lookup) ---
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30_000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
log("submitted via UI: Radiohead - In Rainbows");

// --- wait for research (cover gen + per-track lyrics) ---
const applied = page.getByTestId("research-applied");
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const text = (await applied.textContent()) ?? "";
  if (text.includes("Radiohead - In Rainbows")) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
log(`research: ${((await applied.textContent()) ?? "").trim()}`);
log(`lyrics: ${await page.getByTestId("lyrics-coverage").textContent().catch(() => "none")}`);

// --- 1. AI cover preview in the research panel ---
const thumb = page.getByTestId("cover-thumb");
await thumb.waitFor({ timeout: 15_000 });
const thumbSrc = (await thumb.getAttribute("src")) ?? "";
log(`cover-thumb rendered: data URI length ${thumbSrc.length}, is-image=${thumbSrc.startsWith("data:image/")}`);
await page
  .locator("section.panel", { has: page.getByTestId("run-research") })
  .screenshot({ path: path.join(out, "demo-cover-preview.png") });
log("shot demo-cover-preview");

// --- 2. Booklet page-layout preview ---
const preview = page.getByTestId("booklet-preview");
await preview.waitFor({ timeout: 15_000 });
const tiles = await preview.locator(".bp-page").count();
log(`booklet preview tiles: ${tiles}`);
const captions = await preview.locator(".bp-caption").allTextContents();
log(`page captions: ${captions.join(" | ")}`);
await page.getByTestId("export-booklet").scrollIntoViewIfNeeded();
await page
  .locator("section.panel", { has: page.getByTestId("export-booklet") })
  .screenshot({ path: path.join(out, "demo-booklet-preview.png") });
log("shot demo-booklet-preview");

// --- 3. UI interaction: page count changes reflow the preview live ---
await page.getByRole("button", { name: "Add" }).click(); // 16 -> 20
await page.waitForTimeout(600);
const tiles20 = await preview.locator(".bp-page").count();
log(`after Add via UI: ${await page.getByTestId("booklet-pages").textContent()} -> ${tiles20} tiles`);
await page
  .locator("section.panel", { has: page.getByTestId("export-booklet") })
  .screenshot({ path: path.join(out, "demo-booklet-preview-20.png") });
await page.getByRole("button", { name: "Remove" }).click(); // back to 16
await page.waitForTimeout(400);

// --- 4. Artwork panel: assign the researched cover via its UI button ---
await page.getByTestId("use-researched-cover").click();
await page.waitForTimeout(600);
await page
  .locator("section.panel", { has: page.getByTestId("insert-select") })
  .screenshot({ path: path.join(out, "demo-artwork-panel.png") });
log("shot demo-artwork-panel");

// --- 5. the 3D case carries the generated art on the lid insert ---
await page.getByTestId("case-scene").scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await page.getByTestId("case-scene").screenshot({ path: path.join(out, "demo-case-art.png") });
log("shot demo-case-art");

await page.screenshot({ path: path.join(out, "demo-full-view.png"), fullPage: true });
log("DEMO_WALK_DONE");
await browser.close();
