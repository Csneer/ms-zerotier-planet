# README artwork and screenshots

These assets describe the project without publishing deployment data.

- `private-network.svg` is an original, editable topology illustration. It uses example virtual IPs and separates peer traffic from the self-hosted control plane; the drawn connections are conceptual, not measurements.
- `console-zh-CN.png` and `console-en.png` were captured on 2026-10-31 from an isolated Docker instance of merge commit `7308b4911edb0f195724aa924053611382c01a02`, image `ghcr.io/csneer/ms-zerotier-planet@sha256:c1b29c1a6e3d1f210840912db37ec400f9183e236ca3fc2bebbd1744b312be7d`.
- The instance used a random, disposable Controller identity, the reserved public example `203.0.113.10`, a `10.42.0.0/24` demo network and three fabricated members (`Home NAS`, `Travel Laptop`, `Build Server`). Their absent path observations are intentionally retained. These images show management features, not real client connectivity or performance.
- Screenshots retain the actual application rendering, at 1440 × 1000 pixels; no production browser session, credentials, node identities or private deployments were used. The temporary container and its anonymous volumes were removed after capture.

When refreshing the images, use a disposable instance with fresh identity and synthetic state. Capture both language views after creating a network, configuring its address pool and adding fixture members. Keep application state honest and document the source commit; never use an authenticated production screenshot as a starting asset.
