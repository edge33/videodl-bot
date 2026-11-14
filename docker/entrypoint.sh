#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo 'Run videodl-bot as a non-root user.' >&2
  exit 1
fi

for directory in "$DOWNLOAD_DIR" "$STATE_DIR"; do
  if [ ! -d "$directory" ] || [ ! -w "$directory" ] || [ ! -x "$directory" ]; then
    echo 'Storage paths must be existing writable directories. Check bind-mount ownership against APP_UID/APP_GID.' >&2
    exit 1
  fi
done

exec "$@"
