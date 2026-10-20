import { startCustomFromLibrary } from "../lib/wp2.mjs";
// WP4 backend contracts on the real release app: partial playlist downloads
// import what arrived, cached folders filter to the requested positions and
// drop music videos, failures read as one short sentence, GO output and picked
// art stay in the person's data, scratch CD audio is cleaned up, broken project
// files are set aside, and a chosen Apple Music library is remembered.
// Offline yt-dlp stub; burns are simulate-only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import { SINE_PLAYLIST_URL, SINE_WAVE_SUITE } from "../fixtures/lib/catalog.mjs";
import { SIZES, installErrorCollector, launchApp, pageErrors, setWindowSize, waitForReady } from "../helpers.mjs";
import {
  appDataRoot,
  buildMusicDb,
  clickButton,
  installInvokeGuard,
  pngBuffer,
  setFieldValue,
  textOf,
  visible,
  waitForText,
  waitVisible
} from "../lib/lib.mjs";
import { BLOCKED_ERROR, assetLoads, invokeRaw, partialYtdlpEnv, scratchWavs, tour } from "../lib/wp4.mjs";

const GHOST_URL = "https://www.youtube.com/playlist?list=e2eGhostSignals";

function catalog(cover) {
  return {
    albums: [
      {
        url: SINE_PLAYLIST_URL,
        title: "Sine Wave Suite",
        channel: "The Oscillators",
        artist: "The Oscillators",
        album: "Sine Wave Suite",
        cover,
        entries: [
          { title: "Alpha Tone", duration: 120 },
          { title: "Alpha Tone (Official Music Video)", duration: 125 },
          { title: "Beta Tone", duration: 180 },
          { title: "Gamma Tone", duration: 240, unavailable: true },
          { title: "Delta Tone", duration: 200 }
        ]
      },
      {
        url: GHOST_URL,
        title: "Ghost Signals",
        channel: "Static Choir",
        artist: "Static Choir",
        album: "Ghost Signals",
        entries: [
          { title: "Hum", duration: 100, unavailable: true },
          { title: "Hiss", duration: 110, unavailable: true }
        ]
      }
    ],
    videos: []
  };
}

const VALID_PROJECT = {
  id: "wp4-valid",
  name: "Valid Tapes",
  kind: "artist",
  saved: true,
  entry: { artist: "Night Owl", album: "Valid Tapes", formatId: "jewelcase" },
  burnQueue: [],
  tracks: [],
  art: [],
  researchApplied: [],
  research: null,
  bookletPages: 16,
  exports: [],
  burnProgress: 0,
  playlistUrl: "",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z"
};

describe("WP4 backend contracts on the real app", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mxtp-e2e-wp4-"));
  const tmp = path.join(home, "tmp");
  const cover = path.join(home, "youtube-cover.png");
  const elsewhere = path.join(home, "Elsewhere", "Moved Library.musiclibrary");
  let app;
  let driver;
  let dataRoot;

  async function createFromLanding(artist, album) {
    if (!(await visible(driver, By.css('[data-testid="landing-screen"]')))) {
      await driver.findElement(By.css('[data-testid="catalog-button"]')).click();
      const leave = await visible(driver, By.css('[role="alertdialog"]'));
      if (leave) await clickButton(driver, "Discard");
      if (await visible(driver, By.css('[data-testid="apple-library"]'))) await startCustomFromLibrary(driver);
      await waitVisible(driver, By.css('[data-testid="landing-screen"]'));
    }
    const [artistInput, albumInput] = await driver.findElements(By.css(".landing-form .landing-field input"));
    await setFieldValue(driver, artistInput, artist);
    await setFieldValue(driver, albumInput, album);
    await clickButton(driver, "Create album CD");
    await waitVisible(driver, By.css('[data-testid="print-burn"]'), 15_000, "project detail");
    await driver.findElement(By.css(".audio-source-actions details > summary")).click();
  }

  // By testid: WP2 relabels this button ("Download playlist").
  async function clickDownload() {
    const button = await waitVisible(driver, By.css('[data-testid="playlist-burn-button"]'), 15_000, "download button");
    await driver.wait(until.elementIsEnabled(button), 15_000, "download button stayed disabled");
    await button.click();
  }

  const trackTitles = () =>
    driver.executeScript("return [...document.querySelectorAll('[data-testid=track-list] li .track-title-input')].map((input) => input.value)");

  before(async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(cover, pngBuffer([230, 120, 30], 160));
    mkdirSync(path.join(elsewhere, "artwork"), { recursive: true });
    writeFileSync(path.join(elsewhere, "Library.musicdb"), buildMusicDb({ tracks: SINE_WAVE_SUITE }));
    app = await launchApp({
      home,
      env: { ...partialYtdlpEnv(home, catalog(cover)), TMPDIR: tmp },
      seed: (dirs) => {
        const projects = path.join(appDataRoot(dirs), "projects");
        mkdirSync(projects, { recursive: true });
        writeFileSync(path.join(projects, "wp4-valid.json"), JSON.stringify(VALID_PROJECT, null, 2));
        writeFileSync(path.join(projects, "wp4-null-entry.json"), JSON.stringify({ ...VALID_PROJECT, id: "wp4-null-entry", entry: null }));
        writeFileSync(path.join(projects, "wp4-not-json.json"), "{ half a project");
      }
    });
    driver = app.driver;
    dataRoot = appDataRoot(app.dirs);
    await driver.manage().setTimeouts({ script: 120_000 });
    await waitForReady(driver);
    await installErrorCollector(driver);
    await installInvokeGuard(driver);
    await setWindowSize(driver, SIZES.desktop);
  });

  after(async () => {
    await app?.close();
  });

  it("a structurally broken project file is set aside and the rest still load", async () => {
    const loaded = await invokeRaw(driver, "load_cd_projects");
    assert.ok(loaded.ok, loaded.error);
    assert.deepEqual(loaded.value.map((project) => project.id), ["wp4-valid"]);
    const files = readdirSync(path.join(dataRoot, "projects")).sort();
    assert.ok(files.includes("wp4-null-entry.json.corrupt"), files.join(", "));
    assert.ok(files.includes("wp4-not-json.json.corrupt"), files.join(", "));
  });

  it("a playlist download with one blocked entry still loads the tracks that arrived", async () => {
    await createFromLanding("The Oscillators", "Sine Wave Suite");
    await waitForText(driver, '[data-testid="burn-message"]', /^Found/, 60_000);
    await clickDownload();
    await driver.wait(async () => (await trackTitles()).length > 0, 120_000, "no tracks loaded");
    const titles = await trackTitles();
    assert.deepEqual(titles, ["Alpha Tone", "Beta Tone", "Delta Tone"]);
    assert.doesNotMatch(await textOf(driver, '[data-testid="burn-message"]'), /failed/i);
    await tour(driver, "partial-download", { focus: By.css('[data-testid="track-list"]') });
  });

  it("a download where nothing arrives fails with one short sentence", async () => {
    await createFromLanding("Static Choir", "Ghost Signals");
    await waitForText(driver, '[data-testid="burn-message"]', /^Found/, 60_000);
    await clickDownload();
    const message = await waitForText(driver, '[data-testid="burn-message"]', /failed/, 120_000);
    const expected = `Couldn't download Ghost Signals: ${BLOCKED_ERROR.replace(/^ERROR:\s*/, "")}`;
    assert.ok(message.endsWith(expected), message);
    assert.ok(message.length < 260, `${message.length} chars`);
    assert.doesNotMatch(message, /\[download\]|-Update|Playlist to MP3/);
    await tour(driver, "download-error", { focus: By.css('[data-testid="burn-message"]') });
  });

  it("a cached folder returns only the requested positions, prefixes kept, videos dropped", async () => {
    const picked = await invokeRaw(driver, "download_playlist_best", { url: SINE_PLAYLIST_URL, playlistItems: "1,2,3" });
    assert.ok(picked.ok, picked.error);
    assert.deepEqual(picked.value.tracks.map((track) => path.basename(track.path)), ["001 - Alpha Tone.wav", "003 - Beta Tone.wav"]);
    assert.deepEqual(picked.value.tracks.map((track) => track.title), ["Alpha Tone", "Beta Tone"]);
    assert.equal(picked.value.skipped, 0, "a dropped music video is not a skipped entry");
    const zero = await invokeRaw(driver, "download_playlist_best", { url: SINE_PLAYLIST_URL, playlistItems: "0" });
    assert.equal(zero.ok, false);
    const cached = await invokeRaw(driver, "list_cached_playlists");
    assert.ok(cached.ok, cached.error);
    const sine = cached.value.find((playlist) => playlist.title === "Sine Wave Suite");
    assert.ok(sine, JSON.stringify(cached.value.map((playlist) => playlist.title)));
    assert.ok(!sine.tracks.some((track) => /video/i.test(track.title)), sine.tracks.map((track) => track.title).join(" | "));
    assert.ok(existsSync(path.join(sine.sourcePath, ".mxtp-tracks.json")), "probe cache not written");
  });

  it("GO-style PDFs land under the person's app data and scratch CD audio is cleaned up", async () => {
    const pdf = await invokeRaw(driver, "compose_pdf", { piece: { pieceId: "front", outputDir: "exports/wp4/t1", images: [], texts: [] } });
    assert.ok(pdf.ok, pdf.error);
    assert.ok(pdf.value.path.startsWith(path.join(dataRoot, "exports", "wp4", "t1")), pdf.value.path);
    assert.ok(existsSync(pdf.value.path));

    const source = path.join(dataRoot, "playlists", "Sine Wave Suite", "001 - Alpha Tone.wav");
    // The 1.5 s stub tones need a gap to reach the 4 s CD-DA track minimum.
    const pcm = await invokeRaw(driver, "prepare_pcm", { paths: [source, source, source], gapSec: 3, normalize: false });
    assert.ok(pcm.ok, pcm.error);
    assert.equal(scratchWavs(tmp).length, 3, "prepare_pcm writes one scratch WAV per track");
    const image = await invokeRaw(driver, "build_cda_image", { tracks: pcm.value });
    assert.ok(image.ok, image.error);
    const burn = await invokeRaw(driver, "burn_cda", { image: image.value, drive: "simulate", simulate: true });
    assert.ok(burn.ok, burn.error);
    assert.equal(burn.value.simulated, true);
    assert.deepEqual(scratchWavs(tmp), []);
  });

  it("a program over 79:57 is refused when the CD image is built", async () => {
    const track = (durationSec) => ({ path: path.join(tmp, "mxtp_mkr_track_fake.wav"), durationSec, sampleRate: 44_100, channels: 2, bitsPerSample: 16 });
    const result = await invokeRaw(driver, "build_cda_image", { tracks: [track(4_000), track(1_000)] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Program is 83:20; an 80-minute CD-R holds 79:57/);
  });

  it("a picture picked from outside the app is copied into app data", async () => {
    const picture = path.join(home, "Pictures", "My Cover.PNG");
    mkdirSync(path.dirname(picture), { recursive: true });
    writeFileSync(picture, pngBuffer([20, 160, 90], 120));
    const copied = await invokeRaw(driver, "copy_art_file", { path: picture });
    assert.ok(copied.ok, copied.error);
    assert.ok(copied.value.startsWith(path.join(dataRoot, "covers", "picked")), copied.value);
    assert.ok(existsSync(copied.value));
    assert.equal(await assetLoads(driver, copied.value), true, "copied art is not viewable through the asset scope");
    const again = await invokeRaw(driver, "copy_art_file", { path: picture });
    assert.equal(again.value, copied.value, "the same picture is stored once");
  });

  it("cover edit availability is a plain yes or no", async () => {
    const available = await invokeRaw(driver, "cover_edit_available");
    assert.ok(available.ok, available.error);
    const expected = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID?.trim() && process.env.CLOUDFLARE_API_TOKEN?.trim());
    assert.equal(available.value, expected);
  });

  it("a chosen Apple Music library location is remembered", async () => {
    const first = await invokeRaw(driver, "import_apple_music_library", { path: path.join(elsewhere, "Library.musicdb") });
    assert.ok(first.ok, first.error);
    const second = await invokeRaw(driver, "import_apple_music_library", {});
    assert.ok(second.ok, second.error);
    assert.equal(second.value.sourcePath, first.value.sourcePath);
    assert.equal(second.value.summary.trackCount, SINE_WAVE_SUITE.length);
    assert.ok(existsSync(path.join(dataRoot, "apple-music-library.json")));
  });

  it("raised no page errors", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
