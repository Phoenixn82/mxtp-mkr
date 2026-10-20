import { chromium } from "@playwright/test";

const titles = [
  "Shattered Dreams",
  "Red Water",
  "Cold Summers",
  "Nowhere2go",
  "December 24",
  "Ontheway!",
  "The Mint",
  "The Bends",
  "Loosie",
  "Azucar",
  "Eclipse",
  "Veins",
  "Playing Possum",
  "Peanut",
  "Riot!"
];

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
  }
}
if (!page) throw new Error("MXTP MKR page not found");

const match = await page.evaluate(async (expectedTracks) => {
  return window.__TAURI_INTERNALS__.invoke("find_youtube_album_playlist", {
    artist: "Earl Sweatshirt",
    album: "Some Rap Songs",
    expectedTracks
  });
}, titles.map((title) => ({ title, durationSec: 0 })));

if (!match.url?.includes("youtube.com/playlist")) throw new Error(`Unexpected match URL: ${match.url}`);
if (match.trackCount < 15) throw new Error(`Expected a complete album, got ${match.trackCount} tracks`);
if (match.confidence < 0.78) throw new Error(`Confidence gate was not met: ${match.confidence}`);
console.log(JSON.stringify(match, null, 2));
console.log("YOUTUBE_MATCH_LIVE_OK");
await browser.close();
