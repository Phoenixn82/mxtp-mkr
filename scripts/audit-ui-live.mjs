// Design-review walk: screenshot every surface of the live Tauri app over CDP.
// Usage: node scripts/audit-ui-live.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "scratchpad-audit";
fs.mkdirSync(outDir, { recursive: true });

function log(message) {
  console.log(`[audit] ${message}`);
}

async function connect() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9333");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("CDP connect timeout");
}

const browser = await connect();
let page;
const deadline = Date.now() + 60_000;
while (!page && Date.now() < deadline) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if ((await candidate.title().catch(() => "")) === "MXTP MKR") {
        page = candidate;
      }
    }
  }
  if (!page) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!page) {
  throw new Error("MXTP MKR page not found");
}

async function shot(name, options = {}) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), ...options });
  log(`shot ${name}`);
}

// --- Landing ---
await page.getByTestId("landing-screen").waitFor({ timeout: 20_000 });
await page.waitForTimeout(1500); // let the 3D model settle
await shot("01-landing-jewelcase");
await page.getByLabel("Format").selectOption("vinyl");
await page.waitForTimeout(900);
await shot("02-landing-vinyl");
await page.getByLabel("Format").selectOption("cassette");
await page.waitForTimeout(900);
await shot("03-landing-cassette");
await page.getByLabel("Format").selectOption("jewelcase");
await page.waitForTimeout(600);

// --- Enter detail ---
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
await page.waitForTimeout(1200);
await shot("04-detail-initial");

// --- Wait for research to apply (mock cover + cached lyrics) ---
const applied = page.getByTestId("research-applied");
const researchDeadline = Date.now() + 240_000;
while (Date.now() < researchDeadline) {
  const text = (await applied.textContent()) ?? "";
  if (text.includes("Radiohead - In Rainbows")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await page.waitForTimeout(800);
await shot("05-detail-research-applied", { fullPage: true });

// --- 3D preview interactions (incl. open-lid clip check) ---
for (const action of ["rotate-preview", "open-lid", "flip-booklet", "spin-disc"]) {
  const button = page.getByTestId(action);
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(900);
    await shot(`06-preview-${action}`);
  } else {
    log(`SKIP preview action ${action} (not visible)`);
  }
}

// --- Slot editor per insert type ---
const insertSelect = page.getByTestId("insert-select");
if (await insertSelect.isVisible().catch(() => false)) {
  for (const type of ["front", "bifold", "saddle-12", "tray", "disc"]) {
    await insertSelect.selectOption(type).catch((error) => log(`selectOption ${type} failed: ${error.message}`));
    await page.waitForTimeout(400);
    await shot(`07-insert-${type}`);
  }
} else {
  log("SKIP insert walk (no insert-select)");
}

// --- Rail panels, status + burn bands (element shots) ---
for (const [name, locator] of [
  ["08-panel-research", page.locator("section.panel", { has: page.getByTestId("run-research") })],
  ["09-panel-booklet", page.locator("section.panel", { has: page.getByTestId("export-booklet") })],
  ["10-status-band", page.locator(".status-band")],
  ["11-burn-band", page.getByTestId("burn-band")]
]) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.screenshot({ path: path.join(outDir, `${name}.png`) });
    log(`shot ${name}`);
  } else {
    log(`SKIP ${name}`);
  }
}

await shot("12-detail-full", { fullPage: true });
await browser.close();
log("AUDIT_WALK_DONE");
