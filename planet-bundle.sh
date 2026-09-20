#!/usr/bin/env bash
# Produce a signed candidate without changing a running root or its keys.
set -Eeuo pipefail
umask 077

if [[ $# != 4 ]]; then
    printf 'Usage: %s IMAGE SIGNER_STATE ROOTS_JSON NEW_OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi
image=$1
signer=$(realpath -e -- "$2")
roots=$(realpath -e -- "$3")
output=$(realpath -m -- "$4")
[[ -d "$signer" && -f "$roots" ]] || { printf 'Invalid input paths\n' >&2; exit 1; }
[[ ! -e "$output" ]] || { printf 'Output directory must not exist\n' >&2; exit 1; }
case "$output/" in "$signer/"*) printf 'Output must be outside signer state\n' >&2; exit 1 ;; esac
for required in previous.c25519 current.c25519 planet; do
    [[ -s "$signer/$required" ]] || { printf 'Missing signer input: %s\n' "$required" >&2; exit 1; }
done
mkdir -m 0700 -- "$output"
# Signing keys live only in tmpfs during generation, never in the output bundle.
docker run --rm --network none --entrypoint /bin/bash \
    --mount "type=bind,src=$signer,dst=/signer,readonly" \
    --mount "type=bind,src=$roots,dst=/roots.json,readonly" \
    --mount "type=bind,src=$output,dst=/output" \
    --tmpfs /work:rw,noexec,mode=0700 \
    --workdir /work "$image" -euc '
        umask 077
        cp /signer/previous.c25519 /signer/current.c25519 .
        cp /signer/planet world.bin.previous
        jq -e "{roots: .roots}" /roots.json > moon.json
        /usr/local/libexec/mkworld >/dev/null
        /usr/local/libexec/mkworld --verify-update world.bin.previous world.bin
        /usr/local/libexec/mkworld --inspect world.bin > /output/roots.json
        install -m 0644 world.bin /output/planet
        cd /output
        sha256sum planet roots.json > SHA256SUMS
    '
printf 'Signed candidate: %s/planet (not activated)\n' "$output"
