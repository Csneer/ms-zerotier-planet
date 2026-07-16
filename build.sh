#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

env_value() {
    local key=$1 fallback=${2:-} line value
    if [[ -f .env ]]; then
        line=$(grep -m1 -E "^${key}=" .env || true)
        if [[ -n "$line" ]]; then
            value=${line#*=}
            value=${value%$'\r'}
            if [[ "$value" == \"*\" && "$value" == *\" ]]; then
                value=${value:1:${#value}-2}
            elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
                value=${value:1:${#value}-2}
            fi
            printf '%s' "$value"
            return
        fi
    fi
    printf '%s' "$fallback"
}

ZT_VERSION="${ZT_VERSION:-$(env_value ZT_VERSION 1.16.2)}"
ZTNCUI_COMMIT="${ZTNCUI_COMMIT:-$(env_value ZTNCUI_COMMIT 1b2284864de48d2dcae22582fff122fe24909c3d)}"
MKWORLD_ZT_VERSION="${MKWORLD_ZT_VERSION:-$(env_value MKWORLD_ZT_VERSION 1.14.2)}"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-$(env_value DEBIAN_MIRROR mirrors.aliyun.com)}"
IMAGE="${IMAGE:-${ZT_IMAGE:-$(env_value ZT_IMAGE "zerotier-planet:${ZT_VERSION}-optimized")}}"
SOURCE_REPOSITORY="${SOURCE_REPOSITORY:-$(env_value SOURCE_REPOSITORY '')}"
if [[ -z "${SOURCE_REVISION:-}" ]]; then
    SOURCE_REVISION=$(git rev-parse HEAD 2>/dev/null || printf unknown)
    if [[ "$SOURCE_REVISION" != unknown ]] && [[ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
        SOURCE_REVISION="${SOURCE_REVISION}-dirty"
    fi
fi
PLATFORMS="${PLATFORMS:-}"

if [[ -n "$PLATFORMS" ]]; then
    args=(buildx build --platform "$PLATFORMS")
    if [[ "${PUSH:-0}" == 1 ]]; then
        args+=(--push)
    elif [[ "$PLATFORMS" == *,* ]]; then
        printf 'PUSH=1 is required for a multi-platform build\n' >&2
        exit 2
    else
        args+=(--load)
    fi
else
    args=(build)
fi

docker "${args[@]}" \
    --pull \
    --build-arg "ZT_VERSION=${ZT_VERSION}" \
    --build-arg "ZTNCUI_COMMIT=${ZTNCUI_COMMIT}" \
    --build-arg "MKWORLD_ZT_VERSION=${MKWORLD_ZT_VERSION}" \
    --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR}" \
    --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
    --build-arg "SOURCE_REVISION=${SOURCE_REVISION}" \
    --tag "$IMAGE" \
    .

printf 'Built %s with ZeroTier %s (revision %s)\n' "$IMAGE" "$ZT_VERSION" "$SOURCE_REVISION"
