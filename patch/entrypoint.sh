#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ZEROTIER_PATH=/var/lib/zerotier-one
CONFIG_PATH=/app/config
DIST_PATH=/app/dist
ZTNCUI_PATH=/opt/ztncui/src
ZTNCUI_STATE=/var/lib/ztncui

log() { printf '[planet] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

validate_port() {
    local name="$1" value="$2"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
        die "${name} must be an integer between 1 and 65535"
    fi
}

valid_ipv4() {
    node -e 'process.exit(require("net").isIP(process.argv[1]) === 4 ? 0 : 1)' "$1" \
        >/dev/null 2>&1
}

valid_ipv6() {
    [[ "$1" == *:* && "$1" != *%* ]] || return 1
    node -e 'process.exit(require("net").isIP(process.argv[1]) === 6 ? 0 : 1)' "$1" \
        >/dev/null 2>&1
}

write_config() {
    local file="$1" value="$2"
    printf '%s\n' "$value" > "${CONFIG_PATH}/${file}"
    chmod 0600 "${CONFIG_PATH}/${file}"
}

read_config() {
    local file="$1"
    [[ -s "${CONFIG_PATH}/${file}" ]] || return 0
    tr -d '\r\n' < "${CONFIG_PATH}/${file}"
}

discover_ip() {
    local url="$1"
    curl -4fsS --connect-timeout 3 --max-time 8 "$url" 2>/dev/null | tr -d '\r\n' || true
}

generate_planet() {
    local reason=$1
    local endpoints='[]'
    [[ -z "$IP_ADDR4" ]] || endpoints="$(jq -cn --arg ip "$IP_ADDR4" --arg port "$ZT_PORT" '[($ip + "/" + $port)]')"
    if [[ -n "$IP_ADDR6" ]]; then
        endpoints="$(jq -cn --argjson current "$endpoints" --arg ip "$IP_ADDR6" --arg port "$ZT_PORT" '$current + [($ip + "/" + $port)]')"
    fi

    jq --argjson endpoints "$endpoints" '.roots[0].stableEndpoints = $endpoints' \
        "${ZEROTIER_PATH}/moon.json" > "${ZEROTIER_PATH}/moon.json.tmp"
    mv "${ZEROTIER_PATH}/moon.json.tmp" "${ZEROTIER_PATH}/moon.json"

    (cd "$ZEROTIER_PATH" && zerotier-idtool genmoon moon.json)
    mkdir -p "${ZEROTIER_PATH}/moons.d" "$DIST_PATH"
    rm -f "${ZEROTIER_PATH}/moons.d/"*.moon "${DIST_PATH}/"*.moon
    cp "${ZEROTIER_PATH}"/*.moon "${ZEROTIER_PATH}/moons.d/"
    # Newer deployments keep the last generated world beside mkworld. Older
    # layouts only persisted the distributed planet file, so preserve that as
    # the rollback copy during the first endpoint migration as well.
    if [[ -s "${ZEROTIER_PATH}/world.bin" ]]; then
        cp -p "${ZEROTIER_PATH}/world.bin" "${ZEROTIER_PATH}/world.bin.previous"
    elif [[ -s "${DIST_PATH}/planet" ]]; then
        cp -p "${DIST_PATH}/planet" "${ZEROTIER_PATH}/world.bin.previous"
    fi
    (cd "$ZEROTIER_PATH" && ./mkworld >/dev/null)
    install -m 0644 "${ZEROTIER_PATH}/world.bin" "${DIST_PATH}/planet"
    cp "${ZEROTIER_PATH}"/*.moon "$DIST_PATH/"
    write_config ip_addr4 "$IP_ADDR4"
    write_config ip_addr6 "$IP_ADDR6"
    log "Private planet generated (${reason}) with $(jq 'length' <<<"$endpoints") stable endpoint(s)"
}

activate_private_planet() {
    [[ -s "${DIST_PATH}/planet" ]] || die 'Generated private planet is missing'
    if [[ ! -s "${ZEROTIER_PATH}/planet" ]] \
      || ! cmp -s "${DIST_PATH}/planet" "${ZEROTIER_PATH}/planet"; then
        install -m 0644 "${DIST_PATH}/planet" "${ZEROTIER_PATH}/planet"
        log 'Activated the generated private planet for the local root service'
    fi
}

init_zerotier() {
    log 'Initializing ZeroTier identity and private planet'
    cp -an /bak/zerotier-one/. "${ZEROTIER_PATH}/"
    install -m 0755 /usr/local/libexec/mkworld "${ZEROTIER_PATH}/mkworld"

    # A package post-install hook may have created a throwaway build-time
    # identity. Never use it for a fresh persistent volume.
    rm -f "${ZEROTIER_PATH}/identity.secret" "${ZEROTIER_PATH}/identity.public"
    [[ -s "${ZEROTIER_PATH}/authtoken.secret" ]] || openssl rand -hex 16 > "${ZEROTIER_PATH}/authtoken.secret"
    chmod 0600 "${ZEROTIER_PATH}/authtoken.secret"
    zerotier-idtool generate "${ZEROTIER_PATH}/identity.secret" "${ZEROTIER_PATH}/identity.public"
    zerotier-idtool initmoon "${ZEROTIER_PATH}/identity.public" > "${ZEROTIER_PATH}/moon.json"
    generate_planet initial
}

init_ztncui_state() {
    if [[ ! -s "${ZTNCUI_STATE}/passwd" ]]; then
        log 'Initializing ztncui state'
        cp -a /bak/ztncui-state/. "$ZTNCUI_STATE/"
        cp "${ZTNCUI_STATE}/default.passwd" "${ZTNCUI_STATE}/passwd"
    fi
    mkdir -p "${ZTNCUI_STATE}/storage" "${ZTNCUI_STATE}/tls"
    chmod 0700 "$ZTNCUI_STATE" "${ZTNCUI_STATE}/storage" "${ZTNCUI_STATE}/tls"
    chmod 0600 "${ZTNCUI_STATE}/passwd"
}

shutdown() {
    trap - INT TERM EXIT
    log 'Stopping services'
    for pid in "${UI_PID:-}" "${ZT_PID:-}"; do
        [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap shutdown INT TERM EXIT

mkdir -p "$ZEROTIER_PATH" "$CONFIG_PATH" "$DIST_PATH" "$ZTNCUI_STATE"
PREVIOUS_ZT_PORT="$(read_config zerotier-one.port)"
PREVIOUS_IP_ADDR4="$(read_config ip_addr4)"
PREVIOUS_IP_ADDR6="$(read_config ip_addr6)"
ZT_PORT="${ZT_PORT:-${PREVIOUS_ZT_PORT:-9994}}"
API_PORT="${API_PORT:-$(read_config ztncui.port)}"
API_PORT="${API_PORT:-3443}"
validate_port ZT_PORT "$ZT_PORT"
validate_port API_PORT "$API_PORT"
write_config zerotier-one.port "$ZT_PORT"
write_config ztncui.port "$API_PORT"

IP_ADDR4="${IP_ADDR4:-${PREVIOUS_IP_ADDR4:-$(discover_ip https://ipv4.icanhazip.com/)}}"
if [[ -z "${IP_ADDR6+x}" ]]; then
    IP_ADDR6="$PREVIOUS_IP_ADDR6"
fi
[[ -n "$IP_ADDR4" || -n "$IP_ADDR6" ]] || die 'No public IPv4 or IPv6 address is available; set IP_ADDR4/IP_ADDR6 explicitly'
[[ -z "$IP_ADDR4" ]] || valid_ipv4 "$IP_ADDR4" || die "IP_ADDR4 is invalid: $IP_ADDR4"
[[ -z "$IP_ADDR6" ]] || valid_ipv6 "$IP_ADDR6" || die "IP_ADDR6 is invalid: $IP_ADDR6"

FRESH_IDENTITY=0
if [[ ! -s "${ZEROTIER_PATH}/identity.secret" ]]; then
    FRESH_IDENTITY=1
    init_zerotier
fi
install -m 0755 /usr/local/libexec/mkworld "${ZEROTIER_PATH}/mkworld"
chmod 0600 "${ZEROTIER_PATH}/authtoken.secret" "${ZEROTIER_PATH}/identity.secret"
chmod 0600 "${ZEROTIER_PATH}"/*.c25519 2>/dev/null || true
if ((FRESH_IDENTITY == 0)) && [[ ! -s "${DIST_PATH}/planet" \
      || "$PREVIOUS_IP_ADDR4" != "$IP_ADDR4" \
      || "$PREVIOUS_IP_ADDR6" != "$IP_ADDR6" \
      || "$PREVIOUS_ZT_PORT" != "$ZT_PORT" ]]; then
    [[ -s "${ZEROTIER_PATH}/moon.json" ]] || zerotier-idtool initmoon "${ZEROTIER_PATH}/identity.public" > "${ZEROTIER_PATH}/moon.json"
    generate_planet endpoint-change
fi
activate_private_planet

# Host networking avoids Docker's userland proxy/NAT on the hot UDP path. Do
# not let a planet accidentally select Docker or ZeroTier virtual interfaces
# as physical underlay paths. Existing operator-supplied local.conf wins.
if [[ ! -e "${ZEROTIER_PATH}/local.conf" && "${AUTO_TUNE_LOCAL_CONF:-1}" == 1 ]]; then
    jq -n --argjson port "$ZT_PORT" '{settings:{
        primaryPort:$port,
        portMappingEnabled:false,
        softwareUpdate:"disable",
        interfacePrefixBlacklist:["zt","docker","br-","veth"],
        enableMetrics:true
    }}' > "${ZEROTIER_PATH}/local.conf"
    chmod 0600 "${ZEROTIER_PATH}/local.conf"
elif [[ "${AUTO_TUNE_LOCAL_CONF:-1}" == 1 ]]; then
    jq --argjson port "$ZT_PORT" '
        .settings = (.settings // {})
        | .settings.primaryPort = $port
        | .settings.portMappingEnabled = false
        | .settings.softwareUpdate = "disable"
        | .settings.enableMetrics = true
        | .settings.interfacePrefixBlacklist =
            (((.settings.interfacePrefixBlacklist // []) + ["zt","docker","br-","veth"]) | unique)
    ' \
        "${ZEROTIER_PATH}/local.conf" > "${ZEROTIER_PATH}/local.conf.tmp"
    mv "${ZEROTIER_PATH}/local.conf.tmp" "${ZEROTIER_PATH}/local.conf"
    chmod 0600 "${ZEROTIER_PATH}/local.conf"
fi
init_ztncui_state

TOKEN="$(cat "${ZEROTIER_PATH}/authtoken.secret")"
if [[ ! -s "${CONFIG_PATH}/session.secret" ]]; then
    openssl rand -hex 32 > "${CONFIG_PATH}/session.secret"
fi
chmod 0600 "${CONFIG_PATH}/session.secret"

cat > "${ZTNCUI_PATH}/.env" <<EOF
HTTP_PORT=${API_PORT}
HTTP_HOST=${HTTP_HOST:-127.0.0.1}
NODE_ENV=production
ZT_ADDR=http://127.0.0.1:${ZT_PORT}
ZT_TOKEN=${TOKEN}
SESSION_SECRET=$(cat "${CONFIG_PATH}/session.secret")
DEFAULT_NETWORK_MTU=${DEFAULT_NETWORK_MTU:-1280}
ZT_PROBE_ADDR=${ZT_PROBE_ADDR:-http://127.0.0.1:9993}
ZT_PROBE_TOKEN_FILE=${ZT_PROBE_TOKEN_FILE:-/run/zerotier-probe/authtoken.secret}
EOF
chmod 0600 "${ZTNCUI_PATH}/.env"

log "Starting ZeroTier $(zerotier-one -v) on UDP/TCP ${ZT_PORT}"
zerotier-one -p"${ZT_PORT}" "$ZEROTIER_PATH" &
ZT_PID=$!

for _ in {1..30}; do
    if curl -fsS --max-time 1 -H "X-ZT1-Auth: ${TOKEN}" "http://127.0.0.1:${ZT_PORT}/status" >/dev/null 2>&1; then
        break
    fi
    kill -0 "$ZT_PID" 2>/dev/null || die 'ZeroTier exited during startup'
    sleep 1
done
curl -fsS --max-time 2 -H "X-ZT1-Auth: ${TOKEN}" "http://127.0.0.1:${ZT_PORT}/status" >/dev/null \
    || die 'ZeroTier management API did not become ready'

(cd "$ZTNCUI_PATH" && exec node ./bin/www) &
UI_PID=$!
log "Services ready: controller=${API_PORT}/tcp default-mtu=${DEFAULT_NETWORK_MTU:-1280}"

wait -n "$ZT_PID" "$UI_PID"
die 'A managed service exited unexpectedly'
