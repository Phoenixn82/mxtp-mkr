import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
const out = process.argv[2] ?? ".";
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[sweep] ${m}`);
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
await scene.screenshot({ path: path.join(out, "sweep-00-closed.png") });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const delays = [400, 900, 1500, 2200, 3000, 4200];
for (let i = 0; i < delays.length; i++) {
  await new Promise((r) => setTimeout(r, i === 0 ? delays[0] : delays[i] - delays[i - 1]));
  await scene.screenshot({ path: path.join(out, `sweep-${String(i + 1).padStart(2, "0")}-t${delays[i]}.png`) });
  log(`captured t=${delays[i]}ms`);
}
process.exit(0);
