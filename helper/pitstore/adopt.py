# SPDX-License-Identifier: LGPL-2.1-or-later
"""Showing and taking over ("adopting") containers that PitStore did not create.

Containers are grouped into apps by their compose project label (or their
own name). For a group, analyze() rebuilds a Compose description from the
runtime's inspect data and lists every check that matters for a takeover,
each with the corrections the user may choose. adopt() re-runs the analysis
here on the server, validates the choices and then either

  - registers the containers as they are ("in place": nothing is changed), or
  - when a chosen correction needs it, recreates all containers of the group
    with the same bind mounts and named volumes, keeping the old containers
    as renamed backups until the new ones run (rollback on failure).

Environment values are never stored or returned: they may hold secrets.
"""

import datetime
import hashlib
import json
import re
import time

from . import policy
from .runtime import seg
from .translate import LABEL_APP, ValidationError, check_app_id, translate

PROJECT_LABELS = ("com.docker.compose.project", "io.podman.compose.project")
SERVICE_LABELS = ("com.docker.compose.service", "io.podman.compose.service")
DEFAULT_SHM = 64 * 1024 * 1024
ANONYMOUS_VOLUME = re.compile(r"^[0-9a-f]{64}$")
BACKUP_MARK = "-pitstore-backup-"
SECRET_KEY = re.compile(r"(?:PASS(?:WORD|WD)?|PWD|SECRET|TOKEN|KEY|SALT)$", re.IGNORECASE)
OK_RUNTIMES = ("", "runc", "crun", "io.containerd.runc.v2")
OK_LOG_DRIVERS = ("", "json-file", "journald", "local", "k8s-file")

# policy findings whose option can be removed when the containers are recreated
REMOVABLE_FINDINGS = {"privileged", "pid-host", "ipc-host", "ns-host", "cap-add", "device",
                      "security-opt", "sysctl", "mount-sensitive", "mount-runtime-socket"}


class AdoptError(Exception):
    pass


def _name(c):
    return (c.get("Names") or [c.get("Name", "")])[0].lstrip("/")


def _labels(c):
    return c.get("Labels") or (c.get("Config") or {}).get("Labels") or {}


def group_key(c):
    labels = _labels(c)
    for key in PROJECT_LABELS:
        if labels.get(key):
            return labels[key]
    return _name(c)


def managed_by(containers):
    for c in containers:
        labels = _labels(c)
        if any(k.startswith("io.casaos") for k in labels) or \
                str(labels.get("com.docker.compose.project.working_dir", "")).startswith("/var/lib/casaos"):
            return "another app store"
    for c in containers:
        labels = _labels(c)
        if labels.get("com.docker.compose.project"):
            return "docker compose"
        if labels.get("io.podman.compose.project"):
            return "podman-compose"
    return ""


def _ports(c):
    out = []
    for p in c.get("Ports") or []:
        public = p.get("PublicPort") or p.get("host_port")
        if public:
            out.append({"published": int(public), "target": int(p.get("PrivatePort") or p.get("container_port") or 0),
                        "protocol": p.get("Type") or p.get("protocol") or "tcp"})
    return out


def list_foreign(rt, adopted_names):
    """Groups of containers that PitStore neither created nor adopted."""
    groups = {}
    for c in rt.list_all():
        name = _name(c)
        if _labels(c).get(LABEL_APP) or name in adopted_names or BACKUP_MARK in name or c.get("IsInfra"):
            continue
        groups.setdefault(group_key(c), []).append(c)
    result = []
    for key, cs in sorted(groups.items()):
        result.append({
            "key": key,
            "managedBy": managed_by(cs),
            "containers": [{"name": _name(c), "image": c.get("Image", ""), "state": c.get("State", ""),
                            "status": c.get("Status", ""), "ports": _ports(c)} for c in cs],
        })
    return result


def _duration(ns):
    return f"{ns / 1e9:g}s"


def reconstruct(info):
    """Compose service (dict) for one inspected container, plus facts the
    checks need. Values come from the runtime; nothing is invented."""
    cfg = info.get("Config") or {}
    hc = info.get("HostConfig") or {}
    labels = cfg.get("Labels") or {}
    service = next((labels[k] for k in SERVICE_LABELS if labels.get(k)), None) or _name(info) or info["Id"][:12]
    service = re.sub(r"[^A-Za-z0-9._-]", "-", service).lstrip("._-")[:63] or "app"
    svc = {"image": cfg.get("Image") or info.get("Image", "")}
    facts = {"anonymous": [], "named": [], "binds": [], "secretEnv": [], "running": (info.get("State") or {}).get("Running", False)}

    if cfg.get("Cmd"):
        svc["command"] = list(cfg["Cmd"])
    if cfg.get("Entrypoint"):
        svc["entrypoint"] = list(cfg["Entrypoint"]) if isinstance(cfg["Entrypoint"], list) else [cfg["Entrypoint"]]
    env = {}
    for item in cfg.get("Env") or []:
        k, _, v = item.partition("=")
        env[k] = v
        if SECRET_KEY.search(k):
            facts["secretEnv"].append(k)
    if env:
        svc["environment"] = env

    ports = []
    for spec, bindings in (hc.get("PortBindings") or {}).items():
        target, _, proto = spec.partition("/")
        for b in bindings or []:
            if not b.get("HostPort"):
                continue
            entry = {"target": int(target), "published": str(b["HostPort"]), "protocol": proto or "tcp"}
            if b.get("HostIp") and b["HostIp"] not in ("0.0.0.0", "::"):
                entry["host_ip"] = b["HostIp"]
            ports.append(entry)
    if ports:
        svc["ports"] = ports

    volumes = []
    for m in info.get("Mounts") or []:
        target = m.get("Destination", "")
        if m.get("Type") == "bind":
            volumes.append({"type": "bind", "source": m.get("Source", ""), "target": target, "read_only": not m.get("RW", True)})
            facts["binds"].append(m.get("Source", ""))
        elif m.get("Type") == "volume":
            name = m.get("Name", "")
            if ANONYMOUS_VOLUME.match(name):
                facts["anonymous"].append(target)
                volumes.append({"type": "volume", "target": target})
            else:
                facts["named"].append(name)
                volumes.append({"type": "volume", "source": name, "target": target, "read_only": not m.get("RW", True)})
        elif m.get("Type") == "tmpfs":
            volumes.append({"type": "tmpfs", "target": target})
    if volumes:
        svc["volumes"] = volumes

    mode = hc.get("NetworkMode") or "bridge"
    if mode in ("host", "none"):
        svc["network_mode"] = mode
    elif mode.startswith(("container:", "service:", "ns:")):
        svc["network_mode"] = mode

    rp = hc.get("RestartPolicy") or {}
    restart = rp.get("Name") or "no"
    if restart == "on-failure" and rp.get("MaximumRetryCount"):
        restart += f":{rp['MaximumRetryCount']}"
    svc["restart"] = restart

    if hc.get("Privileged"):
        svc["privileged"] = True
    for key, field in (("pid", "PidMode"), ("ipc", "IpcMode"), ("uts", "UTSMode"),
                       ("userns_mode", "UsernsMode"), ("cgroup", "CgroupnsMode")):
        value = hc.get(field) or ""
        if value == "host" or value.startswith("container:"):
            svc[key] = value
    security_opt = list(hc.get("SecurityOpt") or [])
    if hc.get("Privileged") and security_opt == ["label=disable"]:
        # Docker adds this itself for --privileged; it is not a separate choice
        security_opt = []
    if security_opt:
        svc["security_opt"] = security_opt
    for key, field in (("cap_add", "CapAdd"), ("cap_drop", "CapDrop"),
                       ("extra_hosts", "ExtraHosts"), ("group_add", "GroupAdd"), ("links", "Links"),
                       ("volumes_from", "VolumesFrom")):
        if hc.get(field):
            svc[key] = list(hc[field])
    if hc.get("Devices"):
        svc["devices"] = [f"{d['PathOnHost']}:{d.get('PathInContainer') or d['PathOnHost']}:{d.get('CgroupPermissions') or 'rwm'}"
                          for d in hc["Devices"]]
    if hc.get("Sysctls"):
        svc["sysctls"] = dict(hc["Sysctls"])
    if hc.get("Ulimits"):
        svc["ulimits"] = {u["Name"]: {"soft": u["Soft"], "hard": u["Hard"]} for u in hc["Ulimits"]}
    if hc.get("Init"):
        svc["init"] = True
    if hc.get("ShmSize") and hc["ShmSize"] != DEFAULT_SHM:
        svc["shm_size"] = hc["ShmSize"]
    if hc.get("CpuShares"):
        svc["cpu_shares"] = hc["CpuShares"]
    if (hc.get("Runtime") or "") not in OK_RUNTIMES:
        svc["runtime"] = hc["Runtime"]
    log = (hc.get("LogConfig") or {}).get("Type") or ""
    if log not in OK_LOG_DRIVERS:
        svc["logging"] = {"driver": log}

    resources = {}
    if hc.get("Memory"):
        resources.setdefault("limits", {})["memory"] = hc["Memory"]
    if hc.get("NanoCpus"):
        resources.setdefault("limits", {})["cpus"] = str(hc["NanoCpus"] / 1e9)
    if hc.get("MemoryReservation"):
        resources.setdefault("reservations", {})["memory"] = hc["MemoryReservation"]
    if hc.get("DeviceRequests"):
        resources.setdefault("reservations", {})["devices"] = [{"driver": d.get("Driver", "")} for d in hc["DeviceRequests"]]
    if resources:
        svc["deploy"] = {"resources": resources}

    for key, field in (("user", "User"), ("working_dir", "WorkingDir"), ("stop_signal", "StopSignal")):
        if cfg.get(field):
            svc[key] = cfg[field]
    if cfg.get("Tty"):
        svc["tty"] = True
    if cfg.get("OpenStdin"):
        svc["stdin_open"] = True
    if cfg.get("StopTimeout"):
        svc["stop_grace_period"] = f"{cfg['StopTimeout']}s"
    hcheck = cfg.get("Healthcheck") or {}
    if hcheck.get("Test") and hcheck["Test"][0] != "NONE":
        h = {"test": list(hcheck["Test"])}
        for src, dst in (("Interval", "interval"), ("Timeout", "timeout"), ("StartPeriod", "start_period")):
            if hcheck.get(src):
                h[dst] = _duration(hcheck[src])
        if hcheck.get("Retries"):
            h["retries"] = hcheck["Retries"]
        svc["healthcheck"] = h

    deps = labels.get("com.docker.compose.depends_on", "")
    if deps:
        svc["depends_on"] = [d.split(":")[0] for d in deps.split(",") if d]
    return service, svc, facts


def _check(cid, severity, title, detail="", service="", corrections=(), default="keep"):
    return {"id": cid, "severity": severity, "title": title, "detail": detail, "service": service,
            "corrections": list(corrections), "default": default}


KEEP = {"id": "keep", "label": "Keep as it is", "recreate": False}


def analyze(rt, key, adopted_names=(), with_facts=False):
    """Inspect a group and list the checks. Returns (analysis, compose,
    {service: container name}) and, with with_facts, the per-service facts."""
    groups = {g["key"]: g for g in list_foreign(rt, set(adopted_names))}
    if key not in groups:
        raise AdoptError(f"no container group {key!r} (it may already be managed by PitStore)")
    names = [c["name"] for c in groups[key]["containers"]]
    infos = [rt.inspect(n) for n in names]

    services, facts, containers = {}, {}, {}
    for info in infos:
        svc_name, svc, f = reconstruct(info)
        f["imageId"] = info.get("Image", "")
        while svc_name in services:
            svc_name += "-2"
        services[svc_name] = svc
        facts[svc_name] = f
        containers[svc_name] = _name(info)
    for svc in services.values():
        if "depends_on" in svc:
            svc["depends_on"] = [d for d in svc["depends_on"] if d in services]
    named = sorted({n for f in facts.values() for n in f["named"]})
    compose = {"services": services, "volumes": {n: None for n in named}}

    checks = []
    if groups[key]["managedBy"]:
        checks.append(_check("managed-elsewhere", "warning", f"Also managed by {groups[key]['managedBy']}",
                              "After the takeover, manage this app only through PitStore. Changes made by the other tool "
                              "(for example an update or a restart of its stack) can undo or conflict with PitStore's."))

    verdict = policy.evaluate(compose)
    for f in verdict["findings"]:
        corrections = [{"id": "keep", "label": "Allow it (I understand the risk)", "recreate": False, "confirms": True}]
        if f["kind"] in REMOVABLE_FINDINGS:
            corrections.append({"id": "remove", "label": "Remove this option (recreates the containers)", "recreate": True})
        checks.append(_check(f["key"], "decision", f"Risky option: {f['kind']} {f['detail']}".strip(),
                             "This option is blocked by default. Allow it explicitly, or remove it if the app does not need it.",
                             f["service"], corrections, default=""))
    for u in verdict["unsupported"]:
        checks.append(_check(f"unsupported:{u['path']}", "warning", f"Not supported by PitStore: {u['path']}",
                             f"{u['reason']}. Taking over without changes works; recreating the containers is only "
                             "possible when this setting is removed.", "",
                             [KEEP, {"id": "remove", "label": "Remove this setting (recreates the containers)", "recreate": True}]))

    other_ports = {(9090, "tcp")}
    for c in rt.list_all():
        if group_key(c) != key:
            for p in _ports(c):
                other_ports.add((p["published"], p["protocol"]))
    for svc_name, svc in services.items():
        for p in svc.get("ports", []):
            if (int(p["published"]), p["protocol"]) in other_ports:
                checks.append(_check(f"port:{svc_name}:{p['published']}/{p['protocol']}", "warning",
                                     f"Port {p['published']}/{p['protocol']} is also used by another app",
                                     "Both apps cannot run at the same time.", svc_name,
                                     [KEEP, {"id": "change", "label": "Use another host port (recreates the containers)",
                                             "recreate": True, "input": "port"}]))
        if svc.get("restart", "no") == "no":
            checks.append(_check(f"restart:{svc_name}", "warning", f"{svc_name} does not start again after a reboot",
                                 "Its restart policy is 'no'.", svc_name,
                                 [KEEP, {"id": "set", "label": "Restart automatically (recreates the containers)", "recreate": True}]))
        for target in facts[svc_name]["anonymous"]:
            checks.append(_check(f"anon-volume:{svc_name}:{target}", "warning",
                                 f"{svc_name} keeps data in an anonymous volume ({target})",
                                 "Recreating the containers would lose this data, so corrections that recreate the "
                                 "containers are not possible for this app.", svc_name))
        if facts[svc_name]["binds"]:
            checks.append(_check(f"binds:{svc_name}", "info", f"{svc_name} uses folders on this server",
                                 "They stay where they are. PitStore never deletes them: " + ", ".join(facts[svc_name]["binds"]),
                                 svc_name))
        if facts[svc_name]["secretEnv"]:
            checks.append(_check(f"secrets:{svc_name}", "info", f"{svc_name} has credentials in its environment",
                                 "PitStore does not store or show them: " + ", ".join(facts[svc_name]["secretEnv"]), svc_name))
        if not facts[svc_name]["running"]:
            checks.append(_check(f"stopped:{svc_name}", "info", f"{svc_name} is not running", "", svc_name))

    analysis = {
        "key": key,
        "managedBy": groups[key]["managedBy"],
        "suggestedId": suggested_id(key),
        "services": [{"name": s, "container": containers[s], "image": services[s].get("image", "")} for s in services],
        "checks": checks,
        "recreatePossible": not any(f["anonymous"] for f in facts.values()),
    }
    if with_facts:
        return analysis, compose, containers, facts
    return analysis, compose, containers


def suggested_id(key):
    base = re.sub(r"[^a-z0-9_-]+", "-", key.lower()).strip("-_") or "app"
    return f"local.{base[:100]}"


def _apply(compose, check, choice):
    """Apply one recreating correction to the reconstructed compose."""
    cid, value = check["id"], choice.get("value")
    services = compose["services"]
    if cid.startswith("port:"):
        _, svc, rest = cid.split(":", 2)
        published, proto = rest.split("/")
        try:
            new = int(str(value))
        except ValueError:
            raise AdoptError(f"{cid}: invalid port") from None
        for p in services[svc].get("ports", []):
            if p["published"] == published and p["protocol"] == proto:
                p["published"] = str(new)
    elif cid.startswith("restart:"):
        services[cid.split(":", 1)[1]]["restart"] = "unless-stopped"
    elif cid.startswith("unsupported:"):
        path = cid.split(":", 1)[1].split(".")
        if path[0] != "services" or len(path) < 3:
            raise AdoptError(f"{cid}: cannot be removed")
        node = services[path[1]]
        for part in path[2:-1]:
            node = node.get(part, {})
        node.pop(path[-1], None)
    else:
        svc, _, ident = cid.partition("/")
        kind, _, detail = ident.partition(":")
        s = services[svc]
        if kind == "privileged":
            s.pop("privileged", None)
        elif kind in ("pid-host", "ipc-host"):
            s.pop(kind.split("-")[0], None)
        elif kind == "ns-host":
            s.pop(detail, None)
        elif kind == "cap-add":
            s["cap_add"] = [c for c in s.get("cap_add", []) if c.upper().removeprefix("CAP_") != detail]
        elif kind == "device":
            s["devices"] = [d for d in s.get("devices", []) if policy.normalize_path(d.split(":")[0]) != detail]
        elif kind == "security-opt":
            s["security_opt"] = [o for o in s.get("security_opt", []) if o != detail]
        elif kind == "sysctl":
            s.get("sysctls", {}).pop(detail, None)
        elif kind in ("mount-sensitive", "mount-runtime-socket"):
            s["volumes"] = [v for v in s.get("volumes", [])
                            if not (v.get("type") == "bind" and policy.normalize_path(v.get("source", "")) == detail)]
        else:
            raise AdoptError(f"{cid}: cannot be removed")


def validate_choices(analysis, choices):
    """Every decision needs an allowed choice; returns (recreate, confirmed)."""
    if not isinstance(choices, dict):
        raise AdoptError("invalid choices")
    recreate, confirmed = False, []
    for check in analysis["checks"]:
        allowed = {c["id"]: c for c in check["corrections"]}
        choice = choices.get(check["id"]) or {}
        picked = choice.get("choice") or check["default"]
        if not allowed:
            continue
        if picked not in allowed:
            raise AdoptError(f"choose how to handle: {check['title']}")
        corr = allowed[picked]
        if corr.get("confirms"):
            confirmed.append(check["id"])
        if corr.get("recreate"):
            recreate = True
    if recreate and not analysis["recreatePossible"]:
        raise AdoptError("these corrections recreate the containers, which would lose data kept in anonymous volumes")
    if recreate:
        for check in analysis["checks"]:
            picked = (choices.get(check["id"]) or {}).get("choice") or check["default"]
            if check["id"].startswith("unsupported:") and picked != "remove":
                raise AdoptError(f"to recreate the containers, remove: {check['title']}")
    return recreate, confirmed


def adopt(rt, req, adopted_names, progress, check_port_free, prepare_bind, rootless):
    """Returns (plan_extra, confirmed, recreated_container_count)."""
    key = req.get("group")
    if not isinstance(key, str) or not key:
        raise AdoptError("invalid group")
    app_id = check_app_id(req.get("appId"))
    analysis, compose, containers, facts_by_service = analyze(rt, key, adopted_names, with_facts=True)
    choices = req.get("choices") or {}
    recreate, confirmed = validate_choices(analysis, choices)
    digest = hashlib.sha256(json.dumps(
        {s: {k: v for k, v in d.items() if k != "environment"} for s, d in compose["services"].items()},
        sort_keys=True).encode()).hexdigest()

    if not recreate:
        return {"mode": "in-place", "group": key, "containers": containers, "order": list(containers)}, confirmed, digest

    for check in analysis["checks"]:
        choice = choices.get(check["id"]) or {}
        corr = next((c for c in check["corrections"] if c["id"] == (choice.get("choice") or check["default"])), None)
        if corr and corr.get("recreate"):
            _apply(compose, check, choice)
    try:
        spec = translate(compose, app_id, "", rootless, confirmed, keep_volume_names=True)
    except ValidationError as e:
        raise AdoptError(str(e)) from None

    own_ports = {(int(p["published"]), p["protocol"]) for c in analysis["services"]
                 for p in compose["services"][c["name"]].get("ports", [])}
    for c in spec.containers:
        for p in c.ports:
            if (p.host_port, p.protocol) not in own_ports:
                check_port_free(p)
        for m in c.mounts:
            if m.kind == "bind":
                prepare_bind(m.source, app_id)

    # recreate from the exact image the container runs now (a tag such as
    # "latest" could pull a different version); no pull is needed
    for c in spec.containers:
        image_id = facts_by_service[c.service]["imageId"]
        if not re.match(r"^(sha256:)?[0-9a-f]{64}$", image_id):
            raise AdoptError(f"{c.service}: cannot determine the image it runs")
        c.image = image_id

    stamp = time.strftime("%Y%m%d%H%M%S")
    old = []   # (original name, backup name, was running)
    created = []
    try:
        for svc_name, name in containers.items():
            info = rt.inspect(name)
            backup = f"{name}{BACKUP_MARK}{stamp}"
            running = (info.get("State") or {}).get("Running", False)
            progress(f"Stopping {name} (kept as {backup})")
            if running:
                rt.stop(info["Id"])
            rt.rename(info["Id"], backup)
            old.append((name, backup, running, info["Id"]))
        labels = {LABEL_APP: app_id}
        if spec.network:
            rt.create_network(spec.network, labels)
        for v in spec.volumes:
            rt.create_volume(v, labels)
        for c in spec.containers:
            progress(f"Creating {c.service}")
            created.append(rt.create_container(c))
        for cid, c in zip(created, spec.containers):
            progress(f"Starting {c.service}")
            rt.start(cid)
    except Exception as e:
        progress("Takeover failed, restoring the original containers")
        for cid in reversed(created):
            try:
                rt.remove_container(cid)
            except Exception:
                pass
        for name, backup, running, oid in old:
            try:
                rt.rename(oid, name)
                if running:
                    rt.start(oid)
            except Exception:
                pass
        raise AdoptError(f"takeover failed and was rolled back: {e}") from None

    for name, backup, running, oid in old:
        progress(f"Removing the old container {backup}")
        # v=false: never touch volumes of the original containers
        rt.compat.request("DELETE", f"/containers/{seg(oid)}", {"force": "true", "v": "false"})
    return ({"mode": "recreated", "group": key, "order": [c.service for c in spec.containers],
             "ports": sorted({(p.host_port, p.protocol) for c in spec.containers for p in c.ports})},
            confirmed, digest)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
