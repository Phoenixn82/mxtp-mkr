import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.env.MXTP_E2E_OUTPUT_DIR ?? path.join(process.cwd(), "test-results", "themes-live");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: "light" });
const page = await context.newPage();

await page.addInitScript(() => {
  if (!sessionStorage.getItem("mxtp-theme-test-started")) {
    localStorage.clear();
    sessionStorage.setItem("mxtp-theme-test-started", "true");
  }
  const tracks = [
    { id: "1", title: "Digital Love", artist: "Daft Punk", album: "Discovery", albumArtist: "Daft Punk", genre: "Electronic", trackNumber: 1, year: 2001, durationSec: 301, playCount: 91, lastPlayedUnixMs: 9, likeStatus: 1 },
    { id: "2", title: "Something About Us", artist: "Daft Punk", album: "Discovery", albumArtist: "Daft Punk", genre: "Electronic", trackNumber: 2, year: 2001, durationSec: 232, playCount: 74, lastPlayedUnixMs: 8, likeStatus: 1 },
    { id: "3", title: "Azucar", artist: "Earl Sweatshirt", album: "Some Rap Songs", albumArtist: "Earl Sweatshirt", genre: "Hip-Hop", trackNumber: 10, year: 2018, durationSec: 86, playCount: 44, lastPlayedUnixMs: 7, likeStatus: 0 },
    { id: "4", title: "Scene", artist: "prettifun", album: "Pretti Loves U 2", albumArtist: "prettifun", genre: "Pop", trackNumber: 1, year: 2025, durationSec: 156, playCount: 37, lastPlayedUnixMs: 6, likeStatus: 0 }
  ];
  window.__MXTP_INVOKE__ = async (command) => {
    if (command === "import_apple_music_library") return { sourcePath: "mock", version: "1", summary: { trackCount: 4, albumCount: 3, artistCount: 3, playlistCount: 0, totalPlays: 246, artworkTrackCount: 0 }, tracks, playlists: [] };
    if (command === "load_cd_projects" || command === "list_cached_playlists" || command === "list_burners") return [];
    if (command === "save_cd_project") return undefined;
    throw new Error(command);
  };
});

await page.goto("http://127.0.0.1:5173");
await page.getByTestId("apple-library").waitFor();
await page.getByRole("button", { name: "Light" }).click();
if ((await page.locator("html").getAttribute("data-theme")) !== "light") throw new Error("Light theme did not apply");
await page.screenshot({ path: `${out}/mxtp-theme-light-library.png`, fullPage: true });

await page.getByRole("button", { name: "Dark" }).click();
if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Dark theme did not apply");
if (await page.evaluate(() => localStorage.getItem("mxtp:color-theme:v1")) !== "dark") throw new Error("Dark theme did not persist");
const inputScheme = await page.getByPlaceholder("Artists, albums, genres").evaluate((node) => getComputedStyle(node).colorScheme);
if (inputScheme !== "dark") throw new Error(`Input did not adopt dark controls: ${inputScheme}`);
await page.screenshot({ path: `${out}/mxtp-theme-dark-library.png`, fullPage: true });

await page.getByRole("button", { name: "Open Discovery" }).click();
await page.getByRole("button", { name: "Select all" }).click();
await page.getByRole("button", { name: "Add to burn list" }).click();
await page.screenshot({ path: `${out}/mxtp-theme-dark-player.png`, fullPage: true });
await page.reload();
await page.getByTestId("apple-library").waitFor();
if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Theme was lost after reload");

const studio = await context.newPage();
await studio.addInitScript(() => {
  window.__MXTP_INVOKE__ = async (command, args) => {
    if (command === "import_apple_music_library") throw new Error("No local library in browser QA");
    if (command === "load_cd_projects" || command === "list_cached_playlists" || command === "list_burners") return [];
    if (command === "lookup_album") return { artist: args?.artist, album: args?.album, year: 2001, label: "Virgin", tracks: ["Digital Love", "Something About Us"], coverArtUrls: [], tags: ["electronic"] };
    if (command === "fetch_lyrics") return "Neon lights over a midnight grid";
    if (command === "save_cd_project") return undefined;
    throw new Error(command);
  };
});
await studio.goto("http://127.0.0.1:5173");
await studio.getByTestId("landing-screen").waitFor();
if ((await studio.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("Theme did not carry to landing surface");
await studio.screenshot({ path: `${out}/mxtp-theme-dark-landing.png`, fullPage: true });
await studio.getByLabel("Artist").fill("Daft Punk");
await studio.getByLabel("Album").fill("Discovery");
await studio.getByRole("button", { name: "Create" }).click();
await studio.getByTestId("detail-view").waitFor();
await studio.screenshot({ path: `${out}/mxtp-theme-dark-studio.png`, fullPage: true });
await studio.getByRole("button", { name: "Light" }).click();
await studio.screenshot({ path: `${out}/mxtp-theme-light-studio.png`, fullPage: true });

console.log("THEMES_LIVE_OK");
await browser.close();
