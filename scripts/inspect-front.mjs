import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const ctx of browser.contexts())
  for (const c of ctx.pages()) if ((await c.title().catch(() => "")) === "MXTP MKR") page = c;
const scene = page.getByTestId("case-scene");
const front = await scene.getAttribute("data-front");
const back = await scene.getAttribute("data-back");
const disc = await scene.getAttribute("data-disc");
console.log("data-front:", front ? front.slice(0, 90) : "(empty)");
console.log("data-back :", back ? back.slice(0, 90) : "(empty)");
console.log("data-disc :", disc ? disc.slice(0, 90) : "(empty)");
const chips = await page.getByTestId("assigned-strip").innerText().catch(() => "(no strip)");
console.log("assigned-strip:", chips.replace(/\n/g, " | "));
process.exit(0);
