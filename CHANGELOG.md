# Changelog

## Unreleased

## [1.1.0] - 2026-10-20

### Added

- An agent installation and acceptance guide covering prerequisites, non-interactive setup, upgrades and client verification.
- Disposable Chromium regressions for login, network creation, CIDR validation, rename and member persistence, language switching and mobile navigation, plus real Docker backup/recovery/rollback checks in CI.
- A small-server resource baseline and a repeatable direct/relay capacity-testing guide; no fixed throughput or member-capacity claims.

### Changed

- Reshape the dashboard, network lists, downloads and monitoring pages with consistent components, clearer task entry points, keyboard focus and responsive layouts.
- Refresh the Chinese and English project introductions around self-hosted networking on small cloud VMs, with SSH access to the loopback Web console and versioned image installation examples.

### Fixed

- Restore now checks complete checksum coverage, safe paths, required state and deployment roles before stopping the instance; damaged installations with missing data directories can recover from a valid offline backup.
- Restore rollback failures keep recovery paths available and prevent automatic startup with partially exchanged data.
- Network renaming handles Escape, duplicate blur/Enter events and failed saves correctly; member saves return explicit success/error responses and support clearing names.
- Easy network setup validates integer IPv4 CIDR prefixes and usable address pools in both the browser and backend; language links retain the Controller route.
- First-install failures explain how to retry using the retained configuration. Installation docs use a separate data directory, describe SSH access to the loopback Web listener and clarify client compatibility.

### Security

- Backups exclude only the three known image-provided ZeroTier tool symlinks and reject every other symbolic link, including TLS links. Incomplete backups are discarded instead of silently dropping user state.
- Checksum manifest generation propagates every command failure, rejecting partial but otherwise valid checksum lists and resuming services stopped for the failed backup.

## [1.0.0] - 2026-10-16

First project release; earlier unversioned changes are collected here without inventing historical releases. Project versions are independent of ZeroTier versions.

### Added

- Project SemVer tags, versioned GHCR images and a documented GitHub Release workflow; release tags select ZeroTier from their own `.env.example`.

- External signed multi-root Planet mode, Root-only instances, offline public bundle generation and isolated regression tests.
- One authenticated management model now shows Controller/World/Root topology, fresh-vs-stale Root observations, and shared multi-address LAN listeners.
- Root topology now exposes observed failover readiness, evidence source per Root, and World-version prerequisites without attempting an automatic traffic switch.
- Public world inspection and signature-chain verification, duplicate/private Root identity rejection and strict endpoint validation.
- Two-host public-UDP relay/failover verification with isolated clients; recovery-time observations and Controller HA limitations are documented explicitly.
- Native Root-only systemd guard and regressions allow API-created empty directories while rejecting Controller data and signing keys.
- Docker Compose deployment with host networking and persistent ztncui state.
- Safe `install.sh`, centralized `manage.sh`, and explicit `uninstall.sh` workflows.
- Checksummed backup, staged transactional restore, candidate health verification, and image rollback.
- Responsive Web dashboard, authenticated planet/moon downloads, and Web MTU editor.
- Chinese/English Web UI coverage across network, member, user, and error views.
- Connection monitoring for Planet reachability, optional local-probe paths, world consistency, and ZeroTier traffic metrics.
- Per-network communication summaries for observed Planet paths, probe direct/relay paths, authorization, bridge and version risks; unobserved members stay separate from unreachable members and the normal `-1` latency sentinel is not treated as an anomaly.
- Optional bounded endpoint TCP probes distinguish Root path reachability from selected business-port reachability without DNS resolution, remote commands, or automatic port scanning.
- In-place migration guidance now preserves existing Controller/Network state, adds explicit generated-to-external multi-root steps, persists `PLANET_MODE`/`ROOT_ONLY` during installation, and validates the added regression tests in CI.
- `install.sh --configure-only` and `manage.sh doctor --staged` validate resolved configuration while permitting pending external identity/Planet files; normal startup remains strict and existing `.env` is preserved.
- Isolated same-data generated-to-external upgrade regression checks World continuity, Controller networks/member authorization/fixed IPs, and identity/signing/Web state preservation; historical layouts still require manual verification.
- GHCR multi-architecture publishing and Dependabot configuration.
- Controller-only manual standby workflow with staged/fenced/active guards, explicit fencing evidence, resolved-Compose image pinning and offline snapshot validation; mixed Controller+Root standby and automatic election remain unsupported.
- Root onboarding helper prepares independent identities and emits add-only, signed Planet candidates without activating or modifying the signer head.

### Changed

- Pin `docker/login-action` to v4.5.2, following Dependabot PR #7.

- Monitoring distinguishes declared backup Roots from unexpected upstream Roots.
- Image publication runs offline signing/startup and authenticated single-/multi-root UI regressions before publishing.
- ZeroTier runtime upgraded from 1.14.1 to 1.16.2.
- New network MTU defaults to 1280; existing network MTU is editable from 1280 to 2800.
- Runtime uses host networking, a fixed public ZeroTier port, bounded logs, and an end-to-end health check.
- Public IP and ZeroTier port changes re-sign planet/moon without replacing identity or signing keys.
- Endpoint regeneration preserves the previous world file, including migration from legacy data layouts.
- Legacy `deploy.sh` is now a compatibility wrapper and cannot delete data or pull the obsolete upstream image.
- The legacy unauthenticated `3000/tcp` file service has been removed; configuration downloads remain behind the Web login.
- The Web console now listens on `127.0.0.1` by default and can be bound explicitly to a trusted ZeroTier address.

### Fixed

- CI checks each Bash script separately so syntax validation covers every listed file.

### Security

- External Planet upgrades never automatically reactivate an older image after failure, preventing unaware entrypoints from overwriting a multi-root world.
- Persistent secrets use restrictive permissions.
- Download routes allow only planet and correctly named moon files.
- Download implementations reject path traversal, non-regular files, and symbolic links.
- Optional probe state is mounted read-only and its local API token is never exposed in the Web response.
- Controller standby startup refuses missing/staged/fenced guards, stale Moon files, Root membership of a Controller-only identity and non-capability images.

[1.1.0]: https://github.com/Csneer/ms-zerotier-planet/releases/tag/v1.1.0
[1.0.0]: https://github.com/Csneer/ms-zerotier-planet/releases/tag/v1.0.0
