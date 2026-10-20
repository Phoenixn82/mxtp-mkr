import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const ctx of browser.contexts())
  for (const c of ctx.pages()) if ((await c.title().catch(() => "")) === "MXTP MKR") page = c;
const logs = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[hinge-debug]")) logs.push(t); });
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30000 });
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20000 });
await new Promise((r) => setTimeout(r, 6000));
console.log(logs.slice(-3).join("\n") || "(no hinge-debug logs)");
process.exit(0);
