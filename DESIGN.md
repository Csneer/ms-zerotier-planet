# Design

## Source of truth

Status: Active · 2026-10-17

Product surfaces: authenticated ZeroTier Planet control center, public landing/sign-in shell, dashboard, network list/detail, monitoring, downloads, and administrator pages.

Evidence reviewed: `patch/head_layout.pug`, `patch/controller_layout.pug`, `patch/dashboard.pug`, `patch/monitor.pug`, `patch/networks.pug`, `patch/network_detail.pug`, `patch/downloads.pug`, `patch/ui-modern.css`, `patch/uiLanguage.js`, existing UI regression tests, and the README operational limits. The interface is server-rendered Pug with Bootstrap 3 compatibility and local CSS patches. No existing design brief or component library was present.

## Brand

ZeroTier Planet should feel like a calm network operations console: precise, quiet, trustworthy, and readable under pressure. Trust signals come from explicit status, timestamps, scope notes, checksums, and clear failure states. Avoid glossy SaaS dashboards, dense neon, decorative charts without evidence, ambiguous green states, and icons that carry meaning without text.

## Product goals

- Let an operator understand controller, World, Root, and member health within one scan.
- Make the next safe action obvious: inspect, configure, download, authorize, or refresh.
- Preserve the distinction between observed reachability, probe reachability, and application health.
- Keep existing routes, server-rendered data contracts, bilingual copy, and safe operational boundaries.

Non-goals: automatic failover, a new client-side application framework, replacing Bootstrap dependencies in one pass, or presenting monitoring as a historical time-series product.

Success signals: fewer wrapped headings and clipped tables at 360–1440px, visible focus states, one-handed mobile navigation, clear empty/error/loading states, and no regressions in the existing UI model tests.

## Personas and jobs

- Infrastructure operator: verify a Root/Controller deployment, read warnings, and perform safe maintenance.
- Network administrator: create networks, authorize members, manage IPs/routes/MTU, and inspect paths.
- Support or onboarding user: sign in, find the correct Planet/Moon file, verify its checksum, and understand scope.

## Information architecture

Primary navigation: Overview, Monitor, Networks, New network, Downloads, Administrators. The brand returns to Overview. Network detail groups summary, configuration, and members; advanced raw data remains collapsed. Monitor groups service summary, Root topology, network communication, endpoint probes, member paths, and traffic. Downloads explains Planet/Moon usage before the file table.

## Design principles

1. Evidence before decoration: a state includes a label, value, and scope where needed.
2. Progressive disclosure: common actions stay visible; raw JSON and risky operations stay behind clear sections.
3. Composable primitives: surfaces, cards, badges, buttons, fields, tables, and notices use shared tokens and variants.
4. Responsive by intent: navigation collapses, grids stack, and wide operational tables scroll with their headers instead of shrinking unreadably.
5. Safe optimism: pending, unavailable, stale, and unknown are distinct from healthy and offline.

## Visual language

Use a cool slate canvas with white surfaces, one indigo action color, cyan topology accents, green healthy states, amber attention states, and red destructive/error states. Tokens live in `patch/ui-modern.css` as CSS custom properties. Use a 4/8px spacing rhythm, 12–18px surface radii, restrained shadows, and sentence-case headings. Prefer the existing local Bootstrap Glyphicons until a vendored icon set is introduced; icons supplement labels and never replace them. Motion is limited to short hover/focus transitions and respects reduced-motion preferences.

## Components

Shared primitives: app shell and responsive nav, brand mark, page heading, surface card, stat card, action card, status/path badge, alert/notice, form field, switch, responsive table, empty state, confirmation card, advanced details, and language toggle. Each component has base, hover/focus, disabled, success/attention/error, and mobile behavior. Variants should be expressed with classes such as `.is-online`, `.is-offline`, `.is-unknown`, `.btn-primary`, and `.btn-default`, not page-specific inline styles.

## Accessibility

Target WCAG 2.1 AA for contrast and keyboard use. Keep visible `:focus-visible` rings, semantic headings, labelled inputs, button/link names, status text alongside color, and `aria-hidden` only on decorative icons. Mobile controls must remain at least 44px tall where practical. Respect `prefers-reduced-motion`; do not make hover the only way to discover an action.

## Responsive behavior

- 1200px+: wide shell with multi-column overview and monitor grids.
- 768–1199px: two-column status/config grids; navigation remains usable without crowding.
- <768px: collapsed navigation, stacked page heading/actions, one-column cards, two-column compact stats, and horizontal scrolling for genuinely wide member/monitor tables.
- <520px: single-column actions/forms, short labels, no forced table shrink, and touch-sized controls.

## Interaction states

Every data surface must support healthy, unavailable, stale/unknown, empty, error, and disabled states. Auto-save toggles show pending/failed feedback without losing the user's selection. Refresh is a normal action and should remain discoverable on mobile. Downloads show file type, size, modification time, checksum, and a single obvious action.

## Content voice

Use direct, operational language. Explain what a status proves and what it does not prove. Keep Chinese and English keys paired in `patch/uiLanguage.js`; avoid inventing stronger availability claims than the observation supports.

## Implementation constraints

The app is built from patched upstream ztncui templates and served by Node/Express. Keep Pug syntax, existing routes, Bootstrap compatibility, and local assets. Do not add a remote CDN or a client framework for this pass. Validate with Node syntax checks, UI model tests, template/build checks available in CI, and multi-viewport browser inspection when a disposable app instance is available.

## Open questions

- [ ] Owner: product · Decide whether to vendor a dedicated icon set after the current local icon pass; impact: visual consistency and long-term asset ownership.
- [ ] Owner: operations · Provide a disposable signed test instance URL for screenshot-level visual QA; impact: live page evidence beyond template and CSS checks.

## Root address-family observations

Root cards separate signed stable endpoints from actual service and probe paths. IPv4 and IPv6 use the same visual weight. An unconfigured family is neutral, a local endpoint is explicitly unverified externally, and an unavailable probe reports missing evidence rather than a failed network. Either family can supply a usable dual-stack Root path. Show each observed path once, retain its full address with wrapping, and stack labels above values below 520px. Validate bilingual models and rendering; external IPv6 availability requires a real external host and is not established by local rendering or local Root identity.
