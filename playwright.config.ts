import { defineConfig, devices } from "@playwright/test";

const isWindows = process.platform === "win32";

const headedUse = {
  ...devices["Desktop Chrome"],
  baseURL: "http://127.0.0.1:5173",
  headless: false,
  slowMo: 200,
  launchOptions: { slowMo: 200 },
  actionTimeout: 15_000,
  screenshot: "on",
  video: "retain-on-failure",
  trace: "retain-on-failure"
};

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts"],
  // Per-track lyric fetches (26 real lookups across the two research albums)
  // legitimately grew the suite past the old 5-minute cap.
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: headedUse as never,
  webServer: {
    // Windows can prove the real Tauri/WebView2 shell over CDP. Linux Tauri
    // uses webkit2gtk, which has no CDP endpoint, so Linux runs the explicitly
    // mocked browser specs against Vite and skips the Windows-native spec.
    command: isWindows
      ? "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$env:PATH=\\\"$env:USERPROFILE\\\\.cargo\\\\bin;$env:PATH\\\"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=\\\"--remote-debugging-port=9333\\\"; $env:WEBVIEW2_USER_DATA_FOLDER=\\\"$PWD\\\\.webview2-e2e\\\"; $env:MXTP_MKR_IMAGEGEN=\\\"mock\\\"; pnpm tauri dev\""
      : "pnpm dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 180_000
  }
});
