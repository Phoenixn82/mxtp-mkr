#!/usr/bin/env node
// Offline stand-in for yt-dlp, used through MXTP_YTDLP_PATH by the lib-*
// native e2e specs. It answers only the invocations MXTP MKR makes
// (src-tauri/src/youtube.rs and src-tauri/resources/playlist_fetch.py) from a
// JSON catalog (MXTP_E2E_YTDLP_CATALOG) and logs every call as one JSON line
// to MXTP_E2E_YTDLP_LOG. "Downloads" are short synthetic sine-tone WAVs.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (process.env.MXTP_E2E_YTDLP_LOG) {
  appendFileSync(process.env.MXTP_E2E_YTDLP_LOG, `${JSON.stringify({ argv, at: new Date().toISOString() })}\n`);
}

const catalog = process.env.MXTP_E2E_YTDLP_CATALOG
  ? JSON.parse(readFileSync(process.env.MXTP_E2E_YTDLP_CATALOG, "utf8"))
  : { albums: [], videos: [] };
const albums = catalog.albums ?? [];
const videos = catalog.videos ?? [];

const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const separator = argv.indexOf("--");
const url = separator >= 0 ? argv[separator + 1] : undefined;
const key = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const print = (line) => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`ERROR: [e2e stub] ${message}\n`);
  process.exit(1);
};

if (catalog.failAll) fail(catalog.failAll);

// catalog.delayMs = { search, probe, download } slows a call so specs can
// observe loading states.
const pause = (kind) => {
  const ms = catalog.delayMs?.[kind];
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

if (has("--version")) {
  print("2026.09.01 (e2e stub)");
  process.exit(0);
}
if (!url) fail(`no URL in ${JSON.stringify(argv)}`);

const album = albums.find((candidate) => candidate.url === url);
const video = videos.find((candidate) => candidate.url === url);

// Album search: youtube.rs queries "<artist> <album> official album"; the
// sidecar's -ResolveOnly path queries "<artist> <album>".
if (has("--dump-json") && url.startsWith("https://www.youtube.com/results?")) {
  pause("search");
  const query = key(new URL(url).searchParams.get("search_query"));
  for (const candidate of albums) {
    const matches = (candidate.queries ?? [`${candidate.artist} ${candidate.album}`]).some((text) => query.includes(key(text)));
    if (matches) print(JSON.stringify({ _type: "url", title: candidate.title, url: candidate.url, webpage_url: candidate.url }));
  }
  process.exit(0);
}

// Single-track search: "ytsearch8:<artist> <title> official audio".
if (has("--dump-json") && url.startsWith("ytsearch")) {
  const query = key(url.slice(url.indexOf(":") + 1));
  for (const candidate of videos) {
    if (!query.includes(key(candidate.query))) continue;
    print(JSON.stringify({
      _type: "url",
      title: candidate.title,
      url: candidate.url,
      webpage_url: candidate.url,
      channel: candidate.channel,
      duration: candidate.duration
    }));
  }
  process.exit(0);
}

if (has("--dump-single-json")) {
  pause("probe");
  if (!album) fail(`no playlist fixture for ${url}`);
  print(JSON.stringify({
    _type: "playlist",
    title: album.title,
    channel: album.channel,
    uploader: album.channel,
    entries: album.entries.map((entry, index) => ({
      _type: "url",
      title: entry.title,
      duration: entry.duration,
      channel: entry.channel ?? album.channel,
      url: `${album.url}&index=${index + 1}`
    }))
  }));
  process.exit(0);
}

const printFormat = value("--print");
if (printFormat) {
  if (album) {
    print(printFormat
      .replace("%(playlist_title)s", album.title)
      .replace("%(playlist_count)s", String(album.entries.length))
      .replace("%(channel)s", album.channel)
      .replace("%(title)s", album.entries[0]?.title ?? album.title));
    process.exit(0);
  }
  if (video) {
    print(printFormat
      .replace("%(playlist_title)s", "NA")
      .replace("%(playlist_count)s", "NA")
      .replace("%(channel)s", video.channel)
      .replace("%(title)s", video.title));
    process.exit(0);
  }
  fail(`no fixture for ${url}`);
}

const home = (value("--paths") ?? "").replace(/^home:/, "");

if (has("--write-thumbnail")) {
  if (!home) fail("--write-thumbnail without --paths home:");
  const cover = album?.cover ?? video?.cover;
  if (cover) {
    mkdirSync(home, { recursive: true });
    copyFileSync(path.resolve(import.meta.dirname, cover), path.join(home, `cover${path.extname(cover)}`));
  }
  process.exit(0);
}

if (has("--extract-audio")) {
  pause("download");
  if (!home) fail("--extract-audio without --paths home:");
  mkdirSync(home, { recursive: true });
  if (video) {
    writeToneWav(path.join(home, `${video.title}.wav`), 523);
    print(`[ExtractAudio] Destination: ${video.title}.wav`);
    process.exit(0);
  }
  if (!album) fail(`no fixture for ${url}`);
  const wanted = parseItems(value("--playlist-items"), album.entries.length);
  for (const [index, entry] of album.entries.entries()) {
    const position = index + 1;
    if (!wanted.has(position) || entry.unavailable) continue;
    const name = `${String(position).padStart(3, "0")} - ${entry.title}.wav`;
    writeToneWav(path.join(home, name), 330 + position * 55);
    print(`[ExtractAudio] Destination: ${name}`);
  }
  process.exit(0);
}

fail(`unsupported invocation ${JSON.stringify(argv)}`);

function parseItems(spec, count) {
  const all = new Set(Array.from({ length: count }, (_, index) => index + 1));
  if (!spec) return all;
  const picked = new Set();
  for (const part of spec.split(",")) {
    const [from, to] = part.split("-").map(Number);
    for (let position = from; position <= (to || from); position += 1) picked.add(position);
  }
  return picked;
}

function writeToneWav(file, frequency) {
  const rate = 44_100;
  const frames = Math.round(1.5 * rate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000);
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}
