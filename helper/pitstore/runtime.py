# SPDX-License-Identifier: LGPL-2.1-or-later
"""Container runtime access over the API socket (HTTP over AF_UNIX).

Two backends share one interface: Podman (libpod API) and Docker (Engine API).
Request bodies are built from dicts with json.dumps, and every URL path
segment and query value is percent-encoded. No command strings anywhere.
"""

import http.client
import json
import os
import socket
import stat
from urllib.parse import quote, urlencode

from .translate import LABEL_APP

PODMAN_SYSTEM_SOCKET = "/run/podman/podman.sock"
DOCKER_SOCKET = "/run/docker.sock"
API_TIMEOUT = 300


class RuntimeError_(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


def seg(value):
    """One percent-encoded URL path segment."""
    return quote(str(value), safe="")


def check_socket(path, uid):
    """The socket must be a socket owned by root or by the expected user."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        raise RuntimeError_(f"container runtime socket {path} does not exist") from None
    if not stat.S_ISSOCK(st.st_mode):
        raise RuntimeError_(f"{path} is not a socket")
    if st.st_uid not in (0, uid):
        raise RuntimeError_(f"{path} is owned by an unexpected user")
    if st.st_mode & stat.S_IWOTH:
        raise RuntimeError_(f"{path} is world-writable")


class Client:
    def __init__(self, socket_path, prefix):
        self.socket_path = socket_path
        self.prefix = prefix

    def request(self, method, path, query=None, body=None, timeout=API_TIMEOUT, stream=None):
        url = self.prefix + path
        if query:
            url += "?" + urlencode(query)
        conn = UnixHTTPConnection(self.socket_path, timeout)
        try:
            headers = {"Content-Type": "application/json"} if body is not None else {}
            conn.request(method, url, body=json.dumps(body) if body is not None else None, headers=headers)
            resp = conn.getresponse()
            if stream and 200 <= resp.status < 300:
                for line in resp:
                    line = line.strip()
                    if line:
                        stream(json.loads(line))
                return resp.status, None
            data = resp.read()
        except (OSError, http.client.HTTPException) as e:
            raise RuntimeError_(f"container runtime is not reachable: {e}") from None
        finally:
            conn.close()
        payload = None
        if data:
            try:
                payload = json.loads(data)
            except ValueError:
                payload = data.decode(errors="replace")
        if resp.status >= 400:
            message = payload.get("message") if isinstance(payload, dict) else payload
            raise RuntimeError_(f"{method} {path}: HTTP {resp.status}: {message}", resp.status)
        return resp.status, payload


def _labels_filter(app_id=None):
    label = f"{LABEL_APP}={app_id}" if app_id else LABEL_APP
    return json.dumps({"label": [label]})


class PodmanRuntime:
    name = "podman"

    def __init__(self, socket_path):
        self.client = Client(socket_path, "/v4.0.0/libpod")

    def ping(self):
        _, info = self.client.request("GET", "/version")
        return info

    def pull(self, image, progress):
        def on_line(msg):
            if msg.get("error"):
                raise RuntimeError_(f"pulling {image} failed: {msg['error']}")
            if msg.get("stream"):
                progress(msg["stream"].strip())
        self.client.request("POST", "/images/pull", {"reference": image, "quiet": "false"},
                            timeout=None, stream=on_line)

    def network_exists(self, name):
        try:
            self.client.request("GET", f"/networks/{seg(name)}/exists")
            return True
        except RuntimeError_ as e:
            if e.status == 404:
                return False
            raise

    def create_network(self, name, labels):
        if not self.network_exists(name):
            self.client.request("POST", "/networks/create", body={"name": name, "labels": labels, "dns_enabled": True})

    def create_volume(self, name, labels):
        try:
            self.client.request("GET", f"/volumes/{seg(name)}/exists")
            return
        except RuntimeError_ as e:
            if e.status != 404:
                raise
        self.client.request("POST", "/volumes/create", body={"Name": name, "Label": labels})

    def create_container(self, spec):
        body = {
            "name": spec.name,
            "image": spec.image,
            "env": spec.env,
            "labels": spec.labels,
            "restart_policy": spec.restart,
            "terminal": spec.tty,
            "stdin": spec.stdin_open,
            "privileged": spec.privileged,
            "cap_add": spec.cap_add,
            "cap_drop": spec.cap_drop,
            "selinux_opts": [],
        }
        if spec.restart == "on-failure" and spec.restart_retries:
            body["restart_tries"] = spec.restart_retries
        if spec.command is not None:
            body["command"] = spec.command
        if spec.entrypoint is not None:
            body["entrypoint"] = spec.entrypoint
        if spec.network_mode == "bridge":
            body["netns"] = {"nsmode": "bridge"}
            body["Networks"] = {n: {"aliases": [spec.service]} for n in spec.networks}
            body["portmappings"] = [
                {"host_port": p.host_port, "container_port": p.container_port, "protocol": p.protocol,
                 **({"host_ip": p.host_ip} if p.host_ip else {})}
                for p in spec.ports]
        else:
            body["netns"] = {"nsmode": spec.network_mode}
        mounts, volumes = [], []
        for m in spec.mounts:
            if m.kind == "bind":
                mounts.append({"destination": m.target, "source": m.source, "type": "bind",
                               "options": ["rbind"] + (["ro"] if m.read_only else [])})
            elif m.kind == "tmpfs":
                mounts.append({"destination": m.target, "type": "tmpfs", "source": "tmpfs", "options": []})
            elif m.source:
                volumes.append({"Name": m.source, "Dest": m.target, "Options": ["ro"] if m.read_only else []})
            else:
                body.setdefault("anonymous_volumes", []).append({"Destination": m.target})
        body["mounts"] = mounts
        body["volumes"] = volumes
        if spec.healthcheck:
            hc = {"Test": spec.healthcheck["test"]}
            for src, dst in (("interval", "Interval"), ("timeout", "Timeout"), ("start_period", "StartPeriod"),
                             ("retries", "Retries")):
                if src in spec.healthcheck:
                    hc[dst] = spec.healthcheck[src]
            body["healthconfig"] = hc
        if spec.user:
            body["user"] = spec.user
        if spec.working_dir:
            body["work_dir"] = spec.working_dir
        if spec.hostname:
            body["hostname"] = spec.hostname
        if spec.stop_signal:
            body["stop_signal"] = 15 if spec.stop_signal == "SIGTERM" else spec.stop_signal
        if spec.stop_timeout is not None:
            body["stop_timeout"] = spec.stop_timeout
        if spec.shm_size is not None:
            body["shm_size"] = spec.shm_size
        if spec.pid_host:
            body["pidns"] = {"nsmode": "host"}
        if spec.ipc_mode:
            body["ipcns"] = {"nsmode": "host" if spec.ipc_mode == "host" else "private"}
        if spec.uts_host:
            body["utsns"] = {"nsmode": "host"}
        if spec.devices:
            body["devices"] = [{"path": f"{h}:{c}:{p}"} for h, c, p in spec.devices]
        if spec.security_opt:
            for opt in spec.security_opt:
                key, _, value = opt.replace("=", ":", 1).partition(":")
                if key == "apparmor":
                    body["apparmor_profile"] = value
                elif key == "seccomp":
                    body["seccomp_policy" if value == "image" else "seccomp_profile_path"] = value
                elif key == "label":
                    body["selinux_opts"].append(value)
                elif key == "no-new-privileges":
                    body["no_new_privileges"] = value in ("", "true")
        if spec.sysctls:
            body["sysctl"] = spec.sysctls
        if spec.ulimits:
            body["r_limits"] = [{"type": f"RLIMIT_{n.upper()}", "soft": s, "hard": h} for n, s, h in spec.ulimits]
        if spec.extra_hosts:
            body["hostadd"] = spec.extra_hosts
        if spec.init:
            body["init"] = True
        resources = {}
        if spec.memory_limit or spec.memory_reservation:
            resources["memory"] = {k: v for k, v in (("limit", spec.memory_limit),
                                                     ("reservation", spec.memory_reservation)) if v}
        if spec.nano_cpus or spec.cpu_shares:
            cpu = {}
            if spec.nano_cpus:
                cpu.update({"quota": spec.nano_cpus // 10_000, "period": 100_000})
            if spec.cpu_shares:
                cpu["shares"] = spec.cpu_shares
            resources["cpu"] = cpu
        if resources:
            body["resource_limits"] = resources
        _, result = self.client.request("POST", "/containers/create", body=body)
        return result["Id"]

    def start(self, cid):
        self.client.request("POST", f"/containers/{seg(cid)}/start")

    def stop(self, cid, timeout=10):
        self.client.request("POST", f"/containers/{seg(cid)}/stop", {"timeout": timeout})

    def restart(self, cid):
        self.client.request("POST", f"/containers/{seg(cid)}/restart")

    def remove_container(self, cid):
        self.client.request("DELETE", f"/containers/{seg(cid)}", {"force": "true", "v": "true"})

    def remove_network(self, name):
        self.client.request("DELETE", f"/networks/{seg(name)}")

    def remove_volume(self, name):
        self.client.request("DELETE", f"/volumes/{seg(name)}", {"force": "true"})

    def list_containers(self, app_id=None):
        _, result = self.client.request("GET", "/containers/json", {"all": "true", "filters": _labels_filter(app_id)})
        return [{
            "id": c["Id"],
            "name": (c.get("Names") or [""])[0],
            "labels": c.get("Labels") or {},
            "state": c.get("State", ""),
            "status": c.get("Status", ""),
            "health": (c.get("Status") or "").lower(),
            "image": c.get("Image", ""),
        } for c in result or []]

    def list_volumes(self, app_id):
        _, result = self.client.request("GET", "/volumes/json", {"filters": _labels_filter(app_id)})
        return [v["Name"] for v in result or []]

    def list_networks(self, app_id):
        _, result = self.client.request("GET", "/networks/json", {"filters": _labels_filter(app_id)})
        return [n["name"] for n in result or []]


class DockerRuntime:
    name = "docker"

    def __init__(self, socket_path=DOCKER_SOCKET):
        self.client = Client(socket_path, "/v1.41")

    def ping(self):
        _, info = self.client.request("GET", "/version")
        return info

    def pull(self, image, progress):
        name, digest = (image.split("@", 1) + [None])[:2]
        ref, tag = name, None
        if ":" in name.rsplit("/", 1)[-1]:
            ref, tag = name.rsplit(":", 1)
        query = {"fromImage": ref, "tag": digest or tag or "latest"}

        def on_line(msg):
            if msg.get("error"):
                raise RuntimeError_(f"pulling {image} failed: {msg['error']}")
            if msg.get("status") and not msg.get("progressDetail"):
                progress(" ".join(filter(None, [msg.get("id"), msg["status"]])))
        self.client.request("POST", "/images/create", query, timeout=None, stream=on_line)

    def create_network(self, name, labels):
        _, nets = self.client.request("GET", "/networks", {"filters": json.dumps({"name": [name]})})
        if not any(n.get("Name") == name for n in nets or []):
            self.client.request("POST", "/networks/create", body={"Name": name, "Labels": labels, "CheckDuplicate": True})

    def create_volume(self, name, labels):
        self.client.request("POST", "/volumes/create", body={"Name": name, "Labels": labels})

    def create_container(self, spec):
        host = {
            "RestartPolicy": {"Name": "" if spec.restart == "no" else spec.restart,
                              "MaximumRetryCount": spec.restart_retries},
            "Privileged": spec.privileged,
            "CapAdd": spec.cap_add or None,
            "CapDrop": spec.cap_drop or None,
            "Mounts": [],
            "NetworkMode": spec.networks[0] if spec.network_mode == "bridge" else spec.network_mode,
        }
        body = {
            "Image": spec.image,
            "Env": [f"{k}={v}" for k, v in spec.env.items()],
            "Labels": spec.labels,
            "Tty": spec.tty,
            "OpenStdin": spec.stdin_open,
            "HostConfig": host,
        }
        if spec.command is not None:
            body["Cmd"] = spec.command
        if spec.entrypoint is not None:
            body["Entrypoint"] = spec.entrypoint
        if spec.network_mode == "bridge":
            body["ExposedPorts"] = {f"{p.container_port}/{p.protocol}": {} for p in spec.ports}
            bindings = {}
            for p in spec.ports:
                bindings.setdefault(f"{p.container_port}/{p.protocol}", []).append(
                    {"HostIp": p.host_ip, "HostPort": str(p.host_port)})
            host["PortBindings"] = bindings
            body["NetworkingConfig"] = {"EndpointsConfig": {n: {"Aliases": [spec.service]} for n in spec.networks}}
        for m in spec.mounts:
            if m.kind == "bind":
                host["Mounts"].append({"Type": "bind", "Source": m.source, "Target": m.target, "ReadOnly": m.read_only})
            elif m.kind == "tmpfs":
                host["Mounts"].append({"Type": "tmpfs", "Target": m.target})
            else:
                host["Mounts"].append({"Type": "volume", "Target": m.target, "ReadOnly": m.read_only,
                                       **({"Source": m.source} if m.source else {})})
        if spec.healthcheck:
            hc = {"Test": spec.healthcheck["test"]}
            for src, dst in (("interval", "Interval"), ("timeout", "Timeout"), ("start_period", "StartPeriod"),
                             ("retries", "Retries")):
                if src in spec.healthcheck:
                    hc[dst] = spec.healthcheck[src]
            body["Healthcheck"] = hc
        if spec.user:
            body["User"] = spec.user
        if spec.working_dir:
            body["WorkingDir"] = spec.working_dir
        if spec.hostname:
            body["Hostname"] = spec.hostname
        if spec.stop_signal:
            body["StopSignal"] = spec.stop_signal
        if spec.stop_timeout is not None:
            body["StopTimeout"] = spec.stop_timeout
        if spec.shm_size is not None:
            host["ShmSize"] = spec.shm_size
        if spec.pid_host:
            host["PidMode"] = "host"
        if spec.ipc_mode:
            host["IpcMode"] = spec.ipc_mode
        if spec.uts_host:
            host["UTSMode"] = "host"
        if spec.devices:
            host["Devices"] = [{"PathOnHost": h, "PathInContainer": c, "CgroupPermissions": p} for h, c, p in spec.devices]
        if spec.security_opt:
            host["SecurityOpt"] = spec.security_opt
        if spec.sysctls:
            host["Sysctls"] = spec.sysctls
        if spec.ulimits:
            host["Ulimits"] = [{"Name": n, "Soft": s, "Hard": h} for n, s, h in spec.ulimits]
        if spec.extra_hosts:
            host["ExtraHosts"] = spec.extra_hosts
        if spec.init:
            host["Init"] = True
        if spec.memory_limit:
            host["Memory"] = spec.memory_limit
        if spec.memory_reservation:
            host["MemoryReservation"] = spec.memory_reservation
        if spec.nano_cpus:
            host["NanoCpus"] = spec.nano_cpus
        if spec.cpu_shares:
            host["CpuShares"] = spec.cpu_shares
        _, result = self.client.request("POST", "/containers/create", {"name": spec.name}, body=body)
        return result["Id"]

    def start(self, cid):
        self.client.request("POST", f"/containers/{seg(cid)}/start")

    def stop(self, cid, timeout=10):
        self.client.request("POST", f"/containers/{seg(cid)}/stop", {"t": timeout})

    def restart(self, cid):
        self.client.request("POST", f"/containers/{seg(cid)}/restart")

    def remove_container(self, cid):
        self.client.request("DELETE", f"/containers/{seg(cid)}", {"force": "true", "v": "true"})

    def remove_network(self, name):
        self.client.request("DELETE", f"/networks/{seg(name)}")

    def remove_volume(self, name):
        self.client.request("DELETE", f"/volumes/{seg(name)}", {"force": "true"})

    def list_containers(self, app_id=None):
        _, result = self.client.request("GET", "/containers/json", {"all": "true", "filters": _labels_filter(app_id)})
        return [{
            "id": c["Id"],
            "name": (c.get("Names") or [""])[0].lstrip("/"),
            "labels": c.get("Labels") or {},
            "state": c.get("State", ""),
            "status": c.get("Status", ""),
            "health": (c.get("Status") or "").lower(),
            "image": c.get("Image", ""),
        } for c in result or []]

    def list_volumes(self, app_id):
        _, result = self.client.request("GET", "/volumes", {"filters": _labels_filter(app_id)})
        return [v["Name"] for v in (result or {}).get("Volumes") or []]

    def list_networks(self, app_id):
        _, result = self.client.request("GET", "/networks", {"filters": _labels_filter(app_id)})
        return [n["Name"] for n in result or []]


def open_runtime(backend):
    """Pick the socket for a backend. Root (via Cockpit superuser) uses the
    system sockets; a normal user can only use rootless Podman."""
    uid = os.geteuid()
    if backend == "podman":
        if uid == 0:
            path = PODMAN_SYSTEM_SOCKET
        else:
            runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
            path = os.path.join(runtime_dir, "podman", "podman.sock")
        check_socket(path, uid)
        return PodmanRuntime(path)
    if backend == "docker":
        if uid != 0:
            raise RuntimeError_("the Docker backend needs administrative access")
        check_socket(DOCKER_SOCKET, 0)
        return DockerRuntime(DOCKER_SOCKET)
    raise RuntimeError_(f"unknown backend {backend!r}")
