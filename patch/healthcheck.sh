#!/bin/sh
set -eu

ZT_PORT="$(cat /app/config/zerotier-one.port)"
API_PORT="$(cat /app/config/ztncui.port)"
TOKEN="$(cat /var/lib/zerotier-one/authtoken.secret)"
API_HOST="${HTTP_HOST:-127.0.0.1}"
PLANET_MODE="${PLANET_MODE:-generated}"
CONTROLLER_ONLY="${CONTROLLER_ONLY:-0}"
ROOT_ONLY="${ROOT_ONLY:-0}"
case "$PLANET_MODE" in generated|external) ;; *) exit 1 ;; esac
case "$CONTROLLER_ONLY:$ROOT_ONLY" in 0:0|0:1|1:0) ;; *) exit 1 ;; esac

case "$API_HOST" in
    0.0.0.0|::) API_HOST=127.0.0.1 ;;
    *:*) API_HOST="[$API_HOST]" ;;
esac

guard=/app/config/controller-standby.json
if [ "$CONTROLLER_ONLY" = 1 ] && [ ! -e "$guard" ] && [ ! -L "$guard" ]; then
    exit 1
fi
own_identity="$(zerotier-idtool getpublic /var/lib/zerotier-one/identity.secret)"
own_id="$(printf '%s\n' "$own_identity" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')"
if [ -e "$guard" ] || [ -L "$guard" ]; then
    [ -f "$guard" ] && [ ! -L "$guard" ] && [ "$CONTROLLER_ONLY" = 1 ] || exit 1
    jq -e --arg id "$own_id" '
        .schema == 1 and .state == "active" and .role == "controller-only"
        and (.controllerId | type == "string" and ascii_downcase == $id)
        and (.instanceId | type == "string" and test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"))
    ' "$guard" >/dev/null
fi
status="$(curl -fsS --max-time 3 -H "X-ZT1-Auth: ${TOKEN}" "http://127.0.0.1:${ZT_PORT}/status")"
metadata="$(/usr/local/libexec/mkworld --inspect /var/lib/zerotier-one/planet)"
cmp -s /app/dist/planet /var/lib/zerotier-one/planet
if [ "$PLANET_MODE" = external ]; then
    cmp -s /app/config/planet /var/lib/zerotier-one/planet
fi
printf '%s\n' "$status" | jq -e --arg id "$own_id" --argjson world "$metadata" '
    .address == $id and .planetWorldId == $world.id and .planetWorldTimestamp == $world.timestamp
' >/dev/null
if [ "$CONTROLLER_ONLY" = 1 ]; then
    [ "$ROOT_ONLY" = 0 ]
    [ "${PLANET_MODE:-generated}" = external ]
    for moon in /var/lib/zerotier-one/moons.d/*.moon; do
        [ ! -e "$moon" ] && [ ! -L "$moon" ] || exit 1
    done
    printf '%s\n' "$metadata" | jq -e --arg identity "$own_identity" '.roots | all(.identity != $identity)' >/dev/null
else
    printf '%s\n' "$metadata" | jq -e --arg identity "$own_identity" '.roots | any(.identity == $identity)' >/dev/null
fi
[ "$ROOT_ONLY" != 1 ] || exit 0
curl -fsS --max-time 3 "http://${API_HOST}:${API_PORT}/healthz" >/dev/null
