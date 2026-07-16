#!/bin/sh
set -eu

ZT_PORT="$(cat /app/config/zerotier-one.port)"
API_PORT="$(cat /app/config/ztncui.port)"
FILE_PORT="$(cat /app/config/file_server.port)"
TOKEN="$(cat /var/lib/zerotier-one/authtoken.secret)"

curl -fsS --max-time 3 -H "X-ZT1-Auth: ${TOKEN}" "http://127.0.0.1:${ZT_PORT}/status" >/dev/null
curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/healthz" >/dev/null
curl -fsS --max-time 3 "http://127.0.0.1:${FILE_PORT}/healthz" >/dev/null
