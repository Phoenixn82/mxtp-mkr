// One-shot: click Export booklet PDF in the already-researched live app and
// commit the native save dialog. Assumes verify-booklet-live.mjs already ran
// the lookup (or the app otherwise sits on the detail view with research applied).
import { chromium } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

const target = process.argv[2] ?? path.join(os.tmpdir(), "booklet-CD1600R-v4.pdf");

function log(message) {
  console.log(`[export] ${message}`);
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

if (fs.existsSync(target)) {
  fs.rmSync(target);
}
const dialogHandler = handleSaveDialog(target);
await page.getByTestId("export-booklet").click();
log("clicked Export booklet PDF");

const deadline = Date.now() + 120_000;
let message = "";
while (Date.now() < deadline) {
  message = (await page.getByTestId("export-message").textContent().catch(() => "")) ?? "";
  if (message.startsWith("Saved") || message.startsWith("Export failed")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
log(`export message: ${message || "(none)"}`);
dialogHandler.kill();
if (!message.startsWith("Saved") || !fs.existsSync(target)) {
  throw new Error(`export did not land: message="${message}" fileExists=${fs.existsSync(target)}`);
}
log(`PDF written: ${target} (${fs.statSync(target).size} bytes)`);
await browser.close();
log("EXPORT_OK");
