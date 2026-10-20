// Live booklet probe: drives the REAL Tauri desktop app over CDP (port 9333).
// Prereq: app running via
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 pnpm tauri dev
// Usage: node scripts/verify-booklet-live.mjs [artist] [album] [targetPdfPath]
// A parallel PowerShell handles the native save dialog via SendKeys.
import { chromium } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

const artist = process.argv[2] ?? "Radiohead";
const album = process.argv[3] ?? "In Rainbows";
const target = process.argv[4] ?? path.join(os.tmpdir(), "booklet-CD1600R-v4.pdf");

function log(message) {
  console.log(`[probe] ${message}`);
}

async function connect() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9333");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("Timed out connecting to CDP 9333");
}

async function nativePage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.title()) === "MXTP MKR") {
          return page;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the MXTP MKR page over CDP");
}

function handleSaveDialog(path) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$wsh = New-Object -ComObject WScript.Shell",
    "$deadline = (Get-Date).AddSeconds(45)",
    "$activated = $false",
    "while ((Get-Date) -lt $deadline -and -not $activated) {",
    "  foreach ($t in @('Save As','Save')) {",
    "    if ($wsh.AppActivate($t)) { $activated = $true; break }",
    "  }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "if ($activated) {",
    "  Start-Sleep -Milliseconds 800",
    // PowerShell single-quoted string: backslashes pass through literally (SendKeys
    // only needs {}^%+~()[] escaped — a plain Windows path has none of those).
    `  [System.Windows.Forms.SendKeys]::SendWait('${path}')`,
    "  Start-Sleep -Milliseconds 400",
    "  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "  Write-Output DIALOG_HANDLED",
    "} else { Write-Output DIALOG_NOT_FOUND }"
  ].join("\n");
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (data) => log(`dialog-handler: ${String(data).trim()}`));
  return child;
}

const browser = await connect();
log("connected to native WebView2");
const page = await nativePage(browser);
log("found MXTP MKR page");

if (await page.getByTestId("landing-screen").isVisible().catch(() => false)) {
  await page.getByLabel("Artist").fill(artist);
  await page.getByLabel("Album").fill(album);
  await page.getByRole("button", { name: "Create" }).click();
  log(`submitted landing for ${artist} - ${album}`);
}
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });

// Auto-lookup runs on entry; wait for research to apply (cover mock + per-track lyrics).
const applied = page.getByTestId("research-applied");
const deadline = Date.now() + 240_000;
let appliedText = "";
while (Date.now() < deadline) {
  appliedText = (await applied.textContent()) ?? "";
  if (appliedText.includes(`${artist} - ${album}`)) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!appliedText.includes(`${artist} - ${album}`)) {
  const error = await page.getByTestId("research-error").textContent().catch(() => "");
  throw new Error(`research never applied; error line: ${error}`);
}
log(`research applied: ${appliedText.trim()}`);

const coverage = await page.getByTestId("lyrics-coverage").textContent().catch(() => "(no coverage line)");
log(`lyrics coverage: ${coverage}`);
const researchError = await page.getByTestId("research-error").textContent().catch(() => "");
if (researchError) {
  log(`research error line: ${researchError}`);
}

if (fs.existsSync(target)) {
  fs.rmSync(target);
}
const dialogHandler = handleSaveDialog(target);
await page.getByTestId("export-booklet").click();
log("clicked Export booklet PDF, waiting for save dialog + write");

const exportDeadline = Date.now() + 120_000;
let message = "";
while (Date.now() < exportDeadline) {
  message = (await page.getByTestId("export-message").textContent().catch(() => "")) ?? "";
  if (message.startsWith("Saved") || message.startsWith("Export failed")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
log(`export message: ${message || "(none)"}`);
dialogHandler.kill();

if (!message.startsWith("Saved")) {
  throw new Error(`export did not succeed: ${message}`);
}
if (!fs.existsSync(target)) {
  throw new Error(`export claimed success but ${target} is missing`);
}
log(`PDF written: ${target} (${fs.statSync(target).size} bytes)`);
await browser.close();
log("PROBE_OK");
