# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton based on cockpit-project/starter-kit.
- Empty Dashboard and Appstore pages in the Cockpit menu.
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
