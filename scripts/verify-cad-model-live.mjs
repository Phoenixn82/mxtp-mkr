// Live-verify the reconstructed July-4 CAD jewel case on the detail page:
// disc seated inside (not through the shell), cover reads clean (de-glared), no render errors.
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const out = process.argv[2] ?? ".";
const log = (m) => console.log(`[cad] ${m}`);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
const deadline = Date.now() + 60_000;
while (!page && Date.now() < deadline) {
  for (const ctx of browser.contexts())
    for (const c of ctx.pages()) if ((await c.title().catch(() => "")) === "MXTP MKR") page = c;
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) throw new Error("MXTP MKR page not found");

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30_000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
log("on detail view");

// Wait for research to fully apply so the front slot carries the real cover art.
const applied = page.getByTestId("research-applied");
const covDeadline = Date.now() + 240_000;
while (Date.now() < covDeadline) {
  const t = (await applied.textContent().catch(() => "")) ?? "";
  if (t.includes("Radiohead")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
log(`research applied: ${((await applied.textContent().catch(() => "")) ?? "").trim()}`);
// let the r3f scene settle
await new Promise((r) => setTimeout(r, 4500));

const scene = page.getByTestId("case-scene");
await scene.screenshot({ path: path.join(out, "cad-closed.png") });
log("screenshot: closed");

// Click the case to open (disc ejects) — checks disc orientation/seat when visible.
const box = await scene.boundingBox();
if (box) {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 2500));
  await scene.screenshot({ path: path.join(out, "cad-open.png") });
  log("screenshot: open");
}

log(`render errors: ${errors.length ? JSON.stringify(errors.slice(0, 5)) : "none"}`);
process.exit(0);
