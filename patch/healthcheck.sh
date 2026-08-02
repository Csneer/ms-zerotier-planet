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
curl -fsS --max-time 3 "http://${API_HOST}:${API_PORT}/healthz" >/dev/null
