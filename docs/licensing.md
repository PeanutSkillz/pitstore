# Licensing

PitStore is licensed under the **GNU Lesser General Public License, version 2.1
or (at your option) any later version** (LGPL-2.1-or-later). This is the same
license as Cockpit's `pkg/lib` and the starter-kit that PitStore is built from,
and those LGPL-2.1-or-later files are bundled into PitStore's JavaScript. Using
the same license keeps the combined work under one license, with no
relicensing questions. Apache-2.0 code (CasaOS) is not compatible with
LGPL-2.1-*only*, but it is compatible with LGPL-3.0. Because PitStore allows
"any later version", any Apache-2.0 code we might include in the future can
be combined under LGPL-3.0, provided its copyright notices, license text
and any NOTICE file are kept. At present PitStore contains **no CasaOS code**.
It implements the publicly documented AppStore protocol independently, and
downloads catalog content (Compose files, icons, screenshots) at runtime
without redistributing it. No CasaOS logos or trademarks are used.

## Verified upstream licenses (2026-10-29)

| Component | License | How it is used |
|---|---|---|
| Cockpit `pkg/lib` (commit `35a3018`) | LGPL-2.1-or-later | bundled into the JS |
| cockpit-project/starter-kit | LGPL-2.1 | `build.js`, `Makefile`, lint configs derived from it |
| cockpit-project/cockpit-podman | LGPL-2.1-or-later | studied only, no code copied |
| IceWhaleTech/CasaOS, CasaOS-UI, CasaOS-AppManagement, CasaOS-AppStore | Apache-2.0 (no NOTICE file present) | studied only, no code copied |
| PatternFly, React, focus-trap, tabbable | MIT | bundled into the JS/CSS |
| tslib | 0BSD | bundled into the JS |
| Contributor Covenant 2.1 (`CODE_OF_CONDUCT.md`) | CC BY 4.0 | text with attribution |

The full list of bundled third-party code is in `debian/copyright`.
