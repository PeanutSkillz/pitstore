# SPDX-License-Identifier: LGPL-2.1-or-later
"""Translate a validated catalog Compose file into runtime-neutral container
specs, validating every user-controllable value on the way.

Nothing here talks to the runtime or the filesystem; see runtime.py and
main.py for that. All values end up in JSON API bodies, never in a shell.
"""

import ipaddress
import re
import shlex
from dataclasses import dataclass, field

from . import policy


class ValidationError(Exception):
    pass


APP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$")
SERVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
LABEL_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
PATH_COMPONENT_RE = re.compile(r"^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$")
TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
REGISTRY_RE = re.compile(r"^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?::[0-9]{1,5})?$")
DURATION_RE = re.compile(r"^(?:(\d+(?:\.\d+)?)(h|m|s|ms|us))+$")
DURATION_PART_RE = re.compile(r"(\d+(?:\.\d+)?)(h|m|s|ms|us)")
SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$", re.IGNORECASE)

MAX_ENV_VALUE = 32 * 1024
MAX_PATH = 4096
RESTART_POLICIES = {"no", "always", "unless-stopped", "on-failure"}
COCKPIT_PORT = 9090

LABEL_APP = "io.pitstore.app"
LABEL_SERVICE = "io.pitstore.service"
LABEL_VERSION = "io.pitstore.version"


@dataclass
class Port:
    host_port: int
    container_port: int
    protocol: str = "tcp"
    host_ip: str = ""


@dataclass
class Mount:
    kind: str          # "bind", "volume" or "tmpfs"
    source: str        # host path, runtime volume name, or "" for tmpfs/anonymous
    target: str
    read_only: bool = False


@dataclass
class ContainerSpec:
    name: str
    service: str
    image: str
    command: list = None
    entrypoint: list = None
    env: dict = field(default_factory=dict)
    labels: dict = field(default_factory=dict)
    ports: list = field(default_factory=list)
    mounts: list = field(default_factory=list)
    network_mode: str = "bridge"   # "bridge", "host" or "none"
    networks: list = field(default_factory=list)
    restart: str = "unless-stopped"
    restart_retries: int = 0
    healthcheck: dict = None       # {"test": [...], "interval": ns, "timeout": ns, "retries": n, "start_period": ns}
    user: str = ""
    working_dir: str = ""
    hostname: str = ""
    tty: bool = False
    stdin_open: bool = False
    stop_signal: str = ""
    stop_timeout: int = None
    shm_size: int = None
    privileged: bool = False
    pid_host: bool = False
    ipc_mode: str = ""
    uts_host: bool = False
    cap_add: list = field(default_factory=list)
    cap_drop: list = field(default_factory=list)
    devices: list = field(default_factory=list)   # [(host, container, permissions)]
    security_opt: list = field(default_factory=list)
    sysctls: dict = field(default_factory=dict)
    ulimits: list = field(default_factory=list)   # [(name, soft, hard)]
    extra_hosts: list = field(default_factory=list)  # ["name:ip"]
    init: bool = False
    memory_limit: int = None
    memory_reservation: int = None
    nano_cpus: int = None
    cpu_shares: int = None
    depends_on: list = field(default_factory=list)


@dataclass
class AppSpec:
    app_id: str
    network: str                    # per-app network name, "" if no service uses it
    volumes: list                   # runtime volume names to create
    containers: list                # ContainerSpec, in start order


def _fail(path, message):
    raise ValidationError(f"{path}: {message}")


def _js_str(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return ""
    return str(value)


def check_app_id(app_id):
    if not isinstance(app_id, str) or len(app_id) > 128 or not APP_ID_RE.match(app_id):
        raise ValidationError("invalid app id")
    return app_id


def normalize_image(ref, path="image"):
    """Validate an image reference and make it fully qualified (docker.io/library/...)."""
    if not isinstance(ref, str) or not ref or len(ref) > 512:
        _fail(path, "invalid image reference")
    rest, digest = ref, None
    if "@" in rest:
        rest, digest = rest.split("@", 1)
        if not DIGEST_RE.match(digest):
            _fail(path, "invalid image digest")
    tag = None
    last = rest.rsplit("/", 1)[-1]
    if ":" in last:
        rest, tag = rest.rsplit(":", 1)
        if not TAG_RE.match(tag):
            _fail(path, "invalid image tag")
    parts = rest.split("/")
    registry = None
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        registry = parts.pop(0)
        if not REGISTRY_RE.match(registry):
            _fail(path, "invalid registry")
    if not parts or not all(PATH_COMPONENT_RE.match(p) for p in parts):
        _fail(path, "invalid image name")
    if registry is None:
        registry = "docker.io"
        if len(parts) == 1:
            parts.insert(0, "library")
    result = registry + "/" + "/".join(parts)
    if tag is None and digest is None:
        tag = "latest"
    if tag:
        result += ":" + tag
    if digest:
        result += "@" + digest
    return result


def parse_duration_ns(value, path):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value * 1_000_000_000)
    if not isinstance(value, str) or not DURATION_RE.match(value):
        _fail(path, "invalid duration")
    factor = {"h": 3600e9, "m": 60e9, "s": 1e9, "ms": 1e6, "us": 1e3}
    return int(sum(float(n) * factor[u] for n, u in DURATION_PART_RE.findall(value)))


def parse_size(value, path):
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    m = SIZE_RE.match(str(value).strip()) if isinstance(value, (str, float)) else None
    if not m:
        _fail(path, "invalid size")
    factor = {"": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3, "t": 1024 ** 4}[m.group(2).lower()]
    return int(float(m.group(1)) * factor)


def check_env(key, value, path):
    if not isinstance(key, str) or not ENV_KEY_RE.match(key) or len(key) > 256:
        _fail(path, f"invalid environment variable name {key!r}")
    value = _js_str(value)
    if "\0" in value or len(value) > MAX_ENV_VALUE:
        _fail(path, f"invalid value for environment variable {key}")
    return value


def parse_env(env, path):
    out = {}
    if env is None:
        return out
    if isinstance(env, list):
        for item in env:
            if not isinstance(item, str):
                _fail(path, "invalid environment entry")
            key, sep, value = item.partition("=")
            if not sep:
                continue  # "KEY" alone means "take from the host environment": not supported, skip
            out[key] = check_env(key, value, path)
    elif isinstance(env, dict):
        for key, value in env.items():
            if value is None:
                continue
            out[key] = check_env(key, value, path)
    else:
        _fail(path, "environment must be a list or a map")
    return out


def parse_command(value, path):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            # tokenized like the Compose spec does; the result is an argv list, never a shell
            return shlex.split(value)
        except ValueError:
            _fail(path, "unbalanced quotes")
    if isinstance(value, list) and all(isinstance(v, (str, int, float)) and not isinstance(v, bool) for v in value):
        return [str(v) for v in value]
    _fail(path, "must be a string or a list of strings")


def check_container_path(value, path):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value or len(value) > MAX_PATH:
        _fail(path, f"invalid container path {value!r}")
    return value


def check_host_path(value, path):
    """Host paths must be absolute and already normalized: no "..", "//" or "."."""
    if not isinstance(value, str) or "\0" in value or len(value) > MAX_PATH:
        _fail(path, "invalid host path")
    if not value.startswith("/") or policy.normalize_path(value) != value:
        _fail(path, f"host path {value!r} must be absolute and normalized")
    return value


def parse_ports(entries, path, rootless):
    ports = []
    for entry in entries or []:
        host_ip, published, target, protocol = "", None, None, "tcp"
        if isinstance(entry, str):
            spec, _, proto = entry.partition("/")
            protocol = proto or "tcp"
            parts = spec.rsplit(":", 2) if spec.count(":") <= 2 else None
            if parts is None:
                _fail(path, f"invalid port {entry!r}")
            if len(parts) == 3:
                host_ip, published, target = parts
            elif len(parts) == 2:
                published, target = parts
            else:
                target = parts[0]
        elif isinstance(entry, dict):
            target = entry.get("target")
            published = entry.get("published")
            protocol = entry.get("protocol") or "tcp"
            host_ip = entry.get("host_ip") or ""
        else:
            _fail(path, "invalid port entry")
        if protocol not in ("tcp", "udp"):
            _fail(path, f"unsupported protocol {protocol!r}")
        try:
            target = int(str(target))
            published = int(str(published)) if published not in (None, "") else None
        except ValueError:
            _fail(path, f"invalid port {entry!r} (ranges are not supported)")
        if published is None:
            _fail(path, f"port {target} has no published host port")
        for p in (target, published):
            if not 1 <= p <= 65535:
                _fail(path, f"port {p} is out of range")
        if published == COCKPIT_PORT:
            _fail(path, "port 9090 is reserved for Cockpit")
        if rootless and published < 1024:
            _fail(path, f"port {published} needs the system Podman or Docker backend (below 1024)")
        if host_ip:
            host_ip = host_ip.strip("[]")
            try:
                ipaddress.ip_address(host_ip)
            except ValueError:
                _fail(path, f"invalid host IP {host_ip!r}")
        ports.append(Port(published, target, protocol, host_ip))
    return ports


def _topo_order(services):
    order, state = [], {}

    def visit(name, chain):
        if state.get(name) == "done":
            return
        if state.get(name) == "visiting":
            raise ValidationError(f"depends_on cycle: {' -> '.join(chain + [name])}")
        state[name] = "visiting"
        for dep in services[name]:
            if dep not in services:
                raise ValidationError(f"services.{name}.depends_on: unknown service {dep}")
            visit(dep, chain + [name])
        state[name] = "done"
        order.append(name)

    for name in sorted(services):
        visit(name, [])
    return order


def translate(compose, app_id, version, rootless, confirmed=(), keep_volume_names=False):
    """Return an AppSpec. Raises ValidationError for anything that is not
    allowed: unsupported keys, unconfirmed policy findings, bad values.

    keep_volume_names: use named volumes under their own names instead of
    "pitstore-<app>-<name>" (adoption must reuse the existing volumes)."""
    check_app_id(app_id)
    verdict = policy.evaluate(compose)
    if verdict["unsupported"]:
        u = verdict["unsupported"][0]
        raise ValidationError(f"{u['path']}: {u['reason']}")
    missing = [f["key"] for f in verdict["findings"] if f["key"] not in set(confirmed)]
    if missing:
        raise ValidationError("blocked options were not confirmed: " + ", ".join(missing))

    services = compose["services"]
    named_volumes = set(policy._as_object(compose.get("volumes")))
    network = f"pitstore-{app_id}"
    uses_network = False
    specs = {}
    deps = {}

    for svc, d in services.items():
        if not SERVICE_RE.match(svc):
            raise ValidationError(f"invalid service name {svc!r}")
        p = f"services.{svc}"
        spec = ContainerSpec(name=f"pitstore-{app_id}-{svc}", service=svc,
                             image=normalize_image(d.get("image"), f"{p}.image"))
        spec.command = parse_command(d.get("command"), f"{p}.command")
        spec.entrypoint = parse_command(d.get("entrypoint"), f"{p}.entrypoint")
        spec.env = parse_env(d.get("environment"), f"{p}.environment")

        labels = d.get("labels") or {}
        if isinstance(labels, list):
            labels = dict(item.partition("=")[::2] for item in labels if isinstance(item, str))
        if not isinstance(labels, dict):
            _fail(f"{p}.labels", "invalid labels")
        for k, v in labels.items():
            if not LABEL_KEY_RE.match(str(k)) or str(k).startswith("io.pitstore."):
                _fail(f"{p}.labels", f"invalid label {k!r}")
            spec.labels[str(k)] = check_env("LABEL", v, f"{p}.labels")
        spec.labels.update({LABEL_APP: app_id, LABEL_SERVICE: svc, LABEL_VERSION: version or ""})

        mode = d.get("network_mode", "bridge")
        spec.network_mode = "bridge" if mode in ("bridge", "default") else mode
        if spec.network_mode == "bridge":
            uses_network = True
            spec.networks = [network]
            spec.ports = parse_ports(d.get("ports"), f"{p}.ports", rootless)
        elif d.get("ports"):
            # host networking publishes nothing; ports are informational
            parse_ports(d.get("ports"), f"{p}.ports", rootless)

        for entry in d.get("volumes") or []:
            mount = policy.parse_volume(entry)
            kind, source, target, read_only = mount
            check_container_path(target, f"{p}.volumes")
            if kind == "bind":
                spec.mounts.append(Mount("bind", check_host_path(source, f"{p}.volumes"), target, read_only))
            elif kind == "volume":
                if source and source not in named_volumes:
                    _fail(f"{p}.volumes", f"volume {source!r} is not declared at the top level")
                name = (source if keep_volume_names else f"pitstore-{app_id}-{source}") if source else ""
                spec.mounts.append(Mount("volume", name, target, read_only))
            else:
                spec.mounts.append(Mount("tmpfs", "", target, False))
        for entry in policy._as_list(d.get("tmpfs")):
            spec.mounts.append(Mount("tmpfs", "", check_container_path(entry, f"{p}.tmpfs"), False))

        restart = d.get("restart", "unless-stopped")
        if not isinstance(restart, str):
            _fail(f"{p}.restart", "invalid restart policy")
        name, _, retries = restart.partition(":")
        if name not in RESTART_POLICIES or (retries and (name != "on-failure" or not retries.isdigit())):
            _fail(f"{p}.restart", f"invalid restart policy {restart!r}")
        spec.restart, spec.restart_retries = name, int(retries or 0)

        hc = d.get("healthcheck")
        if isinstance(hc, dict) and not hc.get("disable"):
            test = hc.get("test")
            if isinstance(test, str):
                test = ["CMD-SHELL", test]
            if not (isinstance(test, list) and test and all(isinstance(t, str) for t in test)):
                _fail(f"{p}.healthcheck", "invalid test")
            if test[0] not in ("CMD", "CMD-SHELL", "NONE"):
                test = ["CMD"] + test
            spec.healthcheck = {"test": test}
            for key in ("interval", "timeout", "start_period"):
                if key in hc:
                    spec.healthcheck[key] = parse_duration_ns(hc[key], f"{p}.healthcheck.{key}")
            if "retries" in hc:
                if not isinstance(hc["retries"], int) or hc["retries"] < 0:
                    _fail(f"{p}.healthcheck.retries", "invalid")
                spec.healthcheck["retries"] = hc["retries"]
        elif hc is not None and not isinstance(hc, dict):
            _fail(f"{p}.healthcheck", "invalid healthcheck")

        for key, attr in (("user", "user"), ("working_dir", "working_dir"), ("hostname", "hostname"),
                          ("stop_signal", "stop_signal")):
            if key in d:
                value = _js_str(d[key])
                if "\0" in value or len(value) > 256:
                    _fail(f"{p}.{key}", "invalid value")
                setattr(spec, attr, value)
        spec.tty = d.get("tty") is True
        spec.stdin_open = d.get("stdin_open") is True
        spec.init = d.get("init") is True
        if "stop_grace_period" in d:
            spec.stop_timeout = parse_duration_ns(d["stop_grace_period"], f"{p}.stop_grace_period") // 1_000_000_000
        if "shm_size" in d:
            spec.shm_size = parse_size(d["shm_size"], f"{p}.shm_size")
        if "cpu_shares" in d:
            if not isinstance(d["cpu_shares"], int) or d["cpu_shares"] < 0:
                _fail(f"{p}.cpu_shares", "invalid value")
            spec.cpu_shares = d["cpu_shares"]

        # options below are only reachable after confirmation (policy above)
        spec.privileged = d.get("privileged") is True
        spec.pid_host = d.get("pid") == "host"
        spec.ipc_mode = d.get("ipc", "")
        spec.uts_host = d.get("uts") == "host"
        spec.cap_add = [c.upper().removeprefix("CAP_") for c in policy._as_list(d.get("cap_add"))]
        spec.cap_drop = []
        for c in policy._as_list(d.get("cap_drop")):
            if not isinstance(c, str) or not re.match(r"^(?:CAP_)?[A-Za-z_]+$", c):
                _fail(f"{p}.cap_drop", "invalid capability")
            spec.cap_drop.append(c.upper().removeprefix("CAP_"))
        for dev in policy._as_list(d.get("devices")):
            host, _, rest = dev.partition(":")
            container, _, perms = rest.partition(":")
            spec.devices.append((policy.normalize_path(host), container or policy.normalize_path(host), perms or "rwm"))
        spec.security_opt = [o for o in policy._as_list(d.get("security_opt"))]
        sysctls = d.get("sysctls") or {}
        if isinstance(sysctls, list):
            sysctls = dict(s.partition("=")[::2] for s in sysctls)
        spec.sysctls = {str(k): _js_str(v) for k, v in sysctls.items()}

        ulimits = d.get("ulimits") or {}
        if not isinstance(ulimits, dict):
            _fail(f"{p}.ulimits", "invalid ulimits")
        for name, value in ulimits.items():
            if not re.match(r"^[a-z]+$", str(name)):
                _fail(f"{p}.ulimits", f"invalid ulimit {name!r}")
            if isinstance(value, int):
                soft = hard = value
            elif isinstance(value, dict) and isinstance(value.get("soft"), int) and isinstance(value.get("hard"), int):
                soft, hard = value["soft"], value["hard"]
            else:
                _fail(f"{p}.ulimits.{name}", "invalid value")
            spec.ulimits.append((str(name), soft, hard))

        hosts = d.get("extra_hosts") or []
        if isinstance(hosts, dict):
            hosts = [f"{k}:{v}" for k, v in hosts.items()]
        for h in hosts:
            name, sep, ip = str(h).partition(":") if "=" not in str(h) else str(h).partition("=")
            try:
                if ip != "host-gateway":
                    ipaddress.ip_address(ip.strip("[]"))
            except ValueError:
                _fail(f"{p}.extra_hosts", f"invalid entry {h!r}")
            if not sep or not re.match(r"^[A-Za-z0-9.-]{1,253}$", name):
                _fail(f"{p}.extra_hosts", f"invalid entry {h!r}")
            spec.extra_hosts.append(f"{name}:{ip.strip('[]')}")

        resources = policy._as_object(policy._as_object(d.get("deploy")).get("resources"))
        limits = policy._as_object(resources.get("limits"))
        reservations = policy._as_object(resources.get("reservations"))
        if "memory" in limits:
            spec.memory_limit = parse_size(limits["memory"], f"{p}.deploy.resources.limits.memory")
        if "memory" in reservations:
            spec.memory_reservation = parse_size(reservations["memory"], f"{p}.deploy.resources.reservations.memory")
        if "cpus" in limits:
            try:
                spec.nano_cpus = int(float(limits["cpus"]) * 1_000_000_000)
            except (TypeError, ValueError):
                _fail(f"{p}.deploy.resources.limits.cpus", "invalid value")

        dep = d.get("depends_on") or []
        if isinstance(dep, dict):
            dep = list(dep)
        if not isinstance(dep, list) or not all(isinstance(x, str) for x in dep):
            _fail(f"{p}.depends_on", "invalid value")
        deps[svc] = dep
        spec.depends_on = dep
        specs[svc] = spec

    order = _topo_order(deps)
    volumes = sorted({m.source for s in specs.values() for m in s.mounts if m.kind == "volume" and m.source})
    return AppSpec(app_id=app_id, network=network if uses_network else "", volumes=volumes,
                   containers=[specs[name] for name in order])
