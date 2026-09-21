# Changelog

## Unreleased

### Added

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

### Security

- External Planet upgrades never automatically reactivate an older image after failure, preventing unaware entrypoints from overwriting a multi-root world.
- Persistent secrets use restrictive permissions.
- Download routes allow only planet and correctly named moon files.
- Download implementations reject path traversal, non-regular files, and symbolic links.
- Optional probe state is mounted read-only and its local API token is never exposed in the Web response.
- Controller standby startup refuses missing/staged/fenced guards, stale Moon files, Root membership of a Controller-only identity and non-capability images.
