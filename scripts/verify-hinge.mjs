import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
const out = process.argv[2] ?? ".";
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[hinge] ${m}`);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
const dl = Date.now() + 60000;
while (!page && Date.now() < dl) {
  for (const ctx of browser.contexts())
    for (const c of ctx.pages()) if ((await c.title().catch(() => "")) === "MXTP MKR") page = c;
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20000 });
const applied = page.getByTestId("research-applied");
let t0 = Date.now();
while (Date.now() - t0 < 240000) {
  if (((await applied.textContent().catch(() => "")) ?? "").includes("Radiohead")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
// Apply the REAL cover (has text) so orientation is unambiguous.
await page.getByTestId("use-real-cover").click();
await new Promise((r) => setTimeout(r, 6000));
const scene = page.getByTestId("case-scene");
await scene.screenshot({ path: path.join(out, "hinge-closed.png") });
log("closed shot");
// Click the case to open the lid.
const box = await scene.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await new Promise((r) => setTimeout(r, 2800));
await scene.screenshot({ path: path.join(out, "hinge-open.png") });
log("open shot");
process.exit(0);
