#!/usr/bin/env bash
# Local, staged Root onboarding. This tool never starts ZeroTier or publishes a
# World to a running service. The supplied local image must be operator-trusted.
set -Eeuo pipefail
umask 077

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WORK_DIR=
IMAGE_ID=

log() { printf '[root-manage] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
cleanup() {
    # Only a directory returned by this process's mktemp; never an input path.
    if [[ -n "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
}
trap cleanup EXIT

usage() {
    cat <<'EOF'
Usage:
  ./root-manage.sh prepare --image IMAGE --data-dir ABS --endpoint IP/PORT
                          [--endpoint IP/PORT ...]
  ./root-manage.sh add --image IMAGE --signer ABS --request FILE --output NEW
                      [--base-sha256 HASH] [--dry-run]

prepare creates one/identity.secret, one/identity.public and root-request.json
in a dedicated directory. A matching existing identity/request is reused.
add appends one public Root to the actual signer/planet, never removes existing
Roots, and generates a candidate (planet, roots.json, SHA256SUMS), not a release.

Both commands use an already-present image pinned to its immutable image ID.
No image pull, SSH, service start/restart, firewall change or activation occurs.
First-import trust, identity ownership and public UDP reachability need separate
verification. See docs/root-onboarding.md before publishing a candidate.
EOF
}

require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

path_without_symlinks() {
    local value=$1 resolved lexical
    [[ -n "$value" && "$value" != *','* && ! "$value" =~ [[:cntrl:]] ]] \
        || die 'Paths must not contain commas or control characters'
    resolved=$(realpath -m -- "$value")
    lexical=$(realpath -ms -- "$value")
    [[ "$resolved" == "$lexical" && ! -L "$value" ]] || die 'Symlinked paths are not allowed'
    printf '%s' "$resolved"
}

safe_state_directory() {
    local value=$1
    [[ "$value" == /* ]] || die 'State directories must use an absolute path'
    value=$(path_without_symlinks "$value")
    case "$value" in
        /|/root|/home|/srv|/tmp|/opt|/data|/var|/var/lib|/var/lib/zerotier-one|/var/lib/zerotier-one/*|/var/lib/ztncui|/var/lib/ztncui/*|/var/lib/docker|/var/lib/docker/*|/var/lib/containerd|/var/lib/containerd/*|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*)
            die 'Unsafe or existing system/client state directory'
            ;;
    esac
    [[ "$value" != "$ROOT_DIR" && "$value" != "$ROOT_DIR/"* && "$value" != "$HOME" ]] \
        || die 'Identity/signer state must be outside the repository and home root'
    printf '%s' "$value"
}

regular_file() {
    [[ -f "$1" && ! -L "$1" && $(stat -c %h -- "$1") == 1 ]] \
        || die 'Expected a regular, non-symlink, non-hardlinked file'
}

pin_image() {
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' -- "$1" 2>/dev/null) \
        || die 'Image is not present locally; build/load and verify it first (no pull attempted)'
    [[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Docker did not return one immutable local image ID'
}

normalize_endpoint() {
    python3 - "$1" <<'PY'
import ipaddress
import re
import sys
try:
    value = sys.argv[1]
    host, port = value.split('/')
    if '%' in host or not re.fullmatch(r'[0-9]{1,5}', port) or not 1 <= int(port) <= 65535:
        raise ValueError()
    address = ipaddress.ip_address(host)
    target = getattr(address, 'ipv4_mapped', None) or address
    if target.is_unspecified or target.is_multicast or target.is_loopback or str(target) == '255.255.255.255' or (address.version == 6 and (address.ipv4_mapped is not None or address.is_link_local)):
        raise ValueError()
    print(str(address) + '/' + str(int(port)))
except (ValueError, TypeError):
    sys.exit(1)
PY
}

normalize_endpoints() {
    local endpoint normalized list='[]'
    (($# >= 1 && $# <= 32)) || die 'A Root must have between 1 and 32 endpoints'
    for endpoint in "$@"; do
        normalized=$(normalize_endpoint "$endpoint") \
            || die 'Invalid endpoint; use literal unicast IP/port (1..65535), no wildcard, loopback, multicast, IPv6 link-local, IPv4-mapped IPv6 or zone'
        jq -e --arg value "$normalized" 'index($value) == null' <<<"$list" >/dev/null \
            || die 'Duplicate endpoint'
        list=$(jq -cn --argjson current "$list" --arg value "$normalized" '$current + [$value]')
    done
    printf '%s' "$list"
}

read_request() {
    local file=$1 identity endpoints
    local -a values=()
    regular_file "$file"
    [[ -s "$file" && $(stat -c %s -- "$file") -le 16384 ]] || die 'Root request is empty or too large'
    jq -e '
        type == "object" and (keys | sort) == ["identity", "schemaVersion", "stableEndpoints"]
        and .schemaVersion == 1
        and (.identity | type == "string" and test("^[0-9a-fA-F]{10}:0:[0-9a-fA-F]{128}$"))
        and (.stableEndpoints | type == "array" and length >= 1 and length <= 32 and all(.[]; type == "string"))
    ' "$file" >/dev/null 2>&1 || die 'Invalid public Root request schema/identity (private keys and extra fields are forbidden)'
    identity=$(jq -r '.identity | ascii_downcase' "$file")
    mapfile -t values < <(jq -r '.stableEndpoints[]' "$file")
    endpoints=$(normalize_endpoints "${values[@]}")
    jq -cn --arg identity "$identity" --argjson endpoints "$endpoints" \
        '{schemaVersion:1, identity:$identity, stableEndpoints:$endpoints}'
}

validate_prepared_directory() {
    local data=$1 file name
    [[ -d "$data" ]] || die 'Data path is not a directory'
    while IFS= read -r -d '' file; do
        name=${file##*/}
        case "$name" in
            one) [[ -d "$file" && ! -L "$file" ]] || die 'one must be a dedicated directory' ;;
            root-request.json) regular_file "$file" ;;
            *) die 'prepare accepts only a dedicated empty directory or previously prepared identity/request' ;;
        esac
    done < <(find "$data" -mindepth 1 -maxdepth 1 -print0)
    if [[ -d "$data/one" ]]; then
        while IFS= read -r -d '' file; do
            case "${file##*/}" in
                identity.secret|identity.public) regular_file "$file" ;;
                *) die 'Refusing client, Controller, signer or other existing ZeroTier state' ;;
            esac
        done < <(find "$data/one" -mindepth 1 -maxdepth 1 -print0)
    fi
}

prepare_root() {
    local data=$1 endpoint_json=$2 public request prior one
    data=$(safe_state_directory "$data")
    [[ ! -e "$data" || -d "$data" ]] || die 'Data path exists and is not a directory'
    if [[ -d "$data" ]]; then validate_prepared_directory "$data"; fi
    install -d -m 0700 -- "$data" "$data/one"
    # Lock the directory inode, without creating a lock file in node state.
    exec {prepare_lock}<"$data"
    flock --exclusive --wait 30 "$prepare_lock" || die 'Another prepare is using this directory'
    validate_prepared_directory "$data"
    one=$data/one
    if [[ -e "$one/identity.secret" || -e "$one/identity.public" ]]; then
        [[ -s "$one/identity.secret" && -s "$one/identity.public" ]] || die 'Incomplete identity; refusing to replace or regenerate it'
        [[ $(stat -c %a -- "$one/identity.secret") == 600 ]] || die 'Existing identity.secret must have mode 0600'
    else
        [[ ! -e "$data/root-request.json" ]] || die 'Existing request has no identity; refusing to generate a replacement'
        docker run --rm --pull never --network none --user "$(id -u):$(id -g)" \
            --entrypoint /bin/bash --mount "type=bind,src=$one,dst=/state" \
            "$IMAGE_ID" -euc 'umask 077; zerotier-idtool generate /state/identity.secret /state/identity.public >/dev/null' \
            >/dev/null 2>&1 || die 'Identity generation failed; inspect the dedicated directory before retrying'
    fi
    public=$(docker run --rm --pull never --network none --entrypoint /bin/bash \
        --mount "type=bind,src=$one,dst=/state,readonly" "$IMAGE_ID" -euc '
            zerotier-idtool validate /state/identity.secret >/dev/null
            zerotier-idtool validate /state/identity.public >/dev/null
            public=$(zerotier-idtool getpublic /state/identity.secret)
            test "$public" = "$(tr -d "\r\n" </state/identity.public)"
            printf "%s\n" "$public"
        ' 2>/dev/null) || die 'Existing/generated identity is invalid or public/secret files do not match'
    [[ "$public" =~ ^[0-9a-f]{10}:0:[0-9a-f]{128}$ ]] || die 'Identity tool did not return a public identity'
    request=$(jq -cn --arg identity "$public" --argjson endpoints "$endpoint_json" \
        '{schemaVersion:1, identity:$identity, stableEndpoints:$endpoints}')
    if [[ -e "$data/root-request.json" ]]; then
        prior=$(read_request "$data/root-request.json")
        [[ "$prior" == "$request" ]] || die 'Prepared request differs; refusing to overwrite it (review the public request separately)'
        log 'Existing matching identity and public request reused; nothing regenerated'
    else
        # noclobber protects an existing file appearing after the checks.
        (set -o noclobber; printf '%s\n' "$request" > "$data/root-request.json") \
            || die 'Request appeared concurrently; refusing to overwrite it'
        chmod 0644 "$data/root-request.json"
    fi
    log "Public request: $data/root-request.json"
    log "Root ID: ${public%%:*}; image: $IMAGE_ID; service not started"
    log 'This request is not proof of identity ownership or public UDP reachability'
}

planet_hash() { sha256sum -- "$1" | cut -d ' ' -f 1; }
signer_fingerprint() {
    sha256sum -- "$1/planet" "$1/previous.c25519" "$1/current.c25519" | sha256sum | cut -d ' ' -f 1
}
inspect_world() {
    docker run --rm --pull never --network none --entrypoint /usr/local/libexec/mkworld \
        --mount "type=bind,src=$1,dst=/input/planet,readonly" "$IMAGE_ID" --inspect /input/planet 2>/dev/null
}

run_bundle() (
    # planet-bundle.sh also resolves the pinned ID locally. Force no-pull for
    # its Docker run, including the rare race where that image is removed after
    # inspection. Do not change its implementation or expose this wrapper to UI.
    docker() {
        if [[ "${1:-}" == run ]]; then
            shift
            command docker run --pull never "$@"
        else
            command docker "$@"
        fi
    }
    export -f docker
    bash "$ROOT_DIR/planet-bundle.sh" "$@"
)

add_root() {
    local signer=$1 request_file=$2 output=$3 expected=$4 dry_run=$5
    local request identity id base_sha fingerprint metadata manifest file count normalized actual parent
    local -a endpoints=()
    signer=$(safe_state_directory "$signer")
    [[ -d "$signer" ]] || die 'Signer state directory does not exist'
    request_file=$(path_without_symlinks "$request_file")
    output=$(path_without_symlinks "$output")
    [[ ! -e "$output" && ! -L "$output" ]] || die 'Output must be a new directory'
    [[ "$output" != "$signer" && "$output" != "$signer/"* && "$signer" != "$output/"* ]] \
        || die 'Output must not overlap signer state'
    case "$output" in "$ROOT_DIR/.git"|"$ROOT_DIR/.git/"*|"$ROOT_DIR/.codex"|"$ROOT_DIR/.codex/"*|"$ROOT_DIR/.agents"|"$ROOT_DIR/.agents/"*) die 'Output cannot be a repository metadata directory' ;; esac
    parent=$(dirname -- "$output")
    [[ -d "$parent" ]] || die 'Output parent must already exist'
    request=$(read_request "$request_file")
    identity=$(jq -r .identity <<<"$request")
    id=${identity%%:*}
    exec {signer_lock}<"$signer"
    flock --exclusive --wait 30 "$signer_lock" || die 'Another add is using this signer'
    for file in planet previous.c25519 current.c25519; do
        regular_file "$signer/$file"
        [[ -s "$signer/$file" ]] || die 'Signer is missing its current World or signing keys'
    done
    base_sha=$(planet_hash "$signer/planet")
    [[ -z "$expected" || "$expected" == "$base_sha" ]] || die 'Base SHA-256 conflict; inspect the current World and retry'
    fingerprint=$(signer_fingerprint "$signer")
    # Keep candidate staging on the output filesystem for no-clobber rename.
    # No identity.secret or World private key is copied into this directory.
    WORK_DIR=$(mktemp -d "$parent/.root-manage.XXXXXXXX")
    cp -- "$signer/planet" "$WORK_DIR/base.planet"
    [[ $(planet_hash "$WORK_DIR/base.planet") == "$base_sha" ]] || die 'Base changed while taking a public snapshot'
    metadata=$(inspect_world "$WORK_DIR/base.planet") || die 'Current Planet is not a valid supported World'
    jq -e '.type == "planet" and .id == 149604618 and (.roots | type == "array" and length >= 1 and length <= 4)' \
        <<<"$metadata" >/dev/null || die 'Current Planet has unsupported metadata'
    jq -e --arg id "$id" 'all(.roots[]; (.identity | split(":")[0]) != $id)' <<<"$metadata" >/dev/null \
        || die "Root ID $id is already present; no candidate generated"
    count=$(jq '.roots | length' <<<"$metadata")
    ((count < 4)) || die 'This compatible Planet format supports at most 4 Roots'
    # Validate existing endpoints too, but never silently rewrite them.
    while IFS= read -r file; do
        normalize_endpoint "$file" >/dev/null || die 'Current World contains a disallowed endpoint; review it before adding a Root'
    done < <(jq -r '.roots[].stableEndpoints[]' <<<"$metadata")
    printf '%s\n' "$identity" > "$WORK_DIR/identity.public"
    docker run --rm --pull never --network none --entrypoint zerotier-idtool \
        --mount "type=bind,src=$WORK_DIR/identity.public,dst=/input/identity.public,readonly" \
        "$IMAGE_ID" validate /input/identity.public >/dev/null 2>&1 || die 'Requested Root identity failed cryptographic validation'
    manifest=$(jq --argjson request "$request" '{roots: (.roots + [{identity:$request.identity,stableEndpoints:$request.stableEndpoints}])}' <<<"$metadata")
    printf '%s\n' "$manifest" > "$WORK_DIR/roots.json"
    [[ $(signer_fingerprint "$signer") == "$fingerprint" ]] || die 'Signer changed while preparing; no candidate published'
    log "Base Planet SHA-256: $base_sha"
    log "Pinned image: $IMAGE_ID"
    jq --arg base "$base_sha" --arg id "$id" \
        '{baseSha256:$base,addedRoot:$id,roots:[.roots[]|{id:(.identity|split(":")[0]),stableEndpoints}]}' <<<"$manifest"
    if ((dry_run)); then
        log 'Dry run passed: existing Roots preserved; no signing, output bundle or activation'
        return
    fi
    run_bundle "$IMAGE_ID" "$signer" "$WORK_DIR/roots.json" "$WORK_DIR/candidate" \
        >"$WORK_DIR/bundle.log" 2>&1 || die 'Candidate signing failed; no output activated (diagnostic output suppressed to protect signing material)'
    [[ $(signer_fingerprint "$signer") == "$fingerprint" ]] || die 'Signer changed during signing; candidate discarded'
    [[ $(find "$WORK_DIR/candidate" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) == $'SHA256SUMS\nplanet\nroots.json' ]] \
        || die 'Candidate contains unexpected files'
    for file in planet roots.json SHA256SUMS; do regular_file "$WORK_DIR/candidate/$file"; done
    docker run --rm --pull never --network none --entrypoint /usr/local/libexec/mkworld \
        --mount "type=bind,src=$WORK_DIR,dst=/input,readonly" "$IMAGE_ID" \
        --verify-update /input/base.planet /input/candidate/planet >/dev/null 2>&1 \
        || die 'Candidate does not extend the original baseline signature chain'
    actual=$(inspect_world "$WORK_DIR/candidate/planet") || die 'Candidate cannot be inspected'
    normalized=$(jq -c '.roots | map({identity,stableEndpoints:(.stableEndpoints|sort)}) | sort_by(.identity)' <<<"$manifest")
    [[ $(jq -c '.roots | map({identity,stableEndpoints:(.stableEndpoints|sort)}) | sort_by(.identity)' <<<"$actual") == "$normalized" ]] \
        || die 'Candidate changed the requested Root set; refusing output'
    # planet-bundle writes inspected metadata (including its new timestamp) to
    # the public bundle; compare that file to the signed candidate, not the
    # input roots manifest used to generate it.
    # Quote both canonical JSON strings: an unquoted RHS in [[ ... == ... ]]
    # is a glob pattern, so the brackets in JSON could reject equal metadata.
    [[ "$(jq -Sc . <<<"$actual")" == "$(jq -Sc . "$WORK_DIR/candidate/roots.json")" ]] \
        || die 'Candidate metadata differs from the signed Planet'
    (cd "$WORK_DIR/candidate" && sha256sum -c SHA256SUMS >/dev/null 2>&1) || die 'Candidate checksums do not match'
    [[ $(signer_fingerprint "$signer") == "$fingerprint" ]] || die 'Signer changed before output; candidate discarded'
    mv -T --no-clobber -- "$WORK_DIR/candidate" "$output"
    [[ ! -e "$WORK_DIR/candidate" ]] || die 'Output appeared concurrently; refusing to overwrite it'
    log "Candidate created: $output/planet; SHA-256: $(planet_hash "$output/planet")"
    log 'Not activated. The signer head is unchanged; recheck the live baseline before a separately authorized rollout'
}

command=${1:-help}
[[ $# == 0 ]] || shift
case "$command" in help|-h|--help) usage; exit 0 ;; prepare|add) ;; *) usage >&2; exit 2 ;; esac
image= data_dir= signer= request_file= output= expected= dry_run=0
declare -a endpoint_values=()
while (($#)); do
    case "$1" in
        --image|--data-dir|--signer|--request|--output|--base-sha256|--endpoint)
            [[ $# -ge 2 && -n "$2" ]] || die "Missing value for $1"
            case "$1" in
                --image) [[ -z "$image" ]] || die 'Duplicate --image'; image=$2 ;;
                --data-dir) [[ -z "$data_dir" ]] || die 'Duplicate --data-dir'; data_dir=$2 ;;
                --signer) [[ -z "$signer" ]] || die 'Duplicate --signer'; signer=$2 ;;
                --request) [[ -z "$request_file" ]] || die 'Duplicate --request'; request_file=$2 ;;
                --output) [[ -z "$output" ]] || die 'Duplicate --output'; output=$2 ;;
                --base-sha256) [[ -z "$expected" ]] || die 'Duplicate --base-sha256'; expected=${2,,} ;;
                --endpoint) endpoint_values+=("$2") ;;
            esac
            shift 2
            ;;
        --dry-run) ((dry_run == 0)) || die 'Duplicate --dry-run'; dry_run=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die 'Unknown argument' ;;
    esac
done
for tool in docker jq python3 realpath stat flock sha256sum mktemp find; do require_command "$tool"; done
[[ -n "$image" && "$image" != -* && ! "$image" =~ [[:cntrl:]] ]] || die '--image must identify one trusted local image'
if [[ "$command" == prepare ]]; then
    [[ -n "$data_dir" && ${#endpoint_values[@]} -gt 0 && -z "$signer$request_file$output$expected" && "$dry_run" == 0 ]] \
        || die 'prepare requires --image, --data-dir and --endpoint only'
    endpoint_json=$(normalize_endpoints "${endpoint_values[@]}")
    pin_image "$image"
    prepare_root "$data_dir" "$endpoint_json"
else
    [[ -n "$signer" && -n "$request_file" && -n "$output" && -z "$data_dir" && ${#endpoint_values[@]} == 0 ]] \
        || die 'add requires --image, --signer, --request and --output'
    [[ -z "$expected" || "$expected" =~ ^[0-9a-f]{64}$ ]] || die '--base-sha256 must be a SHA-256 hex digest'
    pin_image "$image"
    add_root "$signer" "$request_file" "$output" "$expected" "$dry_run"
fi
