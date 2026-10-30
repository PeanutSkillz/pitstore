# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton based on cockpit-project/starter-kit.
- Dashboard and Appstore pages in the Cockpit menu.
- Dashboard: tiles for installed apps with status, open, start, stop and restart,
  and a compact system summary (CPU, memory, disk, uptime) linking to Cockpit's pages.
- Debian packaging (`pitstore`, depends only on `cockpit-ws` and `cockpit-bridge`).
- CI workflows for lint, typecheck, unit tests, integration tests, `.deb` build,
  npm audit and dependency review.
- Architecture and threat model documentation.
- Appstore: browse, search and filter the catalog (CasaOS AppStore protocol v2),
  app details with screenshots, release notes and links, and a configurable
  catalog source (https only).
- Catalog fetching through the Cockpit bridge with TLS validation, size limits
  and strict JSON schema validation; validated catalog cache in `~/.cache/pitstore`.
- Strict Compose parsing (single document, no custom tags, alias limit) and
  interpolation with a closed variable set.
- Security policy for catalog Compose files, in the UI and in the helper, with
  shared test vectors: privileged mode, host namespaces, capabilities, devices,
  security options, kernel sysctls and mounts of runtime sockets or system
  directories are blocked by default.
- Install, update, remove, open, start, stop and restart apps from the Appstore,
  on rootless Podman, system Podman (administrative access) or Docker.
- `pitstore-helper`: server-side validation of every install (policy,
  confirmations, ports, paths, environment, images) before the runtime API
  is called; generated secrets; per-app confirmation records.
- Read-only mounts of `/etc/localtime` and `/etc/timezone` are allowed.
- Icons and screenshots are validated (magic bytes, size, SVG filter) and shown
  as data: URLs.
- Appstore: one overview of several catalogs. Four known catalogs in the same
  format are enabled by default and can be switched off; your own catalogs can
  be added. An app offered by several catalogs is shown once, and its details
  let you choose the catalog to install it from. A catalog filter and the
  catalog name on every card show where an app comes from.
- Dashboard: a settings button on every app tile shows what the app runs with
  and lets you change its settings (ports, folders, variables) or remove it.
- Dashboard: other apps on this server (containers PitStore did not install)
  are listed. *Take over…* analyses them and shows every finding with its
  possible corrections; an app is taken over as it is, or recreated with the
  same images, folders and volumes and rolled back on failure. Apps taken
  over as they are can be released again.

### Changed

- Docker: the Engine API version is negotiated with the daemon (1.44 or newer).

### Fixed

- Generated passwords are applied consistently to every variable, URL and
  command that uses the same catalog placeholder (an app could not reach its
  own database).
- Removing a rootless app with its data failed when a container had created
  files as another user (for example a database); errors are reported without
  a traceback.
- Taglines up to 2000 characters are accepted (some catalogs use long ones).
- App metadata with an empty thumbnail or per-language tips is accepted.
- Page sections had no side padding and cards no border, and wide screens
  kept an empty sidebar column (mismatched PatternFly packages).
