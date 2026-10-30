# PitStore threat model

Status: design (phase 1). Method: data-flow diagram with trust boundaries,
then STRIDE per boundary. Components and flows are defined in
[architecture.md](architecture.md).

## 1. Assets

| Asset | Why it matters |
|---|---|
| Host root | Any container escape or privileged container equals full host compromise. |
| Cockpit session / superuser | Gives shell-level control of the host. |
| App data (`<data root>/<id>`) | User data such as photos and documents. |
| App secrets (`secrets.env`) | Generated passwords and keys of installed apps. |
| Runtime sockets | Write access to these sockets means root (system Podman or Docker) or the user's account (rootless). |
| Catalog integrity | Decides which images and options run on the host. |
| Cockpit availability | PitStore must never break existing Cockpit pages. |

## 2. Actors

* **Admin user**: authenticated through Cockpit (PAM), may or may not
  have superuser rights. Trusted to make decisions, but can be tricked by the UI.
* **Catalog publisher**: the maintainers of the configured store, plus
  anyone who can change what that URL serves (CDN, DNS, compromised
  maintainer account). Treated as **untrusted**.
* **Image publisher**: the authors of container images referenced by the
  catalog. Untrusted. PitStore cannot verify image contents.
* **Network attacker**: can observe or modify traffic between the browser
  and Cockpit, or between the host and the catalog.
* **Malicious web content**: other origins in the user's browser, and
  content inside apps that PitStore opens.
* **Local unprivileged user** on the host.

## 3. Trust boundaries

```
 [TB1] Browser  ⇄  cockpit-ws        (WebSocket over TLS, Cockpit session cookie)
 [TB2] cockpit-ws ⇄ cockpit-bridge   (session user; superuser via sudo/polkit)
 [TB3] bridge ⇄ pitstore-helper      (spawned process, JSON over stdin/stdout)
 [TB4] helper ⇄ runtime socket       (HTTP over AF_UNIX; root for system/Docker)
 [TB5] bridge ⇄ external catalog     (HTTPS to store host / CDN)
 [TB6] containers ⇄ host             (kernel isolation, mounts, published ports)
```

### TB1 – Browser ⇄ cockpit-ws

Unchanged Cockpit behaviour: TLS, PAM login, session cookie, and an
origin check on the WebSocket. PitStore adds no endpoint, port or login.

| Threat (STRIDE) | Mitigation | Test |
|---|---|---|
| XSS through catalog text (S/T/E): app titles, Markdown descriptions, release notes | React escapes text by default. Markdown is rendered with a minimal, owned renderer to PatternFly components, with no `dangerouslySetInnerHTML` (enforced by an ESLint rule). Links get `rel="noopener noreferrer"` and only `https:` hrefs are allowed. | Unit test with hostile `meta.json` fixtures. A lint rule fails the build on `dangerouslySetInnerHTML`. |
| Script injection through icons/images (T/E) | Cockpit default CSP (`img-src 'self' data:`, no inline scripts, no eval) is kept, and the manifest has no CSP override. Icons are proxied through the bridge, validated (type, size, SVG filter) and shown as `data:` URLs. Schema validators are generated at build time, so no runtime eval is needed; `test/check-bundle.js` rejects bundles with `eval`/`new Function`. | Test that `manifest.json` has no `content-security-policy` key. A VM test reads the response headers of `dashboard.html`/`appstore.html` and compares them to Cockpit's default. Unit tests for the SVG filter. |
| Tab-nabbing / opener abuse when opening apps (T) | `window.open(url, "_blank", "noopener,noreferrer")`. The URL is built from validated parts: scheme `http`/`https`, port, and an index path that must start with `/`. | Unit test for the URL builder. |
| Clickjacking (T) | Cockpit's own frame protections. PitStore pages only render inside the Cockpit shell. | – |

### TB2 – cockpit-ws ⇄ cockpit-bridge (superuser)

| Threat | Mitigation | Test |
|---|---|---|
| Privileged action without consent (E) | Every root action uses `superuser: "require"` on the channel. Cockpit then uses the admin's configured sudo/polkit. Without superuser, the UI offers only rootless Podman. | VM test: with limited access, a system-scope install fails cleanly. |
| PitStore escalating outside Cockpit (E) | No setuid binaries, no sudoers drop-in, no polkit rule, no systemd unit in the package. | lintian plus a file list check of the `.deb` in CI. |

### TB3 – bridge ⇄ pitstore-helper

The frontend is client-side code. A modified browser, a malicious extension
or an XSS can send any JSON to the helper. The helper therefore treats its
stdin as untrusted.

| Threat | Mitigation | Test |
|---|---|---|
| Command injection (T/E) | The helper is spawned with a fixed argv. User data goes only in the JSON on stdin. The helper itself spawns no processes: runtime access is HTTP over a socket. | A test greps the code for `subprocess`/`os.system` (only allowed in tests). A Python test checks that argv is fixed. |
| Policy bypass by sending a crafted plan (E) | The helper re-runs schema validation and the full policy. Blocked findings need a confirmation record bound to `compose_sha256` and the finding id. | Shared policy vectors. A helper test checks that a `privileged: true` plan is rejected without a record, accepted with a matching record, and rejected with a record for another hash. |
| Path traversal in data paths (T/E) | Paths are normalized and resolved with `realpath`, checked against the sensitive list and allowed roots, and created with `O_NOFOLLOW` semantics. Deleting is limited to `<data root>/<id>`. | Unit tests with `..`, symlinks, `//`, NUL and very long paths. |
| Large input / DoS (D) | The request size limit is 1 MiB, with limits on service count, string lengths and recursion depth. | Unit test. |

**Residual risk, stated plainly:** an admin who has superuser in Cockpit can
already run anything (terminal, `podman run --privileged`). The helper's
checks protect against untrusted *catalog content* and against injection
through the browser. They do not protect against the authenticated admin.

### TB4 – helper ⇄ runtime socket

| Threat | Mitigation | Test |
|---|---|---|
| Request smuggling or path injection into API URLs (T) | Every path segment is percent-encoded with `quote(safe="")`, bodies are serialized with `json.dumps`, and container names come from validated ids. | Unit tests against a fake socket that records the raw requests. |
| Acting on containers PitStore did not create (T) | All lifecycle verbs first filter by the `io.pitstore.app=<id>` label and refuse IDs without it. | Helper test. VM test: a container not created by PitStore cannot be stopped through PitStore. |
| Wrong socket, a lookalike socket planted by a local user (S) | System sockets are fixed paths under `/run`. The rootless path comes from the helper's own `XDG_RUNTIME_DIR` and must be owned by the uid and mode 0600/0660. | Unit test for the ownership check. |

### TB5 – bridge ⇄ external catalog

| Threat | Mitigation | Test |
|---|---|---|
| MITM / tampering in transit (T) | HTTPS only, with system CA validation (the bridge's `ssl.create_default_context()`). `tls.validate: false` is never set. | Unit test that settings reject `http://`. VM test against a host with a self-signed certificate fails. |
| Malicious or compromised catalog (T/E) | Strict JSON schema and size limits, and a strict YAML parser (single document, no custom tags, alias limit). Unknown compose keys make the app unsupported. The security policy blocks dangerous options. The user sees the images and the published ports before installing. | Schema tests, YAML bomb test (billion laughs), policy vectors. |
| Hidden changes in an update (T) | Updates re-run the policy. New findings need new confirmation. A changed compose hash invalidates old confirmations. The UI shows the image/port/mount diff. | Helper test: an update adding `cap_add` is refused without confirmation. |
| Placeholder secrets in catalog (I) | Secret-like env keys are flagged and replaced with random values. `DefaultPassword` becomes random per app, not the CasaOS default `casaos`. | Unit test for detection. Helper test that `secrets.env` is 0600 and not in the plan echo. |
| Tracking / privacy (I) | Catalog fetches go from the host, not the browser. No telemetry. Screenshots load only on demand. | – |
| Catalog outage (D) | The last good cache is kept, with a clear error state. | Unit test. |
| Image supply chain (T) | Out of PitStore's control. The UI shows the image reference and highlights references without a tag or with `:latest`. | – (documented residual risk) |

### TB6 – containers ⇄ host

| Threat | Mitigation | Test |
|---|---|---|
| Container escape through privileged options (E) | Blocked by default: `privileged`, host namespaces (`net`, `pid`, `ipc`, `uts`, `userns`, `cgroup`), `cap_add`, `devices`, `security_opt` exceptions, non-namespaced `sysctls`. | Policy vectors for each option, plus a done-criterion test for `privileged: true`. |
| Host takeover through mounts (E) | Mounts of `docker.sock`, `podman.sock` and `containerd.sock` are blocked, as are `/`, `/etc`, `/root`, `/var/run`, `/run`, `/proc`, `/sys`, `/dev`, `/boot` and the runtime data dirs, including any path below them after `realpath`. | Policy vectors, including symlink tricks (helper test with a temporary directory). |
| Exposing services unexpectedly (I) | Published ports are shown and editable before install. Conflicts with ports in use and with 9090 are refused. Rootless Podman cannot bind ports below 1024. | Unit tests. VM `ss -tlnp` before and after an app install. |
| Breaking Cockpit (D) | No files outside `/usr/share/cockpit/pitstore/`, and port 9090 is refused for apps. | VM test: all standard Cockpit pages load before and after install and removal. |

## 4. Logging and secrets

* The helper writes progress and errors as structured JSON. Env values are
  never included. Before an error goes back to the UI, env values and
  anything matching the secret key pattern are redacted.
* The catalog cache contains only catalog documents. User settings contain
  no credentials. Registry credentials are not supported in v1.
* Nothing is written to the system journal except what Cockpit itself logs
  for the superuser session.

## 5. Out of scope

* Vulnerabilities in Cockpit, Podman, Docker, the kernel or container images.
* An admin deliberately confirming a dangerous option. The warning plus
  the explicit per-finding confirmation is the control.
* Apps that CasaOS itself installed on the same host.
