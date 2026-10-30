# SPDX-License-Identifier: LGPL-2.1-or-later
"""Security policy for catalog Compose files (authoritative copy).

The helper runs this on the exact Compose data it is asked to deploy, before
anything reaches the container runtime. The UI has a TypeScript copy
(src/lib/policy.ts) for display; both are tested against the same vectors in
test/policy-vectors/. Keep the two in sync.

evaluate() returns:
  findings:    {"key": "<service>/<id>", "service", "kind", "detail"} for
               options that are blocked unless the user confirmed them
  unsupported: {"path", "reason"} for constructs that are never allowed
"""

import re

SENSITIVE_PATHS = (
    "/etc", "/root", "/var/run", "/run", "/proc", "/sys", "/dev", "/boot",
    "/var/lib/docker", "/var/lib/containers",
)
RUNTIME_SOCKETS = ("docker.sock", "podman.sock", "containerd.sock")
# read-only mounts of these files only reveal the host time zone
READ_ONLY_EXCEPTIONS = ("/etc/localtime", "/etc/timezone")

TOP_LEVEL_KEYS = {"name", "services", "x-casaos", "networks", "volumes", "version"}

SERVICE_KEYS = {
    "image", "container_name", "command", "entrypoint", "environment", "ports", "volumes",
    "restart", "depends_on", "healthcheck", "network_mode", "networks", "user", "working_dir",
    "hostname", "labels", "tty", "stdin_open", "stop_signal", "stop_grace_period", "shm_size",
    "ulimits", "sysctls", "deploy", "cpu_shares", "extra_hosts", "init", "expose", "cap_drop",
    "tmpfs", "logging", "x-casaos",
    # evaluated as findings below
    "privileged", "pid", "ipc", "uts", "userns_mode", "cgroup", "cap_add", "devices", "security_opt",
}

UNSUPPORTED_REASONS = {
    "build": "building images is not supported",
    "env_file": "environment files are not supported",
    "configs": "Compose configs are not supported",
    "secrets": "Compose secrets are not supported",
    "profiles": "Compose profiles are not supported",
    "extends": "extends is not supported",
    "runtime": "alternative container runtimes are not supported",
    "volumes_from": "volumes_from is not supported",
    "links": "links are not supported",
    "external_links": "external links are not supported",
    "group_add": "additional groups are not supported",
}

NO_NEW_PRIVILEGES = {"no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"}
LOG_DRIVERS = {"json-file", "journald", "local", "k8s-file"}

_CAP_RE = re.compile(r"^(?:CAP_)?[A-Za-z_]+$")
_SYSCTL_RE = re.compile(r"^[A-Za-z0-9_.]+$")


def normalize_path(path):
    """Lexically normalize an absolute POSIX path ("//a/./b/../c/" -> "/a/c")."""
    out = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if out:
                out.pop()
        else:
            out.append(seg)
    return "/" + "/".join(out)


def is_under(path, prefix):
    return prefix == "/" or path == prefix or path.startswith(prefix + "/")


def parse_volume(entry):
    """Parse one services.<s>.volumes entry into (type, source, target, read_only) or None."""
    if isinstance(entry, str):
        parts = entry.split(":")
        if len(parts) == 1:
            return ("volume", "", parts[0], False)
        if len(parts) > 3:
            return None
        source, target = parts[0], parts[1]
        mode = parts[2] if len(parts) == 3 else ""
        if not source or not target:
            return None
        kind = "bind" if source.startswith(("/", ".", "~")) else "volume"
        return (kind, source, target, "ro" in mode.split(","))
    if isinstance(entry, dict):
        kind = entry.get("type")
        source = entry.get("source") if isinstance(entry.get("source"), str) else ""
        target = entry.get("target") if isinstance(entry.get("target"), str) else ""
        if not target or kind not in ("bind", "volume", "tmpfs"):
            return None
        if kind == "bind" and not source:
            return None
        return (kind, source, target, entry.get("read_only") is True)
    return None


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _as_object(value):
    return value if isinstance(value, dict) else {}


def _js_str(value):
    """String form matching JavaScript's String() for the values that occur here."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)


def evaluate(compose):
    if not isinstance(compose, dict) or not isinstance(compose.get("services"), dict):
        return {"findings": [], "unsupported": [{"path": "services", "reason": "no services defined"}]}

    findings = {}
    unsupported = {}

    def finding(service, kind, detail):
        ident = f"{kind}:{detail}" if detail else kind
        key = f"{service}/{ident}"
        findings.setdefault(key, {"key": key, "service": service, "kind": kind, "detail": detail})

    def reject(path, reason):
        unsupported.setdefault(path, {"path": path, "reason": reason})

    for key in compose:
        if key not in TOP_LEVEL_KEYS:
            reject(key, UNSUPPORTED_REASONS.get(key, "unknown top-level key"))

    for name, definition in _as_object(compose.get("volumes")).items():
        if definition is None:
            continue
        if not isinstance(definition, dict):
            reject(f"volumes.{name}", "invalid volume definition")
            continue
        for k in definition:
            if k != "name":
                reject(f"volumes.{name}.{k}", "volume drivers and options are not supported")

    networks = _as_object(compose.get("networks"))
    for name, definition in networks.items():
        if definition is None:
            continue
        if not isinstance(definition, dict):
            reject(f"networks.{name}", "invalid network definition")
            continue
        for k, v in definition.items():
            # internal: true only removes outside access, so it is safe
            if k == "name" or (k == "driver" and v == "bridge") or (k == "internal" and isinstance(v, bool)):
                continue
            reject(f"networks.{name}.{k}", "only plain bridge networks are supported")

    for svc, definition in compose["services"].items():
        p = f"services.{svc}"
        if not isinstance(definition, dict):
            reject(p, "invalid service definition")
            continue

        for key in definition:
            if key not in SERVICE_KEYS:
                reject(f"{p}.{key}", UNSUPPORTED_REASONS.get(key, "unknown service key"))

        privileged = definition.get("privileged")
        if privileged is True:
            finding(svc, "privileged", "")
        elif "privileged" in definition and privileged is not False:
            reject(f"{p}.privileged", "privileged must be a boolean")

        net = definition.get("network_mode")
        if net == "host":
            finding(svc, "net-host", "")
        elif "network_mode" in definition and net not in ("bridge", "default", "none"):
            reject(f"{p}.network_mode", "only bridge, default, none or host networking is supported")

        for key, kind in (("pid", "pid-host"), ("ipc", "ipc-host")):
            if key not in definition:
                continue
            v = definition[key]
            if v == "host":
                finding(svc, kind, "")
            elif not (key == "ipc" and v in ("private", "shareable")):
                reject(f"{p}.{key}", f"{key} mode {_js_str(v)} is not supported")

        for key in ("uts", "userns_mode", "cgroup"):
            if key not in definition:
                continue
            v = definition[key]
            if v == "host":
                finding(svc, "ns-host", key)
            elif not (key == "cgroup" and v == "private"):
                reject(f"{p}.{key}", f"{key} mode {_js_str(v)} is not supported")

        for cap in _as_list(definition.get("cap_add")):
            if not isinstance(cap, str) or not _CAP_RE.match(cap):
                reject(f"{p}.cap_add", "invalid capability")
                continue
            upper = cap.upper()
            finding(svc, "cap-add", upper[4:] if upper.startswith("CAP_") else upper)

        for dev in _as_list(definition.get("devices")):
            host = dev.split(":")[0] if isinstance(dev, str) else ""
            if not host.startswith("/"):
                reject(f"{p}.devices", "invalid device mapping")
                continue
            finding(svc, "device", normalize_path(host))

        for opt in _as_list(definition.get("security_opt")):
            if not isinstance(opt, str):
                reject(f"{p}.security_opt", "invalid security option")
                continue
            if opt not in NO_NEW_PRIVILEGES:
                finding(svc, "security-opt", opt)

        if "sysctls" in definition:
            sysctls = definition["sysctls"]
            if isinstance(sysctls, list):
                keys = [s.split("=")[0] if isinstance(s, str) else "" for s in sysctls]
            else:
                keys = list(_as_object(sysctls))
            for k in keys:
                if not _SYSCTL_RE.match(k):
                    reject(f"{p}.sysctls", "invalid sysctl")
                elif not k.startswith("net."):
                    finding(svc, "sysctl", k)

        for entry in _as_list(definition.get("volumes")):
            mount = parse_volume(entry)
            if mount is None:
                reject(f"{p}.volumes", "invalid volume entry")
                continue
            kind, source, _target, read_only = mount
            if kind != "bind":
                continue
            if not source.startswith("/"):
                reject(f"{p}.volumes", f"relative bind mount {source} is not supported")
                continue
            source = normalize_path(source)
            if source.split("/")[-1] in RUNTIME_SOCKETS:
                finding(svc, "mount-runtime-socket", source)
                continue
            if read_only and source in READ_ONLY_EXCEPTIONS:
                continue
            # a system directory, anything below it, or a parent of it (like / or /var)
            if any(is_under(source, s) or is_under(s, source) for s in SENSITIVE_PATHS):
                finding(svc, "mount-sensitive", source)

        if "deploy" in definition:
            deploy = _as_object(definition["deploy"])
            for k in deploy:
                if k != "resources":
                    reject(f"{p}.deploy.{k}", "only deploy.resources is supported")
            resources = _as_object(deploy.get("resources"))
            for k, v in resources.items():
                if k not in ("limits", "reservations"):
                    reject(f"{p}.deploy.resources.{k}", "unknown resource key")
                    continue
                for rk in _as_object(v):
                    if rk not in ("memory", "cpus"):
                        reject(f"{p}.deploy.resources.{k}.{rk}", "only memory and cpus resources are supported")

        if "logging" in definition:
            driver = _as_object(definition["logging"]).get("driver")
            if "driver" in _as_object(definition["logging"]) and not (isinstance(driver, str) and driver in LOG_DRIVERS):
                reject(f"{p}.logging", "only local log drivers are supported")

        service_networks = definition.get("networks")
        names = service_networks if isinstance(service_networks, list) else list(_as_object(service_networks))
        for n in names:
            if not isinstance(n, str) or (n != "default" and n not in networks):
                reject(f"{p}.networks", f"network {_js_str(n)} is not defined")

    return {
        "findings": [findings[k] for k in sorted(findings)],
        "unsupported": [unsupported[k] for k in sorted(unsupported)],
    }
