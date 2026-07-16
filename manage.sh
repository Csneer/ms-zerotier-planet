#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SERVICE=myztplanet
COMPOSE_JSON=
LAST_BACKUP=
RESUME_SERVICE_ON_EXIT=0

log() {
    printf '[planet] %s\n' "$*"
}

warn() {
    printf '[planet] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[planet] ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if ((RESUME_SERVICE_ON_EXIT)); then
        warn 'an operation failed after stopping the service; attempting to resume it'
        docker compose start "$SERVICE" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

usage() {
    cat <<'EOF'
Usage: ./manage.sh COMMAND [options]

Commands:
  doctor                         Validate Docker, Compose, .env and mounts.
  build                          Build the configured local image.
  up                             Start the service without replacing data.
  upgrade                        Build/pull, back up, recreate and health-check.
  status                         Show Compose, ZeroTier and network status.
  logs [docker compose args]     Follow service logs (default: --tail 200 -f).
  restart                        Restart and wait for a healthy service.
  backup [--online]              Create a checksummed backup. Default is offline
                                 for a consistent snapshot and resumes service.
  restore BACKUP --yes           Back up current data, then restore BACKUP.
  reset-password --yes           Back up users, reset to admin/password, restart.
  down                           Remove the container but preserve all data.
  uninstall [--purge-data --yes] Remove the container; data purge is opt-in and
                                 always creates a final backup first.
  help                           Show this help.

IMAGE_SOURCE in .env controls upgrade behavior:
  build (default)  build the checked-out source with ./build.sh
  pull             pull ZT_IMAGE from its registry
EOF
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

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

load_config() {
    [[ -s .env ]] || die '.env is missing; run ./install.sh --ip PUBLIC_IPV4 first'
    COMPOSE_JSON=$(docker compose config --format json) || die 'docker compose configuration is invalid'
    jq -e --arg service "$SERVICE" '.services[$service]' <<<"$COMPOSE_JSON" >/dev/null \
        || die "Compose service not found: $SERVICE"
}

config_value() {
    jq -r "$1" <<<"$COMPOSE_JSON"
}

container_name() {
    config_value ".services.${SERVICE}.container_name // \"${SERVICE}\""
}

image_name() {
    config_value ".services.${SERVICE}.image"
}

mount_source() {
    local target=$1
    jq -r --arg service "$SERVICE" --arg target "$target" \
        '.services[$service].volumes[] | select(.target == $target and .type == "bind") | .source' \
        <<<"$COMPOSE_JSON" | head -n 1
}

container_exists() {
    docker inspect "$(container_name)" >/dev/null 2>&1
}

container_running() {
    [[ "$(docker inspect "$(container_name)" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]]
}

wait_healthy() {
    local name deadline status state
    name=$(container_name)
    deadline=$((SECONDS + ${HEALTH_TIMEOUT_SECONDS:-120}))
    while ((SECONDS < deadline)); do
        state=$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || true)
        status=$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)
        if [[ "$state" == running && "$status" == healthy ]]; then
            log "$name is running ($status)"
            return 0
        fi
        [[ "$state" != exited && "$state" != dead ]] || break
        sleep 2
    done
    docker logs --tail 120 "$name" >&2 2>/dev/null || true
    return 1
}

safe_directory() {
    local path=$1 resolved lexical _ _ _ _ _ home_dir _
    [[ -n "$path" ]] || return 1
    [[ ! -L "$path" ]] || return 1
    resolved=$(realpath -m -- "$path")
    lexical=$(realpath -ms -- "$path")
    # Refuse any symlinked parent as well as broad operating-system paths.
    # This keeps purge/restore from following a path that was redirected after
    # configuration, while still allowing conventional /var/lib/<app> data.
    [[ "$resolved" == "$lexical" ]] || return 1
    case "$resolved" in
        /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/home|/lib|/lib/*|/lib32|/lib32/*|/lib64|/lib64/*|/proc|/proc/*|/root|/run|/run/*|/sbin|/sbin/*|/sys|/sys/*|/usr|/usr/*|/var|/var/lib|/var/lib/docker|/var/lib/docker/*|/var/lib/containerd|/var/lib/containerd/*)
            return 1
            ;;
    esac
    [[ "$resolved" != "$HOME" && "$resolved" != "$ROOT_DIR" ]] || return 1
    while IFS=: read -r _ _ _ _ _ home_dir _; do
        [[ -z "$home_dir" || "$resolved" != "$home_dir" ]] || return 1
    done </etc/passwd
    return 0
}

paths_overlap() {
    local left right
    left=$(realpath -m -- "$1")
    right=$(realpath -m -- "$2")
    [[ "$left" == "$right" || "$left" == "$right/"* || "$right" == "$left/"* ]]
}

valid_port() {
    [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535))
}

valid_ipv4() {
    require_command python3
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).version == 4 else 1)' "$1" \
        >/dev/null 2>&1
}

valid_ipv6() {
    [[ "$1" == *:* && "$1" != *%* ]] || return 1
    require_command python3
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).version == 6 else 1)' "$1" \
        >/dev/null 2>&1
}

backup_root() {
    local root
    root=$(env_value BACKUP_DIR ./backups)
    if [[ "$root" != /* ]]; then
        root="$ROOT_DIR/$root"
    fi
    printf '%s' "$(realpath -m -- "$root")"
}

backup_data() {
    local online=${1:-0} resume=${2:-1}
    local name was_running=0 stamp destination label source
    local -a labels=(dist one config ztncui-state)
    local -a targets=(/app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui)

    load_config
    name=$(container_name)
    if container_running; then
        was_running=1
        if ((online == 0)); then
            log 'Stopping service for a consistent backup'
            docker compose stop -t 20 "$SERVICE"
            RESUME_SERVICE_ON_EXIT=1
        else
            warn 'creating an online backup; files may change during the snapshot'
        fi
    fi

    stamp=$(date +%Y%m%d-%H%M%S)
    destination="$(backup_root)/planet-$stamp"
    if [[ -e "$destination" ]]; then
        destination="${destination}-$$"
    fi
    install -d -m 0700 "$destination"

    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        source=$(mount_source "${targets[$i]}")
        if [[ -z "$source" || ! -d "$source" ]]; then
            if ((was_running && online == 0 && resume)); then
                docker compose start "$SERVICE" || true
            fi
            die "persistent directory is missing for ${targets[$i]}: ${source:-<unset>}"
        fi
        install -d -m 0700 "$destination/$label"
        if ! cp -a --reflink=auto "$source/." "$destination/$label/"; then
            if ((was_running && online == 0 && resume)); then
                docker compose start "$SERVICE" || true
            fi
            die "failed to copy $source"
        fi
    done

    cp -p .env docker-compose.yml "$destination/"
    if container_exists; then
        docker inspect "$name" >"$destination/container-inspect.json"
    fi
    {
        printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'repository_revision=%s\n' "$(git rev-parse HEAD 2>/dev/null || printf unknown)"
        printf 'image=%s\n' "$(image_name)"
        printf 'container=%s\n' "$name"
    } >"$destination/manifest.env"
    (
        cd "$destination"
        sums=$(mktemp .SHA256SUMS.tmp.XXXXXXXX)
        find . -type f ! -name SHA256SUMS ! -name "$sums" -print0 | sort -z | xargs -0 sha256sum >"$sums"
        mv -- "$sums" SHA256SUMS
        sha256sum -c SHA256SUMS >/dev/null
    )
    find "$destination" -type d -exec chmod 0700 {} +
    find "$destination" -type f -exec chmod 0600 {} +
    LAST_BACKUP=$destination
    log "Backup verified: $destination"

    if ((was_running && online == 0 && resume)); then
        docker compose start "$SERVICE"
        wait_healthy || die 'backup succeeded, but the service did not become healthy after restart'
    fi
    RESUME_SERVICE_ON_EXIT=0
}

prepare_image() {
    local source image version
    source=$(env_value IMAGE_SOURCE build)
    image=$(image_name)
    case "$source" in
        build)
            version=$(env_value ZT_VERSION 1.16.2)
            log "Building $image from the current checkout"
            ZT_VERSION="$version" IMAGE="$image" "$ROOT_DIR/build.sh"
            ;;
        pull)
            log "Pulling $image"
            docker compose pull "$SERVICE"
            ;;
        *)
            die "IMAGE_SOURCE must be 'build' or 'pull', got: $source"
            ;;
    esac
}

cmd_doctor() {
    local ip ip6 host source target key value root
    local -a sources=()
    require_command bash
    require_command docker
    require_command jq
    require_command realpath
    docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
    docker info >/dev/null 2>&1 || die 'cannot connect to the Docker daemon'
    load_config
    ip=$(config_value ".services.${SERVICE}.environment.IP_ADDR4")
    [[ "$ip" != 203.0.113.10 && -n "$ip" ]] || die 'IP_ADDR4 still contains the example address'
    valid_ipv4 "$ip" || die "IP_ADDR4 is invalid: $ip"
    ip6=$(config_value ".services.${SERVICE}.environment.IP_ADDR6")
    [[ -z "$ip6" ]] || valid_ipv6 "$ip6" || die "IP_ADDR6 is invalid: $ip6"
    [[ "$(config_value ".services.${SERVICE}.network_mode")" == host ]] || die 'network_mode must remain host for the optimized deployment'
    for key in ZT_PORT API_PORT FILE_SERVER_PORT; do
        value=$(config_value ".services.${SERVICE}.environment.${key}")
        valid_port "$value" || die "$key must be an integer between 1 and 65535"
    done
    [[ "$(config_value ".services.${SERVICE}.environment.ZT_PORT")" \
        != "$(config_value ".services.${SERVICE}.environment.API_PORT")" ]] || die 'ZT_PORT and API_PORT must be different'
    [[ "$(config_value ".services.${SERVICE}.environment.ZT_PORT")" \
        != "$(config_value ".services.${SERVICE}.environment.FILE_SERVER_PORT")" ]] || die 'ZT_PORT and FILE_SERVER_PORT must be different'
    [[ "$(config_value ".services.${SERVICE}.environment.API_PORT")" \
        != "$(config_value ".services.${SERVICE}.environment.FILE_SERVER_PORT")" ]] || die 'API_PORT and FILE_SERVER_PORT must be different'
    value=$(config_value ".services.${SERVICE}.environment.DEFAULT_NETWORK_MTU")
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((10#$value < 1280 || 10#$value > 2800)); then
        die 'DEFAULT_NETWORK_MTU must be between 1280 and 2800'
    fi
    case "$(env_value IMAGE_SOURCE build)" in
        build|pull) ;;
        *) die "IMAGE_SOURCE must be 'build' or 'pull'" ;;
    esac
    for target in /app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui; do
        source=$(mount_source "$target")
        [[ -n "$source" ]] || die "missing bind mount for $target"
        safe_directory "$source" || die "unsafe persistent path for $target: $source"
        for value in "${sources[@]}"; do
            paths_overlap "$source" "$value" && die "persistent paths overlap: $source and $value"
        done
        sources+=("$source")
    done
    root=$(backup_root)
    safe_directory "$root" || die "unsafe BACKUP_DIR: $root"
    for source in "${sources[@]}"; do
        paths_overlap "$root" "$source" && die "BACKUP_DIR overlaps persistent data: $root and $source"
    done
    host=$(config_value ".services.${SERVICE}.environment.HTTP_HOST")
    [[ "$host" != 0.0.0.0 ]] || warn 'HTTP_HOST=0.0.0.0 exposes the management UI; restrict it with a firewall or reverse proxy'
    log 'Docker, Compose and configuration checks passed'
}

cmd_build() {
    cmd_doctor
    prepare_image
}

cmd_up() {
    local image
    cmd_doctor
    image=$(image_name)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        prepare_image
    fi
    docker compose up -d --no-build "$SERVICE"
    wait_healthy || die 'service failed its health check'
}

cmd_upgrade() {
    local old_id image rollback_tag
    cmd_doctor
    image=$(image_name)
    old_id=$(docker inspect "$(container_name)" --format '{{.Image}}' 2>/dev/null || true)
    prepare_image
    if [[ -n "$old_id" ]]; then
        rollback_tag="zerotier-planet:rollback-$(date +%Y%m%d-%H%M%S)"
        docker tag "$old_id" "$rollback_tag"
        log "Rollback image: $rollback_tag"
    fi
    backup_data 0 0
    if docker compose up -d --no-build --force-recreate "$SERVICE" && wait_healthy; then
        log "Upgrade complete; backup: $LAST_BACKUP"
        return
    fi

    if [[ -n "$old_id" ]]; then
        warn 'new container failed; restoring the previous image'
        docker tag "$old_id" "$image"
        docker compose up -d --no-build --force-recreate "$SERVICE"
        wait_healthy || die "upgrade and automatic rollback both failed; data backup: $LAST_BACKUP"
        die "upgrade failed and was rolled back; data backup: $LAST_BACKUP"
    fi
    die "upgrade failed; data backup: $LAST_BACKUP"
}

cmd_status() {
    local name token port
    load_config
    docker compose ps
    name=$(container_name)
    if container_running; then
        docker inspect "$name" --format 'image={{.Config.Image}} image_id={{.Image}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}'
        token=$(docker exec "$name" cat /var/lib/zerotier-one/authtoken.secret 2>/dev/null || true)
        port=$(config_value ".services.${SERVICE}.environment.ZT_PORT")
        if [[ -n "$token" ]]; then
            docker exec -e TOKEN="$token" -e ZT_API_PORT="$port" "$name" bash -lc '
                curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/status" |
                    jq "{address,online,version,tcpFallbackActive}"
                for nwid in $(curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/controller/network" | jq -r ".[]"); do
                    curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/controller/network/$nwid" |
                        jq "{nwid,name,mtu,revision}"
                done
            '
        fi
    fi
}

cmd_logs() {
    load_config
    if (($#)); then
        docker compose logs "$@" "$SERVICE"
    else
        docker compose logs --tail 200 -f "$SERVICE"
    fi
}

cmd_restart() {
    load_config
    docker compose restart "$SERVICE"
    wait_healthy || die 'service failed its health check after restart'
}

cmd_backup() {
    local online=0
    while (($#)); do
        case "$1" in
            --online) online=1 ;;
            *) die "unknown backup option: $1" ;;
        esac
        shift
    done
    cmd_doctor
    backup_data "$online" 1
}

cmd_restore() {
    local source=${1:-} confirm=${2:-}
    local target label current_backup was_running=0 stamp parent base stage old failed_path
    local i j swapped=0
    local -a labels=(dist one config ztncui-state)
    local -a targets=(/app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui)
    local -a restore_targets=() stages=() old_targets=() failed_targets=()
    [[ -n "$source" && "$confirm" == --yes && $# == 2 ]] || die 'usage: ./manage.sh restore BACKUP --yes'
    source=$(realpath -e -- "$source") || die 'backup directory does not exist'
    [[ -f "$source/SHA256SUMS" ]] || die 'backup has no SHA256SUMS manifest'
    for label in "${labels[@]}"; do
        [[ -d "$source/$label" ]] || die "backup is missing: $label"
    done
    (cd "$source" && sha256sum -c SHA256SUMS >/dev/null) || die 'backup checksum verification failed'
    cmd_doctor
    for target in "${targets[@]}"; do
        target=$(mount_source "$target")
        paths_overlap "$source" "$target" && die "backup source overlaps restore target: $source and $target"
    done
    container_running && was_running=1
    backup_data 0 0
    current_backup=$LAST_BACKUP
    ((was_running == 0)) || RESUME_SERVICE_ON_EXIT=1
    stamp=$(date +%Y%m%d-%H%M%S)

    # Copy every dataset beside its destination before changing live data.
    # The later renames stay on the same filesystem and are therefore atomic.
    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        target=$(mount_source "${targets[$i]}")
        safe_directory "$target" || die "refusing to replace unsafe path: $target"
        install -d -m 0700 "$target"
        parent=$(dirname -- "$target")
        base=$(basename -- "$target")
        stage=$(mktemp -d "$parent/.${base}.restore.XXXXXXXX") || {
            for stage in "${stages[@]}"; do rm -rf -- "$stage"; done
            die "failed to create restore staging directory beside $target"
        }
        chmod 0700 "$stage"
        restore_targets[i]=$target
        stages[i]=$stage
        if ! cp -a --reflink=auto "$source/$label/." "$stage/"; then
            for stage in "${stages[@]}"; do rm -rf -- "$stage"; done
            die "failed to stage backup data for $label; live data was not changed"
        fi
    done

    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        target=${restore_targets[$i]}
        old="${target}.pre-restore-${stamp}-$$"
        old_targets[i]=$old
        if [[ -e "$old" ]] || ! mv -- "$target" "$old"; then
            for ((j=swapped - 1; j >= 0; j--)); do
                rm -rf -- "${restore_targets[$j]}"
                mv -- "${old_targets[$j]}" "${restore_targets[$j]}" || true
            done
            for stage in "${stages[@]}"; do [[ ! -e "$stage" ]] || rm -rf -- "$stage"; done
            die "failed to preserve the current $label directory; restore was rolled back"
        fi
        if ! mv -- "${stages[$i]}" "$target"; then
            mv -- "$old" "$target" || true
            for ((j=swapped - 1; j >= 0; j--)); do
                rm -rf -- "${restore_targets[$j]}"
                mv -- "${old_targets[$j]}" "${restore_targets[$j]}" || true
            done
            for stage in "${stages[@]}"; do [[ ! -e "$stage" ]] || rm -rf -- "$stage"; done
            die "failed to activate staged $label data; restore was rolled back"
        fi
        swapped=$((swapped + 1))
    done

    if ! docker compose up -d --no-build --force-recreate "$SERVICE" || ! wait_healthy; then
        warn 'restored data failed its health check; returning to the pre-restore data'
        docker compose down --remove-orphans >/dev/null 2>&1 || true
        for ((i=${#labels[@]} - 1; i >= 0; i--)); do
            target=${restore_targets[$i]}
            failed_path="${target}.failed-restore-${stamp}-$$"
            failed_targets[i]=$failed_path
            if ! mv -- "$target" "$failed_path"; then
                die "restore failed and the new $target directory could not be moved aside; verified backup: $current_backup"
            fi
            if ! mv -- "${old_targets[$i]}" "$target"; then
                mv -- "$failed_path" "$target" || true
                die "restore failed and pre-restore data could not be reactivated; verified backup: $current_backup"
            fi
        done
        if docker compose up -d --no-build "$SERVICE" && wait_healthy; then
            RESUME_SERVICE_ON_EXIT=0
            for failed_path in "${failed_targets[@]}"; do rm -rf -- "$failed_path"; done
            die "restore failed its health check and was rolled back; verified backup: $current_backup"
        fi
        die "restore and automatic rollback both failed; verified backup: $current_backup"
    fi

    RESUME_SERVICE_ON_EXIT=0
    for old in "${old_targets[@]}"; do rm -rf -- "$old"; done
    log "Restore complete; pre-restore backup: $current_backup"
}

cmd_reset_password() {
    [[ "${1:-}" == --yes && $# == 1 ]] || die 'usage: ./manage.sh reset-password --yes'
    local name root backup
    cmd_doctor
    name=$(container_name)
    container_running || die 'service is not running'
    root=$(backup_root)
    backup="$root/password-$(date +%Y%m%d-%H%M%S)"
    if [[ -e "$backup" ]]; then
        backup="${backup}-$$"
    fi
    install -d -m 0700 "$backup"
    docker cp "$name:/var/lib/ztncui/passwd" "$backup/passwd"
    chmod 0600 "$backup/passwd"
    (cd "$backup" && sha256sum passwd >SHA256SUMS)
    chmod 0600 "$backup/SHA256SUMS"
    docker exec "$name" bash -lc 'cp /var/lib/ztncui/default.passwd /var/lib/ztncui/passwd && chmod 0600 /var/lib/ztncui/passwd'
    cmd_restart
    log "Password reset to admin/password; change it immediately. Previous file: $backup"
}

cmd_down() {
    load_config
    docker compose down --remove-orphans
    log 'Container removed; persistent data was preserved'
}

cmd_uninstall() {
    local purge=0 confirm=0 target
    while (($#)); do
        case "$1" in
            --purge-data) purge=1 ;;
            --yes) confirm=1 ;;
            *) die "unknown uninstall option: $1" ;;
        esac
        shift
    done
    if ((purge == 0)); then
        load_config
        cmd_down
        return
    fi
    ((confirm)) || die 'data purge requires both --purge-data and --yes'
    cmd_doctor
    backup_data 0 0
    docker compose down --remove-orphans
    for target in /app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui; do
        target=$(mount_source "$target")
        safe_directory "$target" || die "refusing to purge unsafe path: $target"
        find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    done
    log "Container and persistent data removed; final backup: $LAST_BACKUP"
}

command_name=${1:-help}
shift || true
case "$command_name" in
    doctor) cmd_doctor "$@" ;;
    build) cmd_build "$@" ;;
    up) cmd_up "$@" ;;
    upgrade) cmd_upgrade "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    restart) cmd_restart "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    reset-password) cmd_reset_password "$@" ;;
    down) cmd_down "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    help|-h|--help) usage ;;
    *) die "unknown command: $command_name (run ./manage.sh help)" ;;
esac
