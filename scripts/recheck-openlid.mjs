// Re-check the detail preview open-lid framing after the camera pull-back.
import { chromium } from "@playwright/test";
import path from "node:path";

const out = process.argv[2];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if ((await p.title().catch(() => "")) === "MXTP MKR") page = p;
  }
}
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 20_000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
await page.waitForTimeout(1500);

const scene = page.getByTestId("case-scene");
const box = await scene.boundingBox();
await scene.screenshot({ path: path.join(out, "recheck-closed.png") });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1600);
await scene.screenshot({ path: path.join(out, "recheck-open.png") });
// eject
await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.waitForTimeout(1800);
await scene.screenshot({ path: path.join(out, "recheck-eject.png") });
console.log("done");
await browser.close();
