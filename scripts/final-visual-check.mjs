// Final visual spot-check: cassette materials + jewel landing sweep frame.
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
await page.getByLabel("Format").selectOption("cassette");
await page.waitForTimeout(1400);
await page.screenshot({ path: path.join(out, "final-cassette.png") });
await page.getByLabel("Format").selectOption("jewelcase");
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, "final-jewel-landing.png") });
console.log("done");
await browser.close();
