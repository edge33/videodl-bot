#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo 'Run videodl-bot as a non-root user.' >&2
  exit 1
fi

if [ ! -d "$DOWNLOAD_DIR" ] || [ ! -w "$DOWNLOAD_DIR" ] || [ ! -x "$DOWNLOAD_DIR" ]; then
  echo 'Download path must be an existing writable directory. Check bind-mount ownership against APP_UID/APP_GID.' >&2
  exit 1
fi

exec "$@"
