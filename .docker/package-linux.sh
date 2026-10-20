#!/bin/sh
set -eu

pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store

# Tauri's cached linuxdeploy helper predates newer rolling-release ELF and
# gdk-pixbuf layouts. Build portable Linux artifacts in the pinned Debian
# environment that defines the project's supported packaging toolchain.
APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 pnpm tauri build --ci

artifact_dir=/workspace/artifacts/linux
mkdir -p "$artifact_dir"

deb_path=$(find /workspace/src-tauri/target/release/bundle/deb -maxdepth 1 -type f -name '*.deb' -print -quit)
appimage_path=$(find /workspace/src-tauri/target/release/bundle/appimage -maxdepth 1 -type f -name '*.AppImage' -print -quit)

if [ -z "$deb_path" ] || [ -z "$appimage_path" ]; then
  echo "Linux bundle build did not produce both .deb and .AppImage artifacts" >&2
  exit 1
fi

cp "$deb_path" "$artifact_dir/"
cp "$appimage_path" "$artifact_dir/"
sha256sum "$artifact_dir/$(basename "$deb_path")" "$artifact_dir/$(basename "$appimage_path")"
