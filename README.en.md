# ms-zerotier-planet

[中文](README.md)

This is an independently maintained derivative for running a long-lived self-hosted ZeroTier Planet, embedded Controller, and Web console as one Docker Compose service. It builds from the checked-out source by default and does not depend on a third-party `latest` image.

The project is published as a standalone repository rather than a GitHub Fork, with production maintainability as its primary goal. See [NOTICE.md](NOTICE.md) for third-party components, historical attribution, and licensing boundaries.

## Maintained derivative scope

- ZeroTier `1.16.2`, selected through `.env` and build arguments.
- Host networking for the ZeroTier UDP hot path.
- Default MTU `1280`; existing networks can edit MTU from `1280` to `2800` in the Web UI.
- Responsive dashboard for networks, members, users, MTU, and signed configuration downloads.
- Connection monitoring separates the Planet-server view from an optional local-probe view and exposes ZeroTier traffic metrics.
- Persistent identity, Controller state, users, aliases, and session key.
- Combined health check, process supervision, graceful shutdown, and bounded Docker logs.
- IP or ZeroTier port changes re-sign planet/moon while retaining identity and world signing keys.
- Explicit, non-destructive install, upgrade, backup, restore, password-reset, and uninstall commands.
- GitHub Actions publish multi-architecture images to this repository's GHCR package.

## Requirements

- 64-bit Linux; Debian 12, Ubuntu 22.04+, or Rocky Linux 9 is recommended.
- Docker Engine 24+ and Docker Compose v2.
- Bash, Git, Python 3, `jq`, and GNU coreutils.
- A stable public IPv4 address; IPv6 is optional.
- Allow `${ZT_PORT}/udp` through host and cloud firewalls (`9994/udp` by default).

| Default | Protocol | Purpose | Exposure |
|---:|---|---|---|
| 9994 | UDP/TCP | ZeroTier Planet/Controller | Public; UDP is required |
| 3443 | TCP | Web administration | Trusted IPs, ZeroTier subnet, or local reverse proxy |

The legacy `3000/tcp` file server has been removed. `planet` and `.moon` files are available only from the authenticated Web `Downloads` page.

The installer does not install Docker, change the kernel or firewall, or write Docker daemon configuration.

## Install

Build from your checkout:

```bash
git clone https://github.com/Csneer/ms-zerotier-planet.git
cd ms-zerotier-planet
./install.sh --ip <public-ipv4>
```

Optional arguments:

```bash
./install.sh \
  --ip 203.0.113.10 \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

Create and validate `.env` without starting Docker:

```bash
./install.sh --ip 203.0.113.10 --configure-only
```

Use an image published by your repository:

```bash
./install.sh \
  --ip 203.0.113.10 \
  --pull \
  --image ghcr.io/csneer/ms-zerotier-planet:latest
```

The installer never overwrites an existing `.env` or deletes an existing data directory. A new deployment starts with `admin/password`; change it immediately. The Web UI listens on `127.0.0.1:3443` by default. Set `HTTP_HOST` to the server's ZeroTier address when access should come from that network. HTTPS is not built in; add a trusted reverse proxy when it is needed.

## Configuration

Runtime configuration lives in the untracked `.env`; see [.env.example](.env.example).

Important variables:

- `ZT_VERSION`, `ZTNCUI_COMMIT`, `MKWORLD_ZT_VERSION`: pinned build inputs.
- `DEBIAN_MIRROR`: Debian mirror host; use `default` when Aliyun is not appropriate.
- `ZT_IMAGE`: local or remote image reference.
- `IMAGE_SOURCE`: `build` for this checkout or `pull` for a registry image.
- `SOURCE_REPOSITORY`: your repository URL for OCI metadata.
- `DATA_DIR`, `ZTNCUI_STATE_DIR`, `BACKUP_DIR`: persistent state and backup paths.
- `ZT_PROBE_STATE_DIR`: optional host ZeroTier client state, mounted read-only for probe authentication.
- `CONTAINER_NAME`: override only for multiple independent instances on one host.
- `IP_ADDR4`, `IP_ADDR6`, `ZT_PORT`: published Planet endpoints.
- `API_PORT`: Web management port.
- `DEFAULT_NETWORK_MTU`: `1280` is recommended for Internet paths.
- `HTTP_HOST`: Web listen address; defaults to `127.0.0.1` and may be set to the server's ZeroTier address.
- `ZT_PROBE_ADDR`: optional local probe API, defaulting to `http://127.0.0.1:9993`.

After changing a public IP or `ZT_PORT`, run `./manage.sh upgrade`. Identity and `.c25519` signing keys remain unchanged, but clients must download and install the newly generated `planet`.

After creating your remote repository, set `SOURCE_REPOSITORY` to its URL. Leaving it blank keeps the OCI source label empty instead of attributing a modified image to the old upstream repository.

## Connection status and monitoring

The authenticated Connection Monitor reports distinct observations:

- `Planet reachable` means the Planet server currently sees an active path to the member. It says nothing about paths between other endpoints.
- `Direct to Planet` is an active physical path between that member and the Planet server, not proof that the member is direct to another client.
- Probe `DIRECT`, `RELAY`, or `TCP RELAY` describes only the path from the host's local ZeroTier client to that member. It is one observation point, not a full endpoint-to-endpoint matrix.
- Planet packet rates and UDP/TCP traffic come from ZeroTier's built-in Prometheus metrics. The page derives rates from consecutive samples.
- The page verifies that the runtime Planet matches the downloadable file and reports public Root connections; a healthy private Root should not retain public Root peers.

To enable the probe view, set `ZT_PROBE_STATE_DIR` to the host ZeroTier client's state directory. Compose mounts it read-only and queries `ZT_PROBE_ADDR`. A missing token or unavailable API is reported as “probe unavailable” without affecting the main service.

To verify whether two specific endpoints are direct, inspect `zerotier-cli peers` on an endpoint or run an end-to-end transfer test. The central controller cannot reliably infer every endpoint pair's live path.

## Operations

```bash
./manage.sh doctor
./manage.sh status
./manage.sh logs
./manage.sh restart
./manage.sh build
./manage.sh up
./manage.sh upgrade
```

Recommended source upgrade:

```bash
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
```

`upgrade` prepares the candidate image before downtime, creates a consistent backup, recreates the container, waits for health, and rolls back the image on failure.

## Backup, restore, and removal

Consistent backup with a short service interruption:

```bash
./manage.sh backup
```

Best-effort online snapshot:

```bash
./manage.sh backup --online
```

Restore verifies checksums and backs up current data first:

```bash
./manage.sh restore ./backups/planet-YYYYMMDD-HHMMSS --yes
```

Backups contain identities, signing keys, tokens, and password hashes. Directories use mode `0700` and files `0600`; never commit them.

Reset Web credentials after backing up the current password file:

```bash
./manage.sh reset-password --yes
```

Remove the container while preserving state:

```bash
./uninstall.sh
```

Purge state only with explicit confirmation; a final backup is always created:

```bash
./uninstall.sh --purge-data --yes
```

## Client bootstrap

1. Sign in to the Web console and open `Downloads`.
2. Download `planet` and verify its displayed SHA-256.
3. Stop the client ZeroTier service.
4. Replace the client's `planet` file.
5. Start ZeroTier, join a network, and authorize the member in the Web UI.
6. Run `zerotier-cli peers` and verify the self-hosted node is a `PLANET`, preferably over `DIRECT`.

Common paths:

- Linux: `/var/lib/zerotier-one/planet`
- Windows: `C:\ProgramData\ZeroTier\One\planet`
- macOS: `/Library/Application Support/ZeroTier/One/planet`

## Image publishing

The GitHub workflow validates scripts and Compose, builds `linux/amd64` and `linux/arm64`, resolves the latest stable ZeroTier release (or a manual version), and publishes `latest`, version, and Git SHA tags to:

```text
ghcr.io/csneer/ms-zerotier-planet
```

Private GHCR packages require `docker login ghcr.io` on the deployment host. Dependabot checks Docker base images and GitHub Actions weekly.

## Security and licensing

- Do not expose the Web console to the whole Internet. Use a firewall allowlist or `HTTP_HOST=127.0.0.1` with a TLS reverse proxy.
- For direct administration over ZeroTier, bind `HTTP_HOST` to the server's ZeroTier address; avoid `0.0.0.0`.
- Never commit `.env`, `data/`, `backups/`, identities, `.c25519` files, or tokens.
- ztncui is no longer actively maintained; treat it as a privileged internal service.
- This repository does not invent a new license for historical code. Review [NOTICE.md](NOTICE.md) and all applicable third-party licenses before public redistribution or commercial use.
