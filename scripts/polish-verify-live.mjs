// Post-polish verification walk over CDP: landing sweep frames, vinyl stage,
// detail surfaces (burn band, hint, research chips), and an open-lid clip check.
import { chromium } from "@playwright/test";
import path from "node:path";

const outDir = process.argv[2] ?? "scratchpad-polish";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
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

function log(message) {
  console.log(`[verify] ${message}`);
}

async function shot(name, options = {}) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), ...options });
  log(`shot ${name}`);
}

await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 20_000 });

// Landing jewel sweep: sample 4 frames over ~22s (sweep period ~21s)
for (const [index, wait] of [[1, 2000], [2, 6000], [3, 6000], [4, 8000]]) {
  await page.waitForTimeout(wait);
  await shot(`sweep-${index}`);
}

// Vinyl stage: smear check
await page.getByLabel("Format").selectOption("vinyl");
await page.waitForTimeout(1200);
await shot("vinyl-stage");
await page.getByLabel("Format").selectOption("jewelcase");
await page.waitForTimeout(500);

// Detail view
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });

const applied = page.getByTestId("research-applied");
const researchDeadline = Date.now() + 240_000;
while (Date.now() < researchDeadline) {
  const text = (await applied.textContent()) ?? "";
  if (text.includes("Radiohead - In Rainbows")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await page.waitForTimeout(600);
await shot("detail-top");

// Burn band styled?
await page.getByTestId("burn-band").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.getByTestId("burn-band").screenshot({ path: path.join(outDir, "burn-band.png") });
log("shot burn-band");

// Research panel chips
await page.locator("section.panel", { has: page.getByTestId("run-research") }).screenshot({
  path: path.join(outDir, "research-panel.png")
});
log("shot research-panel");

// Open-lid clip check: click the case (canvas center) to open, screenshot the scene
const scene = page.getByTestId("case-scene");
await scene.scrollIntoViewIfNeeded();
const box = await scene.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1600); // spring settles
await scene.screenshot({ path: path.join(outDir, "detail-open-lid.png") });
log("shot detail-open-lid");

// Eject check: click the disc (slightly left-of-center where the CD sits)
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
await page.waitForTimeout(1800);
await scene.screenshot({ path: path.join(outDir, "detail-eject.png") });
log("shot detail-eject");

await browser.close();
log("VERIFY_WALK_DONE");
