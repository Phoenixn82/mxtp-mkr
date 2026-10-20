// Verify the Phase-A cover-pipeline backend directly through the real Tauri commands (no UI yet).
import { chromium } from "@playwright/test";
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
await page.waitForFunction(
  () => typeof (window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke) === "function",
  { timeout: 20000 }
);

const out = await page.evaluate(async () => {
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") return { error: "no invoke" };
  const log = {};
  try {
    const album = await invoke("lookup_album", { artist: "Radiohead", album: "In Rainbows" });
    log.album = { year: album.year, tracks: album.tracks?.length, covers: album.coverArtUrls?.length };

    const real = await invoke("fetch_real_cover_file", { coverArtUrls: album.coverArtUrls });
    log.realCover = { path: real.imagePath, previewLen: (real.previewUrl || "").length, palette: real.palette };

    const era = await invoke("fetch_era_covers", { artist: "Radiohead", year: album.year, limit: 5 });
    log.eraCovers = era;

    const prompt = await invoke("art_direct_from_references", {
      albumLabel: "Radiohead - In Rainbows",
      coverArtUrls: album.coverArtUrls,
      eraRefUrls: era.slice(0, 3)
    });
    log.artDirection = prompt;
  } catch (err) {
    log.error = String(err);
  }
  return log;
});
console.log(JSON.stringify(out, null, 2));
process.exit(0);
