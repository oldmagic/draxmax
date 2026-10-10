#!/bin/sh
# Started with `--user` / compose `user:` (the default docker-compose.yml): already
# unprivileged, so this only checks the folders and starts the app.
# Started as root: runs as root only long enough to match the `node` user to the configured
# ids and make the mounted volumes writable, then drops privileges.
set -eu

CONFIG_DIR="${CONFIG_PATH:-/config}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"

  # Settings → Downloads → "Run as" (resolved to numeric ids by the app) overrides PUID/PGID.
  if [ -f "$CONFIG_DIR/settings.json" ]; then
    ids="$(node -e '
      try {
        const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (Number.isInteger(s.runAsUid)) console.log(s.runAsUid + " " + (Number.isInteger(s.runAsGid) ? s.runAsGid : s.runAsUid));
      } catch {}
    ' "$CONFIG_DIR/settings.json")"
    if [ -n "$ids" ]; then
      PUID="${ids% *}"
      PGID="${ids#* }"
      echo "entrypoint: running as $PUID:$PGID (from Settings)"
    fi
  fi

  if [ "$(id -g node)" != "$PGID" ]; then groupmod -o -g "$PGID" node; fi
  if [ "$(id -u node)" != "$PUID" ]; then usermod -o -u "$PUID" node; fi

  # Config is small: fix it recursively. For data dirs only the top level is touched on
  # every start; when the ids change, existing downloads are re-owned once.
  # Only the image's own volumes are re-owned. A DOWNLOAD_PATH elsewhere (e.g. host drives
  # mounted at /media) is a host folder: its ownership is never changed.
  chown -R node:node "$CONFIG_DIR"
  owner_file="$CONFIG_DIR/.owner"
  previous="$(cat "$owner_file" 2>/dev/null || true)"
  for dir in /downloads /watch; do
    [ -d "$dir" ] || continue
    if [ -n "$previous" ] && [ "$previous" != "$PUID:$PGID" ]; then
      echo "entrypoint: ids changed ($previous -> $PUID:$PGID), re-owning $dir"
      chown -R node:node "$dir"
    else
      chown node:node "$dir"
    fi
  done
  echo "$PUID:$PGID" > "$owner_file"
  chown node:node "$owner_file"

  download_dir="${DOWNLOAD_PATH:-/downloads}"
  if ! setpriv --reuid=node --regid=node --init-groups test -w "$download_dir"; then
    echo "entrypoint: warning: $download_dir is not writable by $PUID:$PGID"
  fi

  export DRAXMAX_IDENTITY_MANAGED=1
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

for dir in "$CONFIG_DIR" "${DOWNLOAD_PATH:-/downloads}"; do
  if [ ! -w "$dir" ]; then
    echo "entrypoint: warning: $dir is not writable by $(id -u):$(id -g)"
  fi
done
exec "$@"
