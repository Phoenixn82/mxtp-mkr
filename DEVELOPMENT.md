# MXTP MKR development

MXTP MKR has one React/Tauri/Rust source tree. Platform-specific behavior belongs in native adapters and Tauri platform configuration, not in separate copies of the application.

## Pinned toolchain

- Node.js 24.20.0 (`.node-version`)
- pnpm 11.25.0 (`package.json#packageManager`)
- Rust 1.98.0 with rustfmt and clippy (`rust-toolchain.toml`)

Run the platform-neutral verification suite on the host with:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Docker verification

Docker supplies a repeatable Linux environment for the production frontend
build, worktree-clean frontend tests, the Python playlist sidecar, Rust
formatting, strict Clippy lints, and every non-ignored Rust test:

```sh
docker compose run --rm verify
```

The source tree is bind-mounted and dependency/build caches live in named volumes, so edits are verified without copying or forking the project. Rebuild the image after a toolchain or system-package change:

```sh
docker compose build verify
```

The container drops to the host UID/GID before running any build command. On
Linux this prevents Docker verification from leaving root-owned `dist/` or
other generated files in the checkout. Set `LOCAL_UID` and `LOCAL_GID` only
when the checkout belongs to a user other than UID/GID 1000.

Docker does **not** replace native desktop validation. It cannot prove WebView behavior on Windows/macOS, read a host Apple Music database, or safely own a physical optical drive. The GitHub Actions matrix compiles and tests the same source on Linux, Windows, and macOS; release candidates still require native UI, media-library, and physical-burn checks on the target OS and hardware.

## Linux release packages

Build both the Debian package and AppImage inside the same pinned Debian
environment used for verification:

```sh
pnpm package:linux
```

The finished artifacts and SHA-256 checksums are written under
`artifacts/linux/`. Packaging is intentionally containerized: Tauri's bundled
`linuxdeploy` helpers are older than the ELF and gdk-pixbuf layouts shipped by
some rolling Linux distributions, even though the compiled application itself
runs correctly there.

## End-to-end verification

Install the Playwright Chromium runtime once, then run every E2E spec:

```sh
pnpm exec playwright install chromium
pnpm e2e
```

On Windows, `e2e/full-suite.spec.ts` attaches to the real Tauri/WebView2 shell
and proves the complete authoring, research, artwork, PDF, and simulated-burn
journey. Linux WebKitGTK does not expose that CDP endpoint, so Linux skips only
that Windows-native spec, runs the headed browser interaction spec, and must be
paired with a direct Tauri cold-launch/map/input/close smoke test.

Repeated `tauri dev` watcher restarts can expose an upstream WebKitGTK/NVIDIA
driver teardown crash after the app window has already closed. Validate Linux
release candidates with direct cold launches of the release binary; those
launch/map/input/close cycles are the relevant application signal and do not
exercise the watcher teardown path.

## Native Linux e2e

`e2e-native/` drives the real release binary (WebKitGTK webview, frontend
embedded) through `tauri-driver` 2.1.0 and `WebKitWebDriver` under Xvfb, with
Node's `node:test` and `selenium-webdriver`. It runs on the build host in the
compose `e2e` service (the `verify` image plus driver, Xvfb, D-Bus, fonts and
Mesa's software rasterizer for WebGL); every launch gets a fresh temp
`HOME`/`XDG_*` and `MXTP_MKR_IMAGEGEN=mock`. From the laptop:

```sh
pnpm e2e:native-linux              # every spec
pnpm e2e:native-linux smoke        # specs matching e2e-native/specs/*smoke*.spec.mjs
E2E_REPEAT=3 pnpm e2e:native-linux smoke
```

`scripts/e2e-native.sh` mirrors the tree to `$E2E_HOST:~/build/mxtp-mkr`
(set `E2E_HOST` to your Docker build host's ssh name, `E2E_REMOTE_DIR` to
change the folder and `E2E_WAKE` to a command that wakes it; git-ignored files
excluded), builds the
release binary with `pnpm tauri build --no-bundle` in Docker, runs the specs,
and copies screenshots plus `tauri-driver.log` back to `test-results/e2e-native/`
and the binary to `~/.cache/mxtp-e2e/mxtp-mkr`. On the build host directly:
`docker compose run --rm e2e [sh e2e-native/run-in-container.sh <filter>]`.

Specs get `launchApp`, `waitForReady`, `installErrorCollector`/`pageErrors`,
`setWindowSize` (`SIZES.desktop` 1440x950, `SIZES.narrow` 420x900), `setTheme`
(`light` = MXTP, `dark` = Y2K) and `screenshot` from `e2e-native/helpers.mjs`.
Each run also writes `results-<repeat>.tap` beside the screenshots, with per-test
assertion details as tests finish.

WebGL renders through Mesa's software driver, so it is slower than a GPU and
WebKit reports its renderer as a generic string; native file dialogs and real
network services are not exercised.

## macOS capability boundary

The macOS build uses `src-tauri/tauri.macos.conf.json` and the same React/Rust source as Linux and Windows. It checks the Music app's current default library package first, then the legacy Apple Music package location; a custom library can still be selected by its `Library.musicdb` path.

YouTube import on macOS uses the bundled `playlist_fetch.py` adapter. Until the release bundle carries its own signed universal toolchain, `python3`, `yt-dlp`, and `ffmpeg` must be executable from `PATH` (including the standard Homebrew locations), or their paths must be provided with `MXTP_PYTHON_PATH`, `MXTP_YTDLP_PATH`, and `MXTP_FFMPEG_PATH`. A missing dependency fails before the download with a named remediation instead of attempting a Windows executable.

Physical audio-CD writing is deliberately unavailable in the current macOS build. Apple provides the [Disc Recording framework](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/OSX_Technology_Overview/SystemFrameworks/SystemFrameworks.html), but MXTP MKR does not claim macOS burn support until a native Disc Recording implementation, CD-Text behavior, drive discovery, media validation, and a real write/eject cycle have passed on a Mac with an optical writer. Docker and cross-compilation cannot satisfy that acceptance gate.
