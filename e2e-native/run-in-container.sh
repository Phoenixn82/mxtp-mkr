#!/bin/sh
# Native Linux e2e, inside the compose `e2e` service (already dropped to the
# host UID by .docker/verify-entrypoint.sh). Started by scripts/e2e-native.sh.
#   $1          optional spec filter, matched as a basename prefix:
#               e2e-native/specs/<filter>*.spec.mjs ("lib-" runs only lib-*,
#               not audio-library). Only when no basename starts with it does
#               it fall back to a substring match (*<filter>*), e.g. "wp8".
#   E2E_REPEAT  run the selected specs N times in a row (default 1)
#   E2E_LIVE    1 = also run the specs guarded by it (real network)
set -eu

filter="${1:-}"
repeat="${E2E_REPEAT:-1}"
results=/workspace/test-results/e2e-native
bin_out=/workspace/test-results/e2e-native-bin

echo "e2e-native: filter='${filter}' E2E_REPEAT=${repeat} E2E_LIVE=${E2E_LIVE:-unset}"

pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store

# beforeBuildCommand (pnpm build = tsc + vite build) runs first; the frontend is
# embedded in the binary, so --no-bundle is all the tests need.
build_start=$(date +%s)
pnpm tauri build --no-bundle --ci
echo "e2e-native: release build took $(( $(date +%s) - build_start ))s"

# The target dir is a named volume; copy the one-file binary into the bind
# mount so the local runner can fetch it.
mkdir -p "$bin_out"
cp src-tauri/target/release/mxtp-mkr "$bin_out/mxtp-mkr"

rm -rf "$results"
mkdir -p "$results"

set -- e2e-native/specs/"$filter"*.spec.mjs
if [ ! -e "$1" ]; then
  set -- e2e-native/specs/*"$filter"*.spec.mjs
fi
if [ ! -e "$1" ]; then
  echo "e2e-native: no spec matches '$filter'" >&2
  exit 2
fi
echo "e2e-native: specs: $*"

run=1
while [ "$run" -le "$repeat" ]; do
  echo "e2e-native: run $run/$repeat"
  # dbus-run-session: GTK/WebKit expect a session bus. xvfb-run -a: a free
  # virtual display; 24-bit depth so screenshots carry real colour.
  dbus-run-session -- xvfb-run -a -s "-screen 0 1920x1080x24" \
    node --test --test-concurrency=1 \
      --test-reporter=spec --test-reporter-destination=stdout \
      --test-reporter=tap --test-reporter-destination="$results/results-$run.tap" "$@"
  run=$((run + 1))
done
