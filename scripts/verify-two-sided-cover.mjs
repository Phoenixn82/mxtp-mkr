import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
const out = process.argv[2] ?? ".";
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[cover2] ${m}`);
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
await new Promise((r) => setTimeout(r, 4000));
const scene = page.getByTestId("case-scene");
const box = await scene.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

await scene.screenshot({ path: path.join(out, "closed-default.png") });
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2800));
await scene.screenshot({ path: path.join(out, "open-default.png") });
log("default angle captured");

// Orbit around to view the BACK of the open lid (where it used to vanish/mirror).
async function orbitDrag(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 20 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 1200));
}
await orbitDrag(-260, 20);
await scene.screenshot({ path: path.join(out, "open-orbited-1.png") });
await orbitDrag(-220, 0);
await scene.screenshot({ path: path.join(out, "open-orbited-2.png") });
log("orbited angles captured");
process.exit(0);
