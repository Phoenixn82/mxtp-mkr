// Ground-truth the hinge geometry: orbit the camera to several angles and capture
// closed + open at each, with an AxesHelper on the hinge pivot + a wireframe box on the
// disc/tray (added temporarily in JewelCaseGltf.tsx). No sign-guessing — just look at it.
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
const out = process.argv[2] ?? ".";
fs.mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[probe] ${m}`);

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

async function orbitDrag(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 15 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 1200));
}

async function shot(name) {
  await scene.screenshot({ path: path.join(out, `${name}.png`) });
  log(`shot: ${name}`);
}

// 1) Default angle, closed.
await shot("default-closed");
// Open by clicking the case (avoid the exact center where drag might have moved orbit target).
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2800));
await shot("default-open");
// Close again before re-orbiting.
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2200));

// 2) Orbit to near top-down (drag down = typically pitches camera up/over the top).
await orbitDrag(0, 220);
await shot("topdown-closed");
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2800));
await shot("topdown-open");
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2200));

// 3) Orbit further / differently for a near-straight-down view.
await orbitDrag(0, 150);
await shot("topdown2-closed");
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 2800));
await shot("topdown2-open");

process.exit(0);
