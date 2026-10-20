#!/bin/sh
set -eu

host_uid="${LOCAL_UID:-1000}"
host_gid="${LOCAL_GID:-1000}"

case "$host_uid" in
  ''|*[!0-9]*)
    echo "LOCAL_UID must be numeric" >&2
    exit 2
    ;;
esac
case "$host_gid" in
  ''|*[!0-9]*)
    echo "LOCAL_GID must be numeric" >&2
    exit 2
    ;;
esac

prepare_owned_dir() {
  directory="$1"
  marker="$directory/.mxtp-owner-$host_uid-$host_gid"
  mkdir -p "$directory"
  if [ ! -f "$marker" ]; then
    chown -R "$host_uid:$host_gid" "$directory"
    : > "$marker"
    chown "$host_uid:$host_gid" "$marker"
  fi
}

# The project itself is bind-mounted. Run verification as the host user so
# Vite and other generators never leave root-owned files in the checkout.
prepare_owned_dir /workspace/node_modules
prepare_owned_dir /workspace/.pnpm-store
prepare_owned_dir /workspace/src-tauri/target
prepare_owned_dir /workspace/.cargo

if [ -d /workspace/dist ]; then
  chown -R "$host_uid:$host_gid" /workspace/dist
fi

runtime_home=/tmp/mxtp-mkr-home
mkdir -p "$runtime_home/.cache"
chown -R "$host_uid:$host_gid" "$runtime_home"

# Give the host UID a passwd entry. Without one, getpwuid() fails and
# dbus-daemon (used by the e2e service's dbus-run-session) refuses to start:
# "Could not get password database information for UID of current process".
if ! getent passwd "$host_uid" >/dev/null; then
  echo "mxtp:x:$host_uid:$host_gid:MXTP MKR container user:$runtime_home:/bin/sh" >> /etc/passwd
fi

run_as_host() {
  exec gosu "$host_uid:$host_gid" env \
  HOME="$runtime_home" \
  XDG_CACHE_HOME="$runtime_home/.cache" \
  COREPACK_HOME=/opt/corepack \
  CARGO_HOME=/workspace/.cargo \
  "$@"
}

if [ "$#" -gt 0 ]; then
  run_as_host "$@"
fi

run_as_host \
  sh -c \
  'pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store && pnpm verify'
