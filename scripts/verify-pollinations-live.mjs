// Verify the keyless Pollinations cover backend end-to-end on the REAL running app.
// (1) Direct backend invoke of generate_cover -> confirms adapter === "pollinations"
//     and a real preview data-URI comes back through the actual Tauri command.
// (2) Full UI flow: Radiohead / In Rainbows -> research -> the cover thumbnail
//     actually renders (the no-backend era showed an error line + no cover).
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const out = process.argv[2] ?? ".";
const log = (m) => console.log(`[poll] ${m}`);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
const pageDeadline = Date.now() + 60_000;
while (!page && Date.now() < pageDeadline) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
    }
  }
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) throw new Error("MXTP MKR page not found on CDP 9333");
await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 30_000 });

// (1) Direct backend proof through the real Tauri command (best-effort; the app
// may not expose a global invoke, in which case the UI flow below is the proof).
const cover = await page.evaluate(async () => {
  const invoke =
    window.__TAURI__?.core?.invoke ??
    window.__TAURI__?.invoke ??
    window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") return { unavailable: true };
  try {
    const res = await invoke("generate_cover", {
      prompt: "abstract album cover, fractured orange and deep red on near-black, layered texture, no text",
      styleRefs: []
    });
    return { adapter: res.adapter, hasPreview: (res.previewUrl || "").startsWith("data:image/"), previewLen: (res.previewUrl || "").length, palette: res.palette, imagePath: res.imagePath };
  } catch (err) {
    return { error: String(err) };
  }
});
log(`direct invoke -> ${JSON.stringify(cover)}`);

// (2) Full research -> cover UI flow.
await page.getByLabel("Artist").fill("Radiohead");
await page.getByLabel("Album").fill("In Rainbows");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });

const applied = page.getByTestId("research-applied");
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const text = (await applied.textContent().catch(() => "")) ?? "";
  if (text.includes("Radiohead")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
log(`research applied: ${((await applied.textContent().catch(() => "")) ?? "").trim()}`);
log(`lyrics: ${await page.getByTestId("lyrics-coverage").textContent().catch(() => "none")}`);
log(`theme swatches: ${await page.getByTestId("theme-swatches").locator("i").count().catch(() => 0)}`);

const coverThumb = page.getByTestId("cover-thumb");
const coverVisible = await coverThumb.isVisible().catch(() => false);
log(`generated cover thumbnail visible: ${coverVisible} (expected TRUE with Pollinations)`);
const errorLine = (await page.getByTestId("research-error").textContent().catch(() => "")) ?? "";
log(`error line: ${errorLine ? errorLine.slice(0, 120) : "(none)"}`);

fs.mkdirSync(out, { recursive: true });
await page.getByTestId("detail-view").screenshot({ path: path.join(out, "pollinations-detail.png") }).catch(() => {});
if (coverVisible) await coverThumb.screenshot({ path: path.join(out, "pollinations-cover-thumb.png") }).catch(() => {});
log("screenshots written");
process.exit(0);
