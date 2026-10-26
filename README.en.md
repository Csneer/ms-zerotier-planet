# zerotier-planet-ms

[中文](README.md)

<div align="center">

[![CI](https://github.com/Csneer/zerotier-planet-ms/actions/workflows/image-build.yml/badge.svg)](https://github.com/Csneer/zerotier-planet-ms/actions/workflows/image-build.yml)
[![Latest release](https://img.shields.io/github/v/release/Csneer/zerotier-planet-ms?display_name=tag)](https://github.com/Csneer/zerotier-planet-ms/releases)

<h2>Put your ZeroTier entry point back in your hands.</h2>

<p><strong>Private Planet · Web Controller · IPv4 / IPv6 Roots</strong></p>

<p>Use one affordable cloud VM to connect your NAS, workstations, and servers on one private network.</p>

<p><a href="#quick-start-in-60-seconds">Quick start</a> · <a href="docs/ipv6-roots.md">IPv6 Root guide</a> · <a href="docs/agent-install.md">Agent guide</a> · <a href="CHANGELOG.md">Changelog</a></p>

</div>

---

## In one sentence

`zerotier-planet-ms` packages a maintainable ZeroTier Planet, Root, Controller, and Web console. You keep control of the network entry point, member authorization, and virtual addresses; clients continue to use any ZeroTier build that supports replacing its `planet` file, while SSH, RDP, HTTP, databases, and other services remain unchanged.

```text
your devices and private services  ─────  private ZeroTier network  ─────  your Planet + Root
                                                                                 └─ Controller + Web console
```

## Why start here

| Start small | Own the control plane | Leave room to grow |
| --- | --- | --- |
| A 2 vCPU / 2 GiB cloud VM is a practical start for personal and small-team, low-to-moderate traffic. | Planet, identities, networks, authorizations, and virtual IPs stay on infrastructure you control. | Start with one Root, then add independent Roots; IPv4, IPv6, and dual-stack are supported. |

- **Manage visually**: create networks, authorize members, adjust MTU, and download signed `planet` / `.moon` files with SHA-256.
- **Migrate deliberately**: upgrades preserve identity and signing chains, with explicit non-destructive backup and restore boundaries.
- **See the path**: the dashboard and Connection Monitor share Controller / World / Root topology and distinguish recent responses, stale paths, and unavailable probes.

## Quick start in 60 seconds

Use a Linux host with a stable public IPv4 address or globally routable IPv6 address. Allow `9994/udp` for the address family you use, and install Docker Engine 24+, Compose v2, Bash, Git, Python 3, `jq`, and GNU coreutils.

```bash
git clone https://github.com/Csneer/zerotier-planet-ms.git
cd zerotier-planet-ms
./install.sh --ip YOUR_PUBLIC_IPV4 --data-dir /srv/zerotier-planet
```

For an IPv6-only or dual-stack Root:

```bash
# IPv6-only
./install.sh --ipv6 YOUR_PUBLIC_IPV6 --data-dir /srv/zerotier-planet

# dual-stack
./install.sh --ip YOUR_PUBLIC_IPV4 --ipv6 YOUR_PUBLIC_IPV6 \
  --data-dir /srv/zerotier-planet
```

Open the console through an SSH tunnel:

```bash
ssh -N -L 3443:127.0.0.1:3443 user@server
```

Visit `http://127.0.0.1:3443`, sign in with `admin/password`, and change the password immediately. Create a network in `Networks`, download `planet` from `Downloads`, join the network from each client, then authorize its member in the console.

> **Version note:** IPv6-only installation and address-family migration are included in the `v1.2.0` image. Build the current checkout when reviewing changes after this release. See the [IPv6 Root guide (Chinese)](docs/ipv6-roots.md) for host, firewall, and migration checks.

## Clear boundaries

This is a private virtual network for multiple TCP/UDP services, not a temporary HTTP-only tunnel. You still manage the public address, cloud security group, host firewall, and client-side `planet` distribution. Multiple Roots provide path redundancy; they do not make the Controller highly available or guarantee instant failover. Validate a single-Root client path first, then expand with the [multi-root deployment guide (Chinese)](docs/multi-root.md).

> **Good fit**: self-hosted network entry points, home labs, small-team development environments, and cross-region networks where you want to own the Planet.<br>
> **Not promised**: fixed throughput, guaranteed direct paths across carriers, or automatic Planet replacement on unverified clients.

## Maintained derivative scope

- ZeroTier `1.16.2`, selected through `.env` and build arguments.
- Host networking for the ZeroTier UDP hot path.
- Default MTU `1280`; existing networks can edit MTU from `1280` to `2800` in the Web UI.
- Responsive dashboard for networks, members, users, MTU, and signed configuration downloads.
- Connection monitoring separates the Planet-server view from an optional local-probe view and exposes ZeroTier traffic metrics.
- The multi-root panel reports observed failover readiness, World consistency, and evidence per backup Root; it is intentionally read-only and never changes firewall rules or forces traffic switching.
- Persistent identity, Controller state, users, aliases, and session key.
- Combined health check, process supervision, graceful shutdown, and bounded Docker logs.
- IP or ZeroTier port changes re-sign planet/moon while retaining identity and world signing keys.
- Multi-root worlds with one offline publisher, independent Root identities and Root-only instances; see the [multi-root deployment and failover guide (Chinese)](docs/multi-root.md).
- Multiple Roots do not provide Controller HA or guarantee instant failover: one isolated two-host trial recovered after approximately 245 seconds. Validate your client versions and real paths before relying on a recovery-time target.
- Dashboard and monitor share Controller / World / Root topology, distinguish recent responses from stale paths or unavailable probes, and serve one UI on loopback plus explicit ZeroTier addresses.
- Explicit, non-destructive install, upgrade, backup, restore, password-reset, and uninstall commands.
- GitHub Actions publish multi-architecture images to this repository's GHCR package.
- The [small-VM benchmark](docs/capacity-benchmark.md) records the 2 vCPU / 2 GiB baseline; idle resource use is not a relay throughput or member-count guarantee.

## Requirements

- 64-bit Linux; Debian 12, Ubuntu 22.04+, or Rocky Linux 9 is recommended.
- Docker Engine 24+ and Docker Compose v2.
- Bash, Git, Python 3, `jq`, and GNU coreutils.
- A stable public IPv4 address, IPv6 address, or both; every Root needs at least one reachable address family.
- Allow `${ZT_PORT}/udp` through host and cloud firewalls (`9994/udp` by default); dual-stack hosts must allow both IPv4 and IPv6.

| Default | Protocol | Purpose | Exposure |
|---:|---|---|---|
| 9994 | UDP | ZeroTier Planet Root stable endpoint | Public; allow UDP for every Root |
| 9994 | TCP | ZeroTier local management API | Loopback or trusted sources only; not a public HTTPS/business endpoint |
| 3443 | TCP | Web administration | Trusted IPs, ZeroTier subnet, or local reverse proxy |

The legacy `3000/tcp` file server has been removed. `planet` and `.moon` files are available only from the authenticated Web `Downloads` page.

The installer does not install Docker, change the kernel or firewall, or write Docker daemon configuration.

## Install

Build from your checkout (replace the example addresses with the server's real public addresses):

```bash
git clone https://github.com/Csneer/zerotier-planet-ms.git
cd zerotier-planet-ms
./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet
```

Optional arguments:

```bash
./install.sh \
  --ip 203.0.113.10 \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

IPv6-only Root:

```bash
./install.sh --ipv6 2001:db8::10 --data-dir /srv/zerotier-planet
```

Run this in a fresh checkout on the backup host, with no existing `.env`. Do not reuse an existing client or Controller directory:

```bash
CONTAINER_NAME=myztplanet-root-b ./install.sh --ip 203.0.113.20 \
  --data-dir /srv/zt-root-b \
  --image zerotier-planet:multi-root \
  --planet-mode external --root-only 1 --configure-only
```

This only creates configuration; it does not create a multi-root signed world. A trusted publisher must prepare and verify `config/planet` before `./manage.sh up`. A backup Root must not run the Controller or share `one/` or `controller.d/` with the primary.

Generate B's independent identity and give only `identity.public` to the signer; never copy A's identity:

```bash
./build.sh
(
  set -eu
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  docker run --rm --network none --entrypoint zerotier-idtool \
    -v /srv/zt-root-b/one:/work \
    zerotier-planet:multi-root generate /work/identity.secret /work/identity.public
)
```

Create and validate `.env` without starting Docker:

```bash
./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet --configure-only
```

Use an image published by your repository:

```bash
./install.sh \
  --ip 203.0.113.10 \
  --pull \
  --image ghcr.io/csneer/ms-zerotier-planet:latest
```

The installer never overwrites an existing `.env` or deletes an existing data directory. A new deployment starts with `admin/password`; change it immediately. The Web UI listens on `127.0.0.1:3443` by default. Set `HTTP_HOST` to the server's ZeroTier address when that is the only listener, or add explicit comma-separated addresses through `HTTP_EXTRA_HOSTS` (for example `HTTP_EXTRA_HOSTS=198.51.100.97`). Subnets and wildcard addresses are rejected for extra listeners. The default Compose deployment does not enable HTTPS; a trusted reverse proxy is recommended when it is needed. Listeners share accounts and session storage, but browser cookies are host-specific, so switching IPs may require signing in again.

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
- `CONTAINER_NAME`: use unique names for independent instances or cross-project adoption while retaining the stopped old container.
- `IP_ADDR4`, `IP_ADDR6`, `ZT_PORT`: published Planet endpoints. A Root needs at least one of the two address families; set both for dual-stack.
- `PLANET_MODE`: `generated` for the legacy single Root; `external` for a centrally signed `config/planet`.
- `ROOT_ONLY`: `1` starts only ZeroTier, without the Web UI; defaults to `0`.
- `CONTROLLER_ONLY`: `1` enables the guarded external Controller-only manual standby; it is not a Root and requires an active standby guard; defaults to `0`.
- `API_PORT`: Web management port.
- `DEFAULT_NETWORK_MTU`: `1280` is recommended for Internet paths.
- `HTTP_HOST`: Web listen address; defaults to `127.0.0.1` and may be set to the server's ZeroTier address.
- `HTTP_EXTRA_HOSTS`: optional comma-separated explicit IP listeners sharing the same authenticated UI; unavailable optional addresses are retried without taking down the primary listener.
- `ZT_PROBE_ADDR`: optional local probe API, defaulting to `http://127.0.0.1:9993`.
- `ZT_ENDPOINT_PROBES_FILE`: optional TCP endpoint probe configuration, defaulting to `/app/config/endpoint-probes.json`; only literal IP addresses and ports are accepted.

Empty or omitted `IP_ADDR4` / `IP_ADDR6` fields in Compose disable that family instead of restoring saved addresses. Review hand-maintained `.env` files before upgrading and retain at least one endpoint for a Root.

In single-root `generated` mode, after changing a public IP or `ZT_PORT`, run `./manage.sh upgrade`. Identity and `.c25519` signing keys remain unchanged, but clients must download and install the newly generated `planet`. In `external` mode, publish a verified signed update with `planet-bundle.sh` instead. Multi-root redundancy does not replicate the Controller, enforce a primary/backup order, or automatically stop traffic at a cloud quota.

After creating your remote repository, set `SOURCE_REPOSITORY` to its URL. Leaving it blank keeps the OCI source label empty instead of attributing a modified image to the old upstream repository.

## Connection status and monitoring

The authenticated Connection Monitor reports distinct observations:

- `Planet reachable` means the Planet server currently sees an active path to the member. It says nothing about paths between other endpoints.
- `Direct to Planet` is an active physical path between that member and the Planet server, not proof that the member is direct to another client.
- Probe `DIRECT`, `RELAY`, or `TCP RELAY` describes only the path from the host's local ZeroTier client to that member. It is one observation point, not a full endpoint-to-endpoint matrix.
- Planet packet rates and UDP/TCP traffic come from ZeroTier's built-in Prometheus metrics. The page derives rates from consecutive samples.
- The page verifies that the runtime Planet matches the downloadable file and reports Roots absent from the configured public manifest; a declared private backup Root is not misclassified as public.
- Root topology shows declared endpoints and recent service/probe observations separately for IPv4 and IPv6. Overall Root reachability means at least one recent service path; an unobserved IPv6 path is not evidence that the client or host lacks IPv6.

To enable the probe view, set `ZT_PROBE_STATE_DIR` to the host ZeroTier client's state directory. Compose mounts it read-only and queries `ZT_PROBE_ADDR`. A missing token or unavailable API is reported as “probe unavailable” without affecting the main service.

Endpoint service probes are a separate optional observation layer. Copy [examples/endpoint-probes.json](examples/endpoint-probes.json) into the persistent `config/endpoint-probes.json`; the monitor then performs bounded, read-only TCP connects and closes each socket immediately. It accepts only literal IPv4/IPv6 addresses (interface-zone `%` forms are rejected), 1–32 targets, and 100–5000 ms timeouts. Each sample also has an approximately 10-second total budget; targets that exceed it are marked timed out. It never resolves DNS, runs SSH/HTTP commands, or scans arbitrary ports. TCP success means only that this management instance reached the target port; it does not prove a direct ZeroTier path, application-protocol health, or which Root carries traffic. No probes run when the file is absent.

To verify whether two specific endpoints are direct, inspect `zerotier-cli peers` on an endpoint or run an end-to-end transfer test. The central controller cannot reliably infer every endpoint pair's live path.

## In-place upgrade from an existing Planet deployment

An in-place path is provided, not unconditional one-click compatibility with every legacy image/layout. Use the [in-place upgrade guide](docs/in-place-upgrade.md) for commands and acceptance checks:

1. Keep independent management access. Inspect old mounts and back up identities, `controller.d/`, signing keys, all Planet copies, endpoint settings, Web users and the session key. Never initialize replacement identities or signing keys to bypass missing legacy files.
2. For this project's source upgrades, keep `.env`, mounts and the current `PLANET_MODE`; run `doctor` and `upgrade`. Cross-checkout adoption requires absolute paths and stopping the old service. A stopped container still owns its name: choose a different new name or rename and retain the old one. Never run the same identity twice.
3. Use `generated` only for a verified single Root with intact signing material and endpoint settings. Existing multi-Root/external deployments must stay `external`. A trusted current Planet can be adopted as external without signing keys after the guide's checks, but adding Roots still requires the original signing chain.
4. Give B an independent identity and sign an A/B candidate with the original World chain. Verify signatures, timestamps and hashes, stage `config/planet`, and prepare/verify B before rolling A. A stays the only active Controller; do not copy its `one/` to B.
5. Roll the same Planet out to clients, retaining Network IDs/IPs/authorization, then verify actual relaying and recovery time with isolated clients. `doctor` is not cryptographic validation; candidate checks and container startup verify the signature chain and local Root membership.

Multiple Roots do not impose file-order priority or provide multi-primary Controllers. Image rollback is not World-topology rollback: restoring a topology requires a newer signed World timestamp.

See the [in-place upgrade guide](docs/in-place-upgrade.md), [multi-root deployment and failover guide](docs/multi-root.md), [Controller-only manual standby guide](docs/controller-standby.md), [Root onboarding guide](docs/root-onboarding.md), and [native Root-only guide](docs/native-root.md) for signed publication, isolated systemd deployment, and failover validation. The Controller standby guide is intentionally manual and does not claim mixed Controller+Root or automatic election support.

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

`upgrade` prepares the candidate image before downtime, creates a consistent backup, recreates the container, and waits for health. In `generated` mode it may restore the previous image after a failed health check; in `external` mode it retains the rollback tag and backup for manual review because an older image may overwrite a signed multi-root World.

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

The optional read-only `probe-state` client directory is intentionally outside the formal backup set. Reconfigure `ZT_PROBE_STATE_DIR` on the target host instead; its token is not Controller or Root state.

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

| Platform | Validation available | Requirements |
| --- | --- | --- |
| Linux | Container startup, signed updates, and isolated network regression | Permission to stop the service and replace Planet; verify end-to-end access in your deployment |
| Windows / macOS | Common paths documented; no real-device regression in this round | Administrator access to replace Planet, then verify network membership and service access |
| Android / iOS | Private Planet onboarding unverified | Import support and permissions depend on client version and device policy; joining a Network ID alone does not establish private Planet access |

Validate mobile Planet import, network membership, and end-to-end access on a test device with a recovery path before relying on it.

## Versions and image publishing

Project releases use independent SemVer tags (`vX.Y.Z`). The current release is `v1.2.0`, with image `ghcr.io/csneer/ms-zerotier-planet:v1.2.0`. These are distinct from runtime versions such as ZeroTier `1.16.2`. See the [changelog](CHANGELOG.md) and [release procedure (Chinese)](docs/releasing.md) for repository identity setup, tagging, and GitHub Releases.

The [image workflow](.github/workflows/image-build.yml) validates scripts, Compose, and container regressions before building `linux/amd64` and `linux/arm64` images:

- A release tag `vX.Y.Z` selects `ZT_VERSION` from that tag's `.env.example` (`1.16.2` for `v1.2.0`) and publishes only the project version image, leaving rolling tags unchanged.
- Pushes to `main`/`master`, weekly builds, and ordinary manual builds continue to track the latest stable ZeroTier release (or a manually specified version), publishing `latest`, ZeroTier version, and Git SHA tags.
- Record and deploy the image digest when exact image contents must remain fixed. A version tag does not mean every build dependency is locked.

Private GHCR packages require `docker login ghcr.io` on the deployment host. Dependabot checks Docker base images and GitHub Actions weekly.

## Security and licensing

- Do not expose the Web console to the whole Internet. Use a firewall allowlist or `HTTP_HOST=127.0.0.1` with a TLS reverse proxy.
- For direct administration over ZeroTier, use an explicit ZeroTier address as `HTTP_HOST` or `HTTP_EXTRA_HOSTS`; avoid `0.0.0.0`.
- Never commit `.env`, `data/`, `backups/`, identities, `.c25519` files, or tokens.
- ztncui is no longer actively maintained; treat it as a privileged internal service.
- This repository does not invent a new license for historical code. Review [NOTICE.md](NOTICE.md) and all applicable third-party licenses before public redistribution or commercial use.

Operational deployment guides are kept under [`docs/`](docs/), including the [in-place upgrade guide](docs/in-place-upgrade.md), [multi-root/failover guide](docs/multi-root.md), [Controller-only manual standby guide](docs/controller-standby.md), [Root onboarding guide](docs/root-onboarding.md), and [native Root-only guide](docs/native-root.md).
