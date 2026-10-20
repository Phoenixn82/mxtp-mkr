import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const ctx of browser.contexts())
  for (const c of ctx.pages()) if ((await c.title().catch(() => "")) === "MXTP MKR") page = c;
const logs = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[cad-debug]")) logs.push(t); });
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20000 });
const applied = page.getByTestId("research-applied");
const dl = Date.now() + 240000;
while (Date.now() < dl) {
  const t = (await applied.textContent().catch(() => "")) ?? "";
  if (t.includes("Radiohead")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
await new Promise((r) => setTimeout(r, 4000));
const front = await page.getByTestId("case-scene").getAttribute("data-front");
console.log("data-front now:", front ? `${front.slice(0, 40)}… len ${front.length}` : "(empty)");
console.log(logs.slice(-8).join("\n") || "(no [cad-debug] logs captured)");
await page.getByTestId("case-scene").screenshot({ path: process.argv[2] ?? "cad-recheck.png" });
process.exit(0);
