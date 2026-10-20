import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("native bundle sidecars", () => {
  it("ships ffmpeg and ffprobe as Windows-only Tauri external binaries", () => {
    const root = process.cwd();
    const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    const windowsConfig = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.windows.conf.json"), "utf8")
    );
    expect(windowsConfig.bundle.externalBin).toEqual(["binaries/ffmpeg", "binaries/ffprobe"]);
    expect(windowsConfig.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    const installerHooks = fs.readFileSync(path.join(root, "src-tauri", "windows", "hooks.nsh"), "utf8");
    expect(installerHooks).toContain("Mixtape Maker (MXTP MKR).lnk");
    expect(installerHooks).toContain("NSIS_HOOK_PREUNINSTALL");
    // $APPLOCALDATA (not $LOCALDATA) because the Rust side resolves app data via
    // app.path().app_local_data_dir(), which is $LOCALDATA/<bundle identifier> -
    // the asset-protocol scope has to match where the app actually writes.
    expect(config.app.security.assetProtocol).toEqual({
      enable: true,
      scope: [
        "$APPLOCALDATA/MXTP MKR/**/*",
        "$HOME/Music/Music/Music Library.musiclibrary/artwork/**/*",
        "$HOME/Music/Apple Music/Apple Music Library.musiclibrary/artwork/**/*",
        "$TEMP/mxtp_mkr_covers/**/*",
        "$TEMP/mxtp_mkr_imagegen/**/*",
      ],
    });

    // The Windows sidecar binaries are not committed; Windows builders drop them into
    // src-tauri/binaries/ (see README). Only check their presence on Windows.
    if (process.platform !== "win32") return;
    for (const tool of ["ffmpeg", "ffprobe"]) {
      expect(fs.statSync(path.join(root, "src-tauri", "binaries", `${tool}.exe`)).size).toBeGreaterThan(1_000_000);
      expect(
        fs.statSync(path.join(root, "src-tauri", "binaries", `${tool}-x86_64-pc-windows-msvc.exe`)).size
      ).toBeGreaterThan(1_000_000);
    }
  });

  it("bundles deb + appimage targets on Linux, nsis + msi on Windows", () => {
    const root = process.cwd();
    const linuxConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.linux.conf.json"), "utf8"));
    const windowsConfig = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.windows.conf.json"), "utf8")
    );
    expect(linuxConfig.bundle.targets).toEqual(["deb", "appimage"]);
    expect(linuxConfig.bundle.linux.deb.depends).toEqual(expect.arrayContaining([
      "ffmpeg", "python3", "yt-dlp", "cdrskin", "libcdio-utils"
    ]));
    expect(windowsConfig.bundle.targets).toEqual(["nsis", "msi"]);
  });
});
