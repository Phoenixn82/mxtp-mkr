// Feature-gap probe: exercises the paths the e2e full-suite doesn't cover.
//  1. Booklet binding toggle Saddle -> Fold disables export with a reason
//  2. Page stepper clamps at the ends (4 and 28 for saddle)
//  3. Export cancel path surfaces "Export cancelled."
//  4. Bogus album lookup surfaces an inline research error
// Usage: node scripts/gap-probe-live.mjs  (app must be running with CDP 9333)
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`[gap] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
const deadline = Date.now() + 60_000;
while (!page && Date.now() < deadline) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
    }
  }
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) throw new Error("MXTP MKR page not found");

await page.reload();
await page.getByTestId("landing-screen").waitFor({ timeout: 20_000 });

// --- 4 first: bogus album error (before a valid research state exists) ---
await page.getByLabel("Artist").fill("zzzz-no-such-artist-zzzz");
await page.getByLabel("Album").fill("zzzz-no-such-album-zzzz");
await page.getByRole("button", { name: "Create" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 20_000 });
try {
  await page.getByTestId("research-error").waitFor({ timeout: 90_000 });
  const text = (await page.getByTestId("research-error").textContent()) ?? "";
  check("bogus album surfaces inline research error", text.includes("Album research failed"), text.slice(0, 90));
} catch {
  check("bogus album surfaces inline research error", false, "no research-error appeared in 90s");
}

// --- valid lookup for the booklet checks ---
await page.getByTestId("artist-input").fill("Radiohead");
await page.getByTestId("album-input").fill("In Rainbows");
await page.getByTestId("run-research").click();
const applied = page.getByTestId("research-applied");
const researchDeadline = Date.now() + 240_000;
while (Date.now() < researchDeadline) {
  const text = (await applied.textContent()) ?? "";
  if (text.includes("Radiohead - In Rainbows")) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
check(
  "manual lookup applies research",
  ((await applied.textContent()) ?? "").includes("Radiohead - In Rainbows")
);

// --- 2. stepper bounds (saddle: 4..28) ---
const pagesOut = page.getByTestId("booklet-pages");
for (let i = 0; i < 12; i += 1) await page.getByRole("button", { name: "Remove" }).click();
check("stepper clamps low at 4 pages", ((await pagesOut.textContent()) ?? "").includes("4 pages"));
for (let i = 0; i < 12; i += 1) await page.getByRole("button", { name: "Add" }).click();
check("stepper clamps high at 28 pages", ((await pagesOut.textContent()) ?? "").includes("28 pages"));
// 28 has no machine-readable template -> export disabled with reason
const exportBtn = page.getByTestId("export-booklet");
check("export disabled at 28 pages (no template)", await exportBtn.isDisabled());
// back to 16
for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Remove" }).click();
check("back to 16 pages", ((await pagesOut.textContent()) ?? "").includes("16 pages"));
check("export enabled at 16 pages", !(await exportBtn.isDisabled()));

// --- 1. binding toggle ---
await page.getByLabel("Booklet binding").selectOption("fold");
check("fold binding disables export", await exportBtn.isDisabled());
await page.getByLabel("Booklet binding").selectOption("saddle");
check("saddle re-enables export", !(await exportBtn.isDisabled()));

// --- 3. export cancel path (press Esc on the native dialog) ---
const canceller = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$wsh = New-Object -ComObject WScript.Shell",
  "$deadline = (Get-Date).AddSeconds(30)",
  "while ((Get-Date) -lt $deadline) {",
  "  if ($wsh.AppActivate('Save As')) { Start-Sleep -Milliseconds 600; [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); break }",
  "  Start-Sleep -Milliseconds 400",
  "}"
].join("\n")], { stdio: "ignore" });
await exportBtn.click();
const msgDeadline = Date.now() + 60_000;
let message = "";
while (Date.now() < msgDeadline) {
  message = (await page.getByTestId("export-message").textContent().catch(() => "")) ?? "";
  if (message.startsWith("Saved") || message.startsWith("Export failed")) break;
  await new Promise((resolve) => setTimeout(resolve, 800));
}
canceller.kill();
check("cancelled dialog surfaces 'Export cancelled.'", message.includes("Export cancelled"), message);

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`[gap] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
