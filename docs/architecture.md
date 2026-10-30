# PitStore architecture

Status: design (phase 1). Nothing in this document is implemented yet.
Sources studied (shallow clones, 2026-10-29):

| Repository | Commit | License (verified) |
|---|---|---|
| cockpit-project/cockpit | `2034c57` | LGPL-2.1-or-later, parts GPL-3.0-or-later, MIT, BSD-3-Clause, CC-BY-SA-3.0 (`LICENSES/`, `tools/cockpit.spec`) |
| cockpit-project/starter-kit | `f34666e` | LGPL-2.1 (`LICENSE`, `package.json`) |
| cockpit-project/cockpit-podman | `5f44f2f` | LGPL-2.1 (`LICENSE`, SPDX `LGPL-2.1-or-later` headers) |
| IceWhaleTech/CasaOS | `0d3b2f4` | Apache-2.0 (`LICENSE`, no `NOTICE` file) |
| IceWhaleTech/CasaOS-UI | `400a22c` | Apache-2.0 (`LICENSE`, no `NOTICE` file) |
| IceWhaleTech/CasaOS-AppManagement | `debfa31` | Apache-2.0 (`LICENSE`, no `NOTICE` file) |
| IceWhaleTech/CasaOS-AppStore | `9619b70` | Apache-2.0 (`LICENSE`, no `NOTICE` file) |

PitStore copies no CasaOS code. It reimplements the *store protocol* from the
public specification in `CasaOS-AppStore/docs/specs/`. Catalog content (compose
files, icons, screenshots) is downloaded at runtime and never bundled.

## 1. Goals and non-goals

PitStore adds exactly two Cockpit pages:

* **Dashboard**: tiles for installed apps (status, open, start, stop,
  restart) plus a compact system summary (CPU, memory, disk usage of the
  data root, uptime).
* **Appstore**: browse, search, filter by category, show details, install,
  update and remove apps from a store that speaks the CasaOS-AppStore v2
  protocol.

Non-goals: file manager, storage management, users, networking, general
system monitoring, terminal, logs, generic container management. Cockpit
(and cockpit-podman, if the user installs it) already provide those. The
dashboard links to the existing Cockpit pages instead of duplicating them.

Hard constraints (from the project brief): Cockpit is not modified, no
daemon, no listening port, no own login, all access through the Cockpit
session and bridge, Podman by default and Docker optional.

## 2. Components

```
 Browser (Cockpit shell iframe, CSP-restricted)
 ┌──────────────────────────────────────────────────────────────┐
 │ pitstore/index.html  ─ React + PatternFly 6 (starter-kit)    │
 │   pages/Dashboard     pages/Appstore                          │
 │   lib/catalog   (fetch via bridge, schema validation, cache)  │
 │   lib/compose   (YAML → typed model, x-casaos extraction)     │
 │   lib/policy    (security filter; UI preview only)            │
 │   lib/helper    (typed RPC to pitstore-helper)                │
 └──────────────┬───────────────────────────────────────────────┘
                │ cockpit.js channels over the Cockpit WebSocket
 cockpit-ws ────┤ (TLS, PAM session; unchanged)
                ▼
 cockpit-bridge (runs as the logged-in user, or as root through the
                 superuser mechanism; unchanged)
   │ http-stream2 (TLS) ──────────────► catalog host (HTTPS only)
   │ fsread1/fsreplace1 ──────────────► ~/.cache/pitstore/ (catalog + icon cache)
   │ stream (spawn, argv array, JSON on stdin)
   ▼
 pitstore-helper  (/usr/share/cockpit/pitstore/helper/pitstore-helper,
                   Python 3 stdlib, short-lived, one request per process)
   │ validates the install plan (authoritative policy), state files
   │ HTTP over AF_UNIX
   ▼
 Runtime API socket
   Podman rootless: $XDG_RUNTIME_DIR/podman/podman.sock   (user)
   Podman system:   /run/podman/podman.sock               (superuser)
   Docker:          /run/docker.sock                      (superuser)
```

### 2.1 Frontend (`src/`)

Built from starter-kit: React 18, PatternFly 6, TypeScript, esbuild, the
Cockpit `pkg/lib` helpers pulled at a pinned commit by the starter-kit
Makefile. JSON schemas (`schemas/*.schema.json`) are compiled to plain
validator functions at build time with Ajv's standalone mode
(`schemas/generate.js`), because Ajv's normal runtime compilation uses
`new Function`, which the CSP forbids; `test/check-bundle.js` fails the
build if a bundle contains `eval` or `new Function`. `manifest.json` registers two entries under `tools` (menu
"Tools" section), labelled **Dashboard** and **Appstore**, each with its own
HTML entry point (`dashboard.html`, `appstore.html`). No existing Cockpit
page is replaced, and no `content-security-policy` override is set in the
manifest, so Cockpit's default policy applies unchanged:

```
default-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self';
object-src 'none'; font-src 'self' data:; img-src 'self' data:;
block-all-mixed-content
```
(from `src/cockpit/packages.py:get_content_security_policy`)

Consequences: no inline scripts, no eval (esbuild output only), no external
scripts, and images only from the package itself or `data:` URLs. App icons
are therefore fetched by the bridge, validated, cached, and rendered as
`data:` URLs (section 5).

### 2.2 pitstore-helper (`helper/`)

The brief requires validation on the *server side* before the runtime is
called, and forbids a daemon or port. The only server-side code that can run
without a daemon is a process the bridge spawns for one request. This is
the pattern cockpit-podman already uses (`src/detect-quadlets.py`).

* Python 3 standard library only. No shell: invoked as
  `cockpit.spawn(["/usr/share/cockpit/pitstore/helper/pitstore-helper", "<verb>"], {superuser?, err: "message"})`
  with a JSON request on stdin and a JSON response on stdout. No argument
  ever contains user data; all user data travels in the JSON body.
* Verbs: `install`, `update`, `remove`, `start`, `stop`, `restart`,
  `list`, `inspect`, `preflight` (dry-run validation, returns the policy
  verdict). Each call is one process; nothing stays resident.
* The helper is the **authoritative** enforcement point. It receives the
  normalized install plan (section 4), validates it against the JSON policy
  (section 6) and the per-app confirmation record, and only then talks to the
  runtime socket. The frontend runs the same policy only to render warnings.
  Both implementations run against one shared set of fixture files in
  `test/policy-vectors/`, so they cannot drift silently.
* Privilege: for rootless Podman the helper runs as the session user. For
  the system Podman socket or Docker it is spawned with
  `superuser: "require"`, so root is reached *only* through Cockpit's
  superuser mechanism (sudo/polkit as configured by the admin). The helper
  never calls sudo itself.

Python is available wherever the bridge is: `cockpit-bridge` 314 depends on
`python3:any`. Cockpit 264 (Ubuntu 22.04 main) still has the C bridge. See
open question Q1.

### 2.3 Persistent state

| Data | Rootless Podman | System Podman / Docker | Contents |
|---|---|---|---|
| Catalog cache | `~/.cache/pitstore/catalog/` | same (per Cockpit user) | `index.json`, `store.json`, per-app `meta.json` + compose, keyed by `content_hash` |
| Settings | `~/.config/pitstore/settings.json` | same | store URL, preferred backend, locale |
| App state | `~/.local/share/pitstore/apps/<id>/` | `/var/lib/pitstore/apps/<id>/` | `plan.json` (the applied plan), `confirmations.json`, `secrets.env` (mode 0600) |
| App data | `~/.local/share/pitstore/data/<id>/` | `/var/lib/pitstore/data/<id>/` (configurable data root) | bind-mount sources |

Containers, networks and volumes created by PitStore carry labels
`io.pitstore.app=<id>`, `io.pitstore.service=<name>`,
`io.pitstore.version=<x-casaos.version>`. The dashboard lists apps by
these labels, so it reflects the runtime truth, not only the state files.

## 3. Data flows

### 3.1 Catalog refresh (Appstore page)

1. Read settings: `store_url`, default
   `https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages`
   (verified: serves `index.json` 120 896 bytes, 180 apps, `version: 2`,
   on 2026-10-29). Only `https://` URLs are accepted.
2. `cockpit.http({address, port: 443, tls: {}})` with system CA
   validation (bridge uses `ssl.create_default_context()`). GET
   `store.json` and `index.json`, with size limits (index ≤ 4 MiB) and
   a timeout.
3. Validate both against the JSON schemas `schemas/store.schema.json` and
   `schemas/index.schema.json` (strict: required fields, types, string
   length caps, `id` pattern `^[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+$`,
   relative paths must start with `/apps/<id>/`, no `..`). Invalid entries
   are dropped and reported. If the whole document is invalid, the last
   good cache is kept.
4. Compare `content_hash` per app with the cache. Fetch `meta.json` lazily
   when the detail view opens, and the compose file only when the user
   presses Install or Update.
5. Write the cache through `cockpit.file(..., {syntax: JSON}).replace()`.
   The cache contains catalog data only: no user input and no secrets.

### 3.2 Install

1. Fetch the built compose `apps/<id>/docker-compose.yml` (≤ 256 KiB),
   parse it with a strict YAML parser (no custom tags, no merge keys from
   other documents, single document, alias count limit) into a typed
   `ComposeModel` (section 4).
2. Run `policy.evaluate(model)` in the UI. Render the install dialog with
   editable ports, data paths and environment variables, and a risk
   panel for every blocked option (section 6).
3. User edits values. For each blocked finding the user must tick a
   per-finding checkbox and confirm in a second, danger-styled dialog. This
   creates the confirmation record `{app_id, compose_sha256, finding_ids, user, time}`.
4. The frontend builds the **install plan** (plain JSON, no YAML) and sends
   it with the confirmation record to `pitstore-helper install`.
5. The helper re-validates everything (schema, policy, confirmations bound
   to the exact compose hash, port/path/env rules), generates secrets
   (section 4.4), creates data directories, and then calls the runtime:
   pull images → create network → create containers (labels, restart
   policy) → start in dependency order. Progress lines are streamed as
   JSON on stdout.
6. On failure, the helper rolls back the objects it created in this run.

### 3.3 Update

Triggered when the catalog `version`/`content_hash` differs from
`io.pitstore.version`/stored hash. The new compose goes through the full
install validation again. The policy diff is shown: *new* blocked
findings need a new confirmation, and old confirmations do not carry over to
a changed compose hash. The helper pulls the new images, then recreates the
containers. Data directories and `secrets.env` are kept.

### 3.4 Remove

The helper stops and removes the containers and network with the app label.
Data is kept by default. Deleting data is an explicit, separate checkbox,
and only paths under the app's own data dir are ever deleted.

### 3.5 Dashboard

* App list: helper `list` → runtime `GET /containers/json?all=true&filters={"label":["io.pitstore.app"]}`,
  grouped by app id. Status = worst of the service states. A running
  `main` service with a healthy or absent healthcheck counts as *running*.
* Open: `scheme://<host>:<port_map><index>`, where `<host>` is the host
  name the browser used for Cockpit (`window.location.hostname` of the
  top window via `cockpit.transport.origin`). It opens in a new tab with
  `rel="noopener noreferrer"`.
* Start / stop / restart: helper verbs → runtime
  `POST /containers/{id}/start|stop|restart` for each container of the app.
* System summary: `cockpit.metrics` (CPU, memory, `pcp`-less "internal"
  source as cockpit uses it), `cockpit.file("/proc/uptime")`, and
  `df` of the data root via the helper (statvfs, no subprocess). Each card
  links to the matching Cockpit page (`/system`, `/storage`, `/metrics`).

## 4. Translating the x-casaos format

### 4.1 Protocol v2 (verified from `docs/specs/*.md` and the live store)

* `store.json`: `{version: 2, store_id, name, description?, maintainer, url?, icon?}`.
  On the live endpoint `name` is already resolved to a string per locale
  file (`store.{locale}.json`).
* `index.json`: `{version: 2, updated_at, app_count, base_url, apps: [...]}`.
  Each app has `id, title, tagline, category, categories[], author, developer, architectures[], icon, thumbnail, compose_url, meta_url, content_hash, version`.
  Paths are relative to `base_url`.
* Built compose: standard Compose plus top-level `x-casaos` with only
  `id, main, index, port_map, scheme, icon, title, version`.
* `meta.json`: `tagline, description (Markdown), thumbnail, screenshot_link[], tips, author, developer, category, architectures, version, update_at, release_note, website, repo, support, docs`.
* Optional `docker-compose.{arch}.yml` per architecture.
* Service-level `services.<s>.x-casaos` (port, volume and env
  descriptions) is called "legacy, removed during v2 build" in the spec,
  but the source repo still contains it. PitStore reads it when present
  and ignores it when absent.

Not verifiable from the sources: (a) whether `categories[]` (lower-case,
present in the live index) is part of the contract. The spec only documents
`category`. (b) The exact interpolation variables the official client
supports in v2. The values below come from the CasaOS-AppManagement code,
which still consumes the **v1** zip (`app-management.conf.sample`).
PitStore treats both as best effort and documents them.

Checked against the live catalog on 2026-10-30 (180 apps): all entries pass
the schemas and all built Compose files parse. Observed deviations from the
spec that PitStore accepts: `thumbnail: ""` (87 apps), missing `version`
(3), missing `x-casaos.main` for single-service apps (8; the only service is
used), `port_map: ""` or missing (5; the app has no web UI), `index: null`
(1) and `scheme: ""` (2; treated as http). Variables outside the CasaOS set
(for example `$OPENAI_ACCESS_TOKEN`) are values the user must provide; they
become install-time inputs. Policy result: 126 apps clean, 39 with blocked
options that need confirmation, 15 unsupported (GPU reservations, alternative
runtimes, Compose configs/profiles, `group_add`, network `ipam`).

### 4.2 Supported Compose subset

PitStore does not run `docker compose` or `podman-compose`: no shell,
and neither is a Cockpit dependency. It translates a whitelisted subset
into runtime API calls. Unknown keys make the app *unsupported*: it is shown
in the store, but Install is disabled with a reason. Keys are never silently
ignored.

| Compose key | Translation |
|---|---|
| `name` | project name, must equal the sanitized app id |
| `services.<s>.image` | pull + container image (digest pinning shown if present) |
| `container_name` | ignored; PitStore names containers `pitstore-<id>-<service>` to avoid collisions |
| `command`, `entrypoint` | list form or string form (split with a POSIX-like tokenizer into an argv list; never passed to a shell) |
| `environment` (map or list), `env_file` (rejected) | env map |
| `ports` (short and long syntax) | `portmappings` / `PortBindings`; `published` editable |
| `volumes` (bind / named volume / short syntax) | bind → path policy; named → runtime volume `pitstore-<id>-<name>` |
| `restart` | restart policy |
| `depends_on` (list or map with `condition`) | start order; `service_healthy` waits for health |
| `healthcheck` | health config |
| `network_mode: bridge` or absent | per-app network `pitstore-<id>` with DNS aliases = service names |
| `user`, `working_dir`, `hostname`, `labels`, `tty`, `stdin_open`, `stop_signal`, `stop_grace_period`, `shm_size`, `ulimits`, `sysctls` (namespaced only) | direct mapping |
| `deploy.resources.limits/reservations` (memory, cpus) | resource limits |
| `privileged`, `network_mode: host`, `pid: host`, `ipc: host`, `cap_add`, `devices`, `security_opt`, `userns_mode: host`, `cgroup: host`, `uts: host` | blocked by default (section 6) |
| `build`, `extends`, `include`, `configs`, `secrets`, `profiles` | unsupported |

### 4.3 Variable interpolation

Compose interpolation (`$VAR`, `${VAR}`, `${VAR:-default}`, `$$`) is
implemented as a pure function over strings, with a closed variable set:

| Variable | Value in PitStore | CasaOS original (AppManagement `common/constants.go`) |
|---|---|---|
| `AppID` | app id (sanitized) | app id |
| `PUID` / `PGID` | uid/gid of the runtime owner (rootless: session user; system: configurable, default 1000) | `1000` |
| `TZ` | host time zone (`/etc/timezone` via `cockpit.file`) | system time zone |
| `DefaultUserName` | `admin` | `admin` |
| `DefaultPassword` | **random per app**, 24 chars, generated by the helper, stored in `secrets.env` (0600), shown once in the UI | **fixed string `casaos`** |

An unknown variable makes the app *unsupported*. It is never replaced by an
empty string.

Path mapping: `/DATA/AppData/$AppID/...` → `<data root>/<id>/...`.
Other `/DATA/<x>/...` sources (for example `/DATA/Media`) need a host path
chosen by the user in the install dialog. The default is
`<data root>/shared/<x>`.

### 4.4 Secrets in catalog compose

The catalog ships literal placeholder secrets (verified: `2FAuth` has
`APP_KEY: SomeRandomStringOf32CharsExactly`). Environment keys matching
`/(PASS(WORD)?|SECRET|TOKEN|KEY|SALT)$/i` are flagged in the install dialog.
The helper replaces such values with a random value unless the user enters
one. These values go to `secrets.env` and the container env, and never to the
catalog cache, the plan stored for display, logs or helper stderr.

## 5. Icons and images

`<img>` may only load `'self'` or `data:`. The flow is:

1. The frontend asks the bridge (`cockpit.http`, TLS) for the icon URL. Only
   URLs under the configured `base_url` host, or a host on an explicit
   allow-list in settings, are fetched.
2. Validation: size ≤ 512 KiB, magic bytes must match PNG, JPEG, WebP or
   SVG, and the declared Content-Type must agree. SVG is accepted only if a
   strict parser finds no `<script>`, `<foreignObject>`, `on*` attributes,
   `javascript:`/external `href`, `<!ENTITY` or `<use>` to other documents.
   Otherwise the SVG is rejected and a placeholder icon is used. (`data:`
   SVG in `<img>` cannot run script in browsers anyway. The filter is
   defense in depth.)
3. The validated bytes are rendered as a `data:<type>;base64,…` URL and kept
   in memory for the session (`src/lib/catalog/catalog.ts`). Every new
   session fetches and validates again; nothing unvalidated is ever stored.

Screenshots use the same path, but are fetched only when the detail view
opens.

## 6. Security policy (compose filter)

Implemented twice, with the shared vectors in `test/policy-vectors/compose.json` as the spec:
`src/lib/policy.ts` (UI preview) and `helper/pitstore/policy.py`
(authoritative). Each finding has a stable id, a severity and a fixed
English warning text.

Blocked by default (finding ids in brackets):

* `privileged: true` [`privileged`]
* `network_mode: host` [`net-host`], `pid: host` [`pid-host`],
  `ipc: host` [`ipc-host`], `uts/userns_mode/cgroup: host` [`ns-host`]
* any `cap_add` entry [`cap-add:<CAP>`]
* any `devices` entry [`device:<path>`]
* any `security_opt` entry other than `no-new-privileges:true`
  [`security-opt:<value>`]
* bind mounts of the runtime sockets: `docker.sock`, `podman.sock`,
  `containerd.sock`, anywhere in the path [`mount-runtime-socket`]
* bind mount sources `/`, `/etc`, `/root`, `/var/run`, `/run`, `/proc`,
  `/sys`, `/dev`, `/boot`, `/var/lib/docker`, `/var/lib/containers`, and
  anything below them [`mount-sensitive:<path>`]. Paths are normalized
  first: interpolation, then `..` resolution and symlink resolution in the
  helper (`os.path.realpath` before the directory is created).
* `sysctls` outside `net.*` namespaced keys [`sysctl`]

Always rejected (no override): `build`, `env_file`, absolute or `..`
paths inside named volume names, relative bind sources outside the
app data dir, published port 0 or > 65535, published ports that conflict
with ports already in use, `9090` (Cockpit), and ports < 1024 for rootless.

Confirmation records are stored per app in `confirmations.json`:
`{compose_sha256, findings: [ids], confirmed_by, confirmed_at}`. The helper
refuses a plan that contains a blocked finding without a matching record
for the same compose hash. A test proves that a compose with
`privileged: true` is refused without confirmation (done-criterion).

Input validation in the helper:

* ports: integer 1–65535, `tcp`/`udp` only, no duplicates.
* paths: absolute, normalized, no NUL, length ≤ 4096, not in the
  sensitive list, must exist or be creatable under an allowed root.
* env: key `^[A-Za-z_][A-Za-z0-9_]*$`, value is a string without NUL, ≤ 32 KiB.
* app id: the pattern above, ≤ 128 chars. Image references are checked
  against the Docker reference grammar.

## 7. Runtime abstraction

```python
class Runtime(Protocol):           # helper/pitstore/runtime/base.py
    def ping(self) -> Info
    def pull(self, image: str, progress: Callable) -> None
    def ensure_network(self, name: str, labels: dict) -> str
    def create_volume(self, name: str, labels: dict) -> str
    def create_container(self, spec: ContainerSpec) -> str
    def start(self, cid: str) / stop(cid, timeout) / restart(cid)
    def remove_container(self, cid: str, force: bool)
    def remove_network(self, name: str) / remove_volume(name)
    def list_containers(self, label: str) -> list[ContainerInfo]
    def inspect(self, cid: str) -> ContainerInfo
```

* `ContainerSpec` is a runtime-neutral dataclass produced from the
  validated plan (image, cmd, entrypoint, env, ports, mounts, network,
  aliases, restart, health, resources, labels, user).
* `PodmanRuntime` uses the libpod REST API (`/v4.0.0/libpod/...`)
  on the system or rootless socket. Ubuntu 24.04 ships Podman 4.9.3 with
  netavark + aardvark-dns (verified in casa-test), so a per-app network
  gives DNS by service name. Ubuntu 22.04 ships Podman 3.4.4 (CNI). DNS
  there needs the `dnsname` plugin, which is not verified (Q3).
* `DockerRuntime` uses the Docker Engine API (`/v1.41/...`, the oldest
  version shipped by supported Ubuntu `docker.io` packages; to verify in
  phase 4) on `/run/docker.sock`. It is only offered when that socket exists.
* Transport: `http.client.HTTPConnection` with an `AF_UNIX` socket, JSON
  bodies built from dicts, and URL path segments percent-encoded with
  `urllib.parse.quote(..., safe="")`. No string-built commands anywhere.

Backend selection, per app and stored in `plan.json`: rootless Podman
(default) → system Podman (needs superuser; required for ports < 1024 or
when the user picks it) → Docker (if configured).

## 8. Packaging

* Debian source in `debian/` (debhelper-compat 13, `Architecture: all`),
  installing to `/usr/share/cockpit/pitstore/`.
  `Depends: cockpit-ws (>= X), cockpit-bridge (>= X)`, `Recommends: podman`,
  `Suggests: docker.io`. The minimum Cockpit version X is decided in Q1.
* No maintainer scripts that start services. Removing the package removes
  only `/usr/share/cockpit/pitstore`. Containers and data of installed apps
  are left alone (documented), and `/var/lib/pitstore` is removed only on
  `purge`, after a warning in README.
* lintian must be clean (CI gate).
* APT repository: `reprepro`- or `aptly`-style static tree on GitHub
  Pages, signed with a dedicated OpenPGP key. Users install the key into
  `/etc/apt/keyrings/` and use `signed-by=`. Phase 6.

## 9. Testing strategy

* Host (project dir only): `eslint`, `tsc --noEmit`, `stylelint`, unit
  tests for catalog schema, compose parser, interpolation and policy (TS:
  QUnit from starter-kit, run in Node). Helper: `python3 -m unittest`
  against a fake runtime socket served by a `socketserver.UnixStreamServer`
  in the test process.
* Shared policy vectors `test/policy-vectors/*.json`, run by both test
  suites.
* casa-test VM (restored to snapshot `clean` before every full install
  test): install the `.deb`, check the menu entries and existing Cockpit
  pages over HTTP/browser automation, run the app lifecycle against real
  Podman (rootless and system) and later Docker, `ss -tlnp` before and
  after, then remove the package and check Cockpit again.

## 10. Open questions (need a decision)

* **Q1 – minimum Cockpit / Python.** The helper needs Python 3. Ubuntu
  24.04 (`cockpit-bridge` 314, depends on `python3`) is fine. Ubuntu 22.04
  main has Cockpit **264** (C bridge, no python3 dependency), and
  `jammy-backports` has **360**. Proposal: `Depends: cockpit-bridge (>= 300)`,
  which means 22.04 users need backports. Alternative: also depend on
  `python3`. That breaks "depends only on Cockpit".
* **Q2 – YAML parser.** Not in starter-kit. The Python stdlib has no YAML.
  Proposal: parse YAML in the frontend with the `yaml` npm package (eemeli/yaml,
  ISC, no dependencies). The helper only accepts the resulting JSON plan.
  A JSON-schema validator (`ajv`, MIT) is also not in starter-kit. The
  alternative is hand-written validators. Both are new dependencies →
  approval needed.
* **Q3 – Podman 3.4 on 22.04.** Inter-service DNS on CNI needs the `dnsname`
  plugin. Fallback: run multi-service apps in a pod and add `/etc/hosts`
  entries for service names. Decide in phase 4 after testing a 22.04 VM,
  which would be a second VM and needs approval.
* **Q4 – Docker compatibility path.** Apps installed by CasaOS itself on the
  same host are not managed by PitStore (different labels). Out of scope
  unless requested.
