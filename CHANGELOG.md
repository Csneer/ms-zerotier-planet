# Changelog

## Unreleased

### Added

- Docker Compose deployment with host networking and persistent ztncui state.
- Safe `install.sh`, centralized `manage.sh`, and explicit `uninstall.sh` workflows.
- Checksummed backup, staged transactional restore, candidate health verification, and image rollback.
- Responsive Web dashboard, authenticated planet/moon downloads, and Web MTU editor.
- Chinese/English Web UI coverage across network, member, user, and error views.
- Connection monitoring for Planet reachability, optional local-probe paths, world consistency, and ZeroTier traffic metrics.
- GHCR multi-architecture publishing and Dependabot configuration.

### Changed

- ZeroTier runtime upgraded from 1.14.1 to 1.16.2.
- New network MTU defaults to 1280; existing network MTU is editable from 1280 to 2800.
- Runtime uses host networking, a fixed public ZeroTier port, bounded logs, and an end-to-end health check.
- Public IP and ZeroTier port changes re-sign planet/moon without replacing identity or signing keys.
- Endpoint regeneration preserves the previous world file, including migration from legacy data layouts.
- Legacy `deploy.sh` is now a compatibility wrapper and cannot delete data or pull the obsolete upstream image.
- The legacy unauthenticated `3000/tcp` file service has been removed; configuration downloads remain behind the Web login.
- The Web console now listens on `127.0.0.1` by default and can be bound explicitly to a trusted ZeroTier address.

### Security

- Persistent secrets use restrictive permissions.
- Download routes allow only planet and correctly named moon files.
- Download implementations reject path traversal, non-regular files, and symbolic links.
- Optional probe state is mounted read-only and its local API token is never exposed in the Web response.
