#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

printf '%s\n' \
    'deploy.sh is kept only as a compatibility entry point.' \
    'Use ./install.sh for the first installation or ./manage.sh for maintenance.' >&2

if (($# == 0)); then
    exec "$ROOT_DIR/manage.sh" help
fi

exec "$ROOT_DIR/manage.sh" "$@"
