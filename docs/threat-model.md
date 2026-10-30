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
| App secrets (`secrets.json`) | Generated passwords and keys of installed apps. |
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
| Command injection (T/E) | The helper is spawned with a fixed argv. User data goes only in the JSON on stdin. Runtime access is HTTP over a socket. The helper runs one program itself: `/usr/bin/podman unshare rm -rf --one-file-system -- <path>`, only for rootless Podman when deleting an app's own data folder fails because a container created files owned by the user's sub-uids. The path comes from the validated app id, must resolve directly under the user's data root and is passed as one argv element after `--`. | `test_podman_unshare_is_the_only_process_the_helper_runs` scans the helper for process calls; `TestDeleteData` checks the exact argv and that other paths are refused. |
| Policy bypass by sending a crafted plan (E) | The helper re-runs schema validation and the full policy. Blocked findings need a confirmation record bound to `compose_sha256` and the finding id. | Shared policy vectors. A helper test checks that a `privileged: true` plan is rejected without a record, accepted with a matching record, and rejected with a record for another hash. |
| Path traversal in data paths (T/E) | Paths are normalized and resolved with `realpath`, checked against the sensitive list and allowed roots, and created with `O_NOFOLLOW` semantics. Deleting is limited to `<data root>/<id>`. | Unit tests with `..`, symlinks, `//`, NUL and very long paths. |
| Silent fallback from system to user scope (E/T) | Each request states its scope; the helper refuses `system` unless it runs as root (via superuser), and `user` when it runs as root. | Helper unit test `test_system_scope_never_falls_back_to_the_user`. |
| Interrupted install leaves unknown containers (D/T) | State is written before containers are created; failure restores the previous state; SIGHUP and a closed stdout are ignored. | Helper unit tests (`test_state_is_written_before_containers_are_created`, `test_failed_update_restores_the_previous_state`). |
| Large input / DoS (D) | The request size limit is 1 MiB, with limits on service count, string lengths and recursion depth. | Unit test. |

#### Taking over other apps (architecture §3.6)

| Threat | Mitigation | Test |
|---|---|---|
| Leaking credentials of foreign containers to the browser (I) | `foreign` and `analyze` return no environment values; credential variables are reported by name only. `plan.json` of a taken-over app stores no environment. | Helper tests `test_reconstruct_keeps_mounts_ports_and_hides_nothing_secret_in_output` and `test_in_place_changes_nothing_and_records_confirmation`; VM test checks the analysis dialog for a known password value. |
| Taking over silently legitimises a dangerous container (E) | The reconstructed configuration goes through the same policy as a catalog app. Every blocked option is a *decision*: the user must allow it (recorded as a confirmation) or remove it. | Helper test `test_risky_option_needs_a_decision`; VM test with a `--privileged` container. |
| Crafted choices from a modified browser (T/E) | The helper re-runs the analysis and accepts only check and correction ids it produced itself; ports must be numbers in range and free; recreate is refused with anonymous volumes or unsupported settings that are kept. | Helper tests, including a port value `80; rm -rf /`. |
| Data loss while recreating (D/T) | Same image ID (no pull), same bind mounts and named volumes; the old containers are only renamed until the new ones run, restored on any failure, and deleted with `v=false`. Recreate is refused when data lives in an anonymous volume. | Helper tests for recreate, rollback and the anonymous-volume refusal; VM test with Docker (`adopt.py`). |
| Catalog update replacing a taken-over app (T/D) | The helper refuses an install or update for an app id whose plan is a takeover. | Helper test `test_taken_over_app_is_not_updated_from_the_catalog`. |
| Another tool keeps managing the app (T) | Shown as a warning in the analysis. PitStore cannot stop another tool from changing the containers. | – (documented residual risk) |

**Residual risk, stated plainly:** an admin who has superuser in Cockpit can
already run anything (terminal, `podman run --privileged`). The helper's
checks protect against untrusted *catalog content* and against injection
through the browser. They do not protect against the authenticated admin.

### TB4 – helper ⇄ runtime socket

| Threat | Mitigation | Test |
|---|---|---|
| Request smuggling or path injection into API URLs (T) | Every path segment is percent-encoded with `quote(safe="")`, bodies are serialized with `json.dumps`, and container names come from validated ids. | Unit tests against a fake socket that records the raw requests. |
| Acting on containers PitStore did not create (T) | All lifecycle verbs first filter by the `io.pitstore.app=<id>` label and refuse IDs without it. The only other containers they act on are those the user explicitly took over in place, found by the names recorded in that app's `plan.json`. | Helper test. VM test: a container not created by PitStore cannot be stopped through PitStore. |
| Wrong socket, a lookalike socket planted by a local user (S) | System sockets are fixed paths under `/run`. The rootless path comes from the helper's own `XDG_RUNTIME_DIR` and must be owned by the uid and mode 0600/0660. | Unit test for the ownership check. |

### TB5 – bridge ⇄ external catalog

| Threat | Mitigation | Test |
|---|---|---|
| MITM / tampering in transit (T) | HTTPS only, with system CA validation (the bridge's `ssl.create_default_context()`). `tls.validate: false` is never set. | Unit test that settings reject `http://`. VM test against a host with a self-signed certificate fails. |
| Malicious or compromised catalog (T/E) | Strict JSON schema and size limits, and a strict YAML parser (single document, no custom tags, alias limit). Unknown compose keys make the app unsupported. The security policy blocks dangerous options. The user sees the images and the published ports before installing. | Schema tests, YAML bomb test (billion laughs), policy vectors. |
| Hidden changes in an update (T) | Updates re-run the policy. New findings need new confirmation. A changed compose hash invalidates old confirmations. The UI shows the image/port/mount diff. | Helper test: an update adding `cap_add` is refused without confirmation. |
| Placeholder secrets in catalog (I) | Secret-like env keys are flagged and replaced with random values. `DefaultPassword` becomes random per app, not the CasaOS default `casaos`. | Unit test for detection. Helper test that `secrets.json` is 0600 and not in the plan echo. |
| Tracking / privacy (I) | Catalog fetches go from the host, not the browser. No telemetry. Screenshots load only on demand. | – |
| Several catalogs (T/E) | Every enabled catalog is an untrusted publisher, validated and cached separately; all apps go through the same policy and helper checks whichever catalog they come from. The card and the details dialog name the catalog an offer comes from; installed apps record their catalog URL, so updates come from the same catalog. Duplicate titles are only grouped for display, never treated as the same app id. | Unit tests `merged catalogs`; browser test checks the catalog filter and offers. |
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
* Keeping another tool (compose, another app store) from changing containers
  that PitStore took over. The analysis warns about it.
