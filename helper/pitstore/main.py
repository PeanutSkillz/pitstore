# SPDX-License-Identifier: LGPL-2.1-or-later
"""pitstore-helper: one request per process.

The Cockpit page runs this through the bridge with a fixed argv; the request
is JSON on stdin. Progress and the result are JSON lines on stdout:
    {"type": "progress", "message": "..."}
    {"type": "result", ...}  or  {"type": "error", "message": "..."}

Running as root only happens through Cockpit's superuser mechanism. State:
    root:  /var/lib/pitstore/{apps,data}/<id>
    user:  ~/.local/share/pitstore/{apps,data}/<id>
"""

import datetime
import errno
import json
import os
import pwd
import re
import secrets
import shutil
import signal
import socket
import string
import sys

from . import policy
from .runtime import RuntimeError_, open_runtime
from .translate import LABEL_APP, LABEL_SERVICE, ValidationError, check_app_id, translate

MAX_REQUEST = 1024 * 1024
SECRET_RE = re.compile(r"@@pitstore-secret:([a-z0-9-]{1,32})@@")
SECRET_ALPHABET = string.ascii_letters + string.digits
APP_FIELDS = {"id", "title", "version", "icon", "store", "contentHash", "main", "portMap", "scheme", "index"}


class HelperError(Exception):
    pass


def emit(obj):
    # the page may have gone away (browser closed); finish the work anyway
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass


def base_dir():
    if os.geteuid() == 0:
        return "/var/lib/pitstore"
    # from the password database, not from $HOME
    return os.path.join(pwd.getpwuid(os.geteuid()).pw_dir, ".local", "share", "pitstore")


def app_dir(app_id):
    return os.path.join(base_dir(), "apps", check_app_id(app_id))


def data_dir(app_id):
    return os.path.join(base_dir(), "data", check_app_id(app_id))


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def walk_strings(value, fn):
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, list):
        return [walk_strings(v, fn) for v in value]
    if isinstance(value, dict):
        return {k: walk_strings(v, fn) for k, v in value.items()}
    return value


def fill_secrets(compose, stored):
    """Replace @@pitstore-secret:<key>@@ placeholders with random values.
    Values of keys seen before (stored) are reused, so updates keep them."""
    values = dict(stored)

    def repl(m):
        key = m.group(1)
        if key not in values:
            # "<name>-<length>" asks for a specific length (16..64), default 24
            m = re.search(r"-([0-9]{1,2})$", key)
            length = min(64, max(16, int(m.group(1)))) if m else 24
            values[key] = "".join(secrets.choice(SECRET_ALPHABET) for _ in range(length))
        return values[key]

    services = walk_strings(compose["services"], lambda s: SECRET_RE.sub(repl, s))
    return {**compose, "services": services}, values


def check_port_free(port):
    family = socket.AF_INET6 if ":" in port.host_ip else socket.AF_INET
    kind = socket.SOCK_STREAM if port.protocol == "tcp" else socket.SOCK_DGRAM
    with socket.socket(family, kind) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((port.host_ip, port.host_port))
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                raise HelperError(f"port {port.host_port}/{port.protocol} is already in use") from None
            raise HelperError(f"port {port.host_port}/{port.protocol} cannot be used: {e.strerror}") from None


def prepare_bind(source, app_id):
    """Bind sources under the app's data directory are created; anything else
    must already exist. Symlinks are resolved and checked again."""
    data_root = os.path.join(base_dir(), "data")
    if source == data_root or source.startswith(data_root + "/"):
        if not source.startswith(data_dir(app_id) + "/") and source != data_dir(app_id) and \
                not source.startswith(os.path.join(data_root, "shared") + "/"):
            raise HelperError(f"{source} belongs to another app")
        os.makedirs(source, mode=0o755, exist_ok=True)
    elif not os.path.exists(source):
        raise HelperError(f"{source} does not exist")
    real = os.path.realpath(source)
    if real != source:
        for prefix in policy.SENSITIVE_PATHS:
            if policy.is_under(real, prefix) or policy.is_under(prefix, real):
                raise HelperError(f"{source} resolves to the system directory {real}")
        if real.split("/")[-1] in policy.RUNTIME_SOCKETS:
            raise HelperError(f"{source} resolves to a container runtime socket")


def app_containers(rt, app_id):
    return [c for c in rt.list_containers(app_id) if c["labels"].get(LABEL_APP) == app_id]


def redact(message, values):
    for v in values:
        if v:
            message = message.replace(v, "********")
    return message


# --- verbs ------------------------------------------------------------------

def do_install(req, rt, progress):
    app = req.get("app")
    if not isinstance(app, dict) or set(app) - APP_FIELDS:
        raise HelperError("invalid app description")
    for k, v in app.items():
        if not isinstance(v, str) or len(v) > 2048 or "\0" in v:
            raise HelperError(f"invalid app field {k}")
    app_id = check_app_id(app.get("id"))
    compose = req.get("compose")
    if not isinstance(compose, dict) or not isinstance(compose.get("services"), dict):
        raise HelperError("invalid compose data")
    sha = req.get("composeSha256")
    if not isinstance(sha, str) or not re.match(r"^[a-f0-9]{64}$", sha):
        raise HelperError("invalid compose hash")
    confirmed = req.get("confirmed") or []
    if not isinstance(confirmed, list) or not all(isinstance(c, str) for c in confirmed):
        raise HelperError("invalid confirmations")
    is_update = req.get("update") is True

    adir = app_dir(app_id)
    old_plan = read_json(os.path.join(adir, "plan.json"))
    if is_update and not old_plan:
        raise HelperError(f"{app_id} is not installed")
    if not is_update and (old_plan or app_containers(rt, app_id)):
        raise HelperError(f"{app_id} is already installed")

    secrets_file = os.path.join(adir, "secrets.json")
    filled, secret_values = fill_secrets(compose, read_json(secrets_file, {}))
    hidden = list(secret_values.values())
    if SECRET_RE.search(json.dumps(filled)):
        raise HelperError("unresolved secret placeholder")

    rootless = os.geteuid() != 0 and rt.name == "podman"
    # policy, confirmations and every value are validated here, before the runtime is called
    spec = translate(filled, app_id, app.get("version", ""), rootless, confirmed)

    old_ports = set()
    if is_update:
        for c in old_plan.get("ports", []):
            old_ports.add((c[0], c[1]))
    for c in spec.containers:
        for p in c.ports:
            if (p.host_port, p.protocol) not in old_ports:
                check_port_free(p)
        for m in c.mounts:
            if m.kind == "bind":
                prepare_bind(m.source, app_id)

    verdict = policy.evaluate(filled)
    record = {
        "composeSha256": sha,
        "findings": [f["key"] for f in verdict["findings"]],
        # under Cockpit's superuser mechanism sudo records the real user
        "confirmedBy": (os.environ.get("SUDO_USER") if os.geteuid() == 0 else None) or pwd.getpwuid(os.getuid()).pw_name,
        "confirmedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }

    for image in sorted({c.image for c in spec.containers}):
        progress(f"Pulling {image}")
        rt.pull(image, lambda line: progress(line[:200]))

    # record the new state before touching containers: if this process is
    # interrupted (browser closed), the app stays known and can be repaired
    plan_file = os.path.join(adir, "plan.json")
    confirmations_file = os.path.join(adir, "confirmations.json")
    saved = {f: read_json(f) for f in (plan_file, confirmations_file, secrets_file)}
    os.makedirs(adir, mode=0o700, exist_ok=True)
    write_json(secrets_file, secret_values, mode=0o600)
    confirmations = read_json(confirmations_file, [])
    if record["findings"]:
        confirmations.append(record)
    write_json(confirmations_file, confirmations)
    write_json(plan_file, {
        "app": app,
        "backend": rt.name,
        "compose": compose,            # with placeholders, never the secret values
        "composeSha256": sha,
        "order": [c.service for c in spec.containers],
        "ports": sorted({(p.host_port, p.protocol) for c in spec.containers for p in c.ports}),
        "installedAt": record["confirmedAt"],
    })

    created = []
    try:
        if is_update:
            progress("Removing the old containers")
            for c in reversed(app_containers(rt, app_id)):
                rt.remove_container(c["id"])
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
    except (RuntimeError_, HelperError, OSError) as e:
        progress("Installation failed, removing the new containers")
        for cid in reversed(created):
            try:
                rt.remove_container(cid)
            except RuntimeError_:
                pass
        if is_update:
            for f, data in saved.items():
                if data is not None:
                    write_json(f, data, mode=0o600 if f == secrets_file else 0o644)
        else:
            shutil.rmtree(adir, ignore_errors=True)
        raise HelperError(redact(str(e), hidden)) from None

    return {"app": app_id, "containers": len(created), "updated": is_update}


def do_lifecycle(req, rt, action):
    app_id = check_app_id(req.get("appId"))
    plan = read_json(os.path.join(app_dir(app_id), "plan.json"), {})
    containers = {c["labels"].get(LABEL_SERVICE): c for c in app_containers(rt, app_id)}
    if not containers:
        raise HelperError(f"{app_id} has no containers")
    order = [s for s in plan.get("order", []) if s in containers] or sorted(containers)
    order += [s for s in containers if s not in order]
    if action == "stop":
        order.reverse()
    for service in order:
        getattr(rt, action)(containers[service]["id"])
    return {"app": app_id, "action": action}


def do_remove(req, rt, progress):
    app_id = check_app_id(req.get("appId"))
    for c in reversed(app_containers(rt, app_id)):
        progress(f"Removing {c['name']}")
        rt.remove_container(c["id"])
    for n in rt.list_networks(app_id):
        rt.remove_network(n)
    delete_data = req.get("deleteData") is True
    if delete_data:
        for v in rt.list_volumes(app_id):
            rt.remove_volume(v)
        ddir = data_dir(app_id)
        if os.path.isdir(ddir) and not os.path.islink(ddir):
            progress(f"Deleting {ddir}")
            shutil.rmtree(ddir)
    adir = app_dir(app_id)
    if os.path.isdir(adir) and not os.path.islink(adir):
        shutil.rmtree(adir)
    return {"app": app_id, "dataDeleted": delete_data}


def do_list(rt):
    apps = {}
    for c in rt.list_containers():
        app_id = c["labels"].get(LABEL_APP)
        try:
            check_app_id(app_id)
        except ValidationError:
            continue
        entry = apps.setdefault(app_id, {"id": app_id, "containers": []})
        entry["containers"].append({k: c[k] for k in ("name", "state", "status", "image")} |
                                   {"service": c["labels"].get(LABEL_SERVICE, "")})
    apps_root = os.path.join(base_dir(), "apps")
    for app_id in sorted(os.listdir(apps_root)) if os.path.isdir(apps_root) else []:
        try:
            check_app_id(app_id)
        except ValidationError:
            continue
        plan = read_json(os.path.join(apps_root, app_id, "plan.json"))
        if plan:
            entry = apps.setdefault(app_id, {"id": app_id, "containers": []})
            entry["app"] = plan.get("app", {})
            entry["installedAt"] = plan.get("installedAt")
    return {"backend": rt.name, "apps": sorted(apps.values(), key=lambda a: a["id"])}


def do_get(req):
    app_id = check_app_id(req.get("appId"))
    plan = read_json(os.path.join(app_dir(app_id), "plan.json"))
    if not plan:
        raise HelperError(f"{app_id} is not installed")
    return {"plan": plan, "dataDir": data_dir(app_id)}


def handle(verb, req):
    if verb == "info":
        return {"uid": os.geteuid(), "baseDir": base_dir()}
    # the page states which scope it expects; never fall back silently from
    # the system scope (superuser) to the user's own rootless runtime
    scope = req.get("scope")
    if scope not in ("user", "system") or (scope == "system") != (os.geteuid() == 0):
        raise HelperError("administrative access is required" if scope == "system" else "invalid scope")
    backend = req.get("backend")
    if verb == "get":
        return do_get(req)
    rt = open_runtime(backend)
    if verb == "ping":
        return {"backend": rt.name, "version": rt.ping()}
    if verb == "list":
        return do_list(rt)
    if verb in ("install", "remove"):
        def progress(message):
            emit({"type": "progress", "message": message})
        return do_install(req, rt, progress) if verb == "install" else do_remove(req, rt, progress)
    if verb in ("start", "stop", "restart"):
        return do_lifecycle(req, rt, verb)
    raise HelperError(f"unknown verb {verb!r}")


def main(argv):
    if len(argv) != 2:
        emit({"type": "error", "message": "usage: pitstore-helper VERB < request.json"})
        return 2
    os.umask(0o022)
    # keep going when the Cockpit session ends in the middle of a request
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        emit({"type": "error", "message": "request is too large"})
        return 1
    try:
        req = json.loads(raw or b"{}")
        if not isinstance(req, dict):
            raise ValueError("request must be an object")
        result = handle(argv[1], req)
    except (HelperError, ValidationError, RuntimeError_, ValueError) as e:
        emit({"type": "error", "message": str(e)})
        return 1
    emit({"type": "result", **result})
    return 0
