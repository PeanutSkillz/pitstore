# Contributing to PitStore

Thanks for your interest! This document explains how to propose changes.

## Ground rules

* PitStore adds exactly two pages to Cockpit, **Dashboard** and **Appstore**.
  Features that Cockpit already provides (files, storage, users, networking,
  logs, metrics, generic container management) are out of scope.
* No daemon, no listening port, no own login: everything goes through the
  Cockpit session and bridge.
* The Cockpit Content-Security-Policy must stay unchanged: no inline scripts,
  no `eval`, no external resources.
* Never build shell command strings. Talk to the container runtime through
  its API socket, and pass data as structured JSON.
* Do not use CasaOS logos or trademarks.
* Code, comments and commit messages are in English.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

See the "Development" section in the [README](README.md). In short:

```sh
make          # build
make check    # lint, typecheck, unit tests
```

Test installations belong in a VM, not on your workstation or a server.

## Dependencies

New runtime or development dependencies need a short justification in the
pull request (why it is needed, its license, its maintenance status).
`package-lock.json` is committed and must be updated in the same pull request.
CI runs `npm audit` and a dependency review.

## Pull requests

1. Fork the repository and create a topic branch.
2. Keep each pull request focused on one change.
3. Add or update tests. Security-relevant changes (policy filter, input
   validation, helper) **must** come with tests.
4. Run `make check` locally.
5. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
6. Sign off your commits (`git commit -s`) to certify the
   [Developer Certificate of Origin](https://developercertificate.org/).

By contributing, you agree that your contribution is licensed under the
project license, LGPL-2.1-or-later.

## Reporting bugs

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md)
and do **not** open a public issue.
