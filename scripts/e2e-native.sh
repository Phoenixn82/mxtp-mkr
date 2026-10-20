#!/usr/bin/env bash
# Native Linux e2e from a workstation: mirror the tree to a Docker build host
# (E2E_HOST, its ssh name), build the release binary
# and drive the real WebKitGTK app there in Docker, then bring results home.
# Nothing heavy runs on the local machine.
#   scripts/e2e-native.sh [spec-filter]      e.g. scripts/e2e-native.sh lib-
#                                            (basename prefix; see run-in-container.sh)
#   E2E_REPEAT=3 scripts/e2e-native.sh       run the specs 3 times in a row
#   E2E_LIVE=1 scripts/e2e-native.sh art-    also run the real-network specs
#   E2E_SLOT=lib scripts/e2e-native.sh lib   parallel runs: own remote dir, compose
#                                            volumes, local results dir and log
#                                            folder per slot
# Every run's output is also written to
#   test-results/e2e-native-logs/<slot|default>/<UTC time>.log
#   E2E_CMD='pnpm test' scripts/e2e-native.sh    run any command in the verify
#                                            container on the build host instead of the e2e specs
set -euo pipefail

host="${E2E_HOST:?set E2E_HOST to the ssh host of your Docker build machine}"
slot="${E2E_SLOT:+-$E2E_SLOT}"
# Relative to the remote home. Compose names its volumes after this dir.
remote_dir="${E2E_REMOTE_DIR:-build/mxtp-mkr}$slot"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin_dest="$HOME/.cache/mxtp-e2e/mxtp-mkr"

log_dir="$root/test-results/e2e-native-logs/${E2E_SLOT:-default}"
mkdir -p "$log_dir"
log="$log_dir/$(date -u +%Y%m%dT%H%M%SZ).log"
# Keep a copy of everything this script prints in the per-slot log.
exec > >(tee -a "$log") 2>&1
echo "e2e-native: host=$host slot=${E2E_SLOT:-default} filter='${1:-}' E2E_REPEAT=${E2E_REPEAT:-1} E2E_LIVE=${E2E_LIVE:-unset} E2E_CMD=${E2E_CMD:+set}"

if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$host" true 2>/dev/null; then
  # E2E_WAKE: optional local command that wakes a suspended build host.
  if [ -n "${E2E_WAKE:-}" ]; then $E2E_WAKE; fi
fi

ssh "$host" "mkdir -p $remote_dir"
# .gitignore filtering keeps local junk (audit scratch, template payloads,
# exports, logs) off the build host; the explicit list is the build/test output.
rsync -a --delete \
  --filter=':- .gitignore' \
  --exclude=.git --exclude=node_modules --exclude=src-tauri/target \
  --exclude=dist --exclude=test-results --exclude=coverage \
  "$root/" "$host:$remote_dir/"

status=0
if [ -n "${E2E_CMD:-}" ]; then
  ssh "$host" "cd $remote_dir && nice -n 10 docker compose build verify >/dev/null && \
    nice -n 10 docker compose run --rm verify sh -c $(printf '%q' "pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store >/dev/null && $E2E_CMD")" || status=$?
  exit "$status"
fi
ssh "$host" "cd $remote_dir && nice -n 10 docker compose build e2e && \
  E2E_REPEAT=$(printf '%q' "${E2E_REPEAT:-1}") E2E_LIVE=$(printf '%q' "${E2E_LIVE:-}") \
  nice -n 10 docker compose run --rm -e E2E_REPEAT -e E2E_LIVE e2e \
  sh e2e-native/run-in-container.sh $(printf '%q' "${1:-}")" || status=$?

results="$root/test-results/e2e-native$slot"
mkdir -p "$results" "$(dirname "$bin_dest")"
rsync -a --delete "$host:$remote_dir/test-results/e2e-native/" "$results/" || true
[ -z "$slot" ] && { rsync -a "$host:$remote_dir/test-results/e2e-native-bin/mxtp-mkr" "$bin_dest" || true; }

echo "e2e-native: results in $results, log $log, binary at $bin_dest (a Docker build of the release app)"
exit "$status"
