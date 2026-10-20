import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
const out = process.argv[2] ?? ".";
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[btn] ${m}`);

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
await new Promise((r) => setTimeout(r, 3000));
const scene = page.getByTestId("case-scene");
const before = (await scene.getAttribute("data-front")) ?? "";

// (1) Use real album cover
await page.getByTestId("use-real-cover").click();
t0 = Date.now();
while (Date.now() - t0 < 60000) {
  const now = (await scene.getAttribute("data-front")) ?? "";
  if (now && now !== before) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const afterReal = (await scene.getAttribute("data-front")) ?? "";
log(`real cover applied: ${afterReal !== before && afterReal.length > 0}`);
await new Promise((r) => setTimeout(r, 3500));
await scene.screenshot({ path: path.join(out, "real-cover.png") });

// (2) Generate grounded cover (vision -> Pollinations; allow up to ~2min)
await page.getByTestId("generate-grounded-cover").click();
t0 = Date.now();
while (Date.now() - t0 < 130000) {
  const now = (await scene.getAttribute("data-front")) ?? "";
  if (now && now !== afterReal) break;
  await new Promise((r) => setTimeout(r, 1500));
}
const afterGrounded = (await scene.getAttribute("data-front")) ?? "";
log(`grounded cover applied: ${afterGrounded !== afterReal && afterGrounded.length > 0}`);
const err = (await page.getByTestId("research-error").textContent().catch(() => "")) ?? "";
log(`error line: ${err ? err.slice(0, 140) : "(none)"}`);
await new Promise((r) => setTimeout(r, 3500));
await scene.screenshot({ path: path.join(out, "grounded-cover.png") });
log("screenshots written");
process.exit(0);
