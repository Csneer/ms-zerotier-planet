#!/bin/sh
set -eu

ZT_PORT="$(cat /app/config/zerotier-one.port)"
API_PORT="$(cat /app/config/ztncui.port)"
TOKEN="$(cat /var/lib/zerotier-one/authtoken.secret)"
API_HOST="${HTTP_HOST:-127.0.0.1}"

case "$API_HOST" in
    0.0.0.0|::) API_HOST=127.0.0.1 ;;
    *:*) API_HOST="[$API_HOST]" ;;
esac

curl -fsS --max-time 3 -H "X-ZT1-Auth: ${TOKEN}" "http://127.0.0.1:${ZT_PORT}/status" >/dev/null
if [ "${PLANET_MODE:-generated}" = external ]; then
    cmp -s /app/config/planet /var/lib/zerotier-one/planet
fi
[ "${ROOT_ONLY:-0}" != 1 ] || exit 0
curl -fsS --max-time 3 "http://${API_HOST}:${API_PORT}/healthz" >/dev/null
