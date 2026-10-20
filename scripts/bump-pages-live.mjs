// Bump the booklet page count in the live app (each "Add" click steps the
// saddle page count: 16 -> 20 -> 24). Usage: node scripts/bump-pages-live.mjs [clicks]
import { chromium } from "@playwright/test";

const clicks = Number(process.argv[2] ?? "2");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if ((await candidate.title()) === "MXTP MKR") {
      page = candidate;
    }
  }
}
if (!page) {
  throw new Error("MXTP MKR page not found over CDP");
}
for (let i = 0; i < clicks; i += 1) {
  await page.getByRole("button", { name: "Add" }).click();
}
console.log("booklet-pages:", await page.getByTestId("booklet-pages").textContent());
await browser.close();
