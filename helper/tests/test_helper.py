# SPDX-License-Identifier: LGPL-2.1-or-later
"""Tests for translation, input validation, secrets and the install flow of
the helper, against a fake runtime (no containers are started)."""

import http.server
import json
import os
import socketserver
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE)))

from pitstore import main, runtime, translate  # noqa: E402
from pitstore.translate import ValidationError  # noqa: E402

APP = {"id": "org.example.demo", "title": "Demo", "version": "1.0", "main": "web", "portMap": "18080"}


def compose(**web):
    svc = {"image": "nginx:1.27", "ports": ["18080:80"]}
    svc.update(web)
    return {"name": "demo", "services": {"web": svc}, "x-casaos": {"id": APP["id"], "main": "web"}}


class FakeRuntime:
    name = "podman"

    def __init__(self):
        self.calls = []
        self.containers = []

    def __getattr__(self, name):
        def call(*args):
            self.calls.append((name, args))
            if name == "create_container":
                spec = args[0]
                self.containers.append({"id": spec.name, "name": spec.name, "state": "created", "status": "",
                                        "image": spec.image,
                                        "labels": spec.labels})
                return spec.name
            return None
        return call

    def list_containers(self, app_id=None):
        return [c for c in self.containers if app_id is None or c["labels"].get(translate.LABEL_APP) == app_id]

    def remove_container(self, cid):
        self.calls.append(("remove_container", (cid,)))
        self.containers = [c for c in self.containers if c["id"] != cid]

    def list_networks(self, app_id):
        return []

    def list_volumes(self, app_id):
        return []


class HelperTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(main, "base_dir", return_value=self.tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        # do not bind real ports on the machine running the tests
        ports = mock.patch.object(main, "check_port_free")
        self.port_check = ports.start()
        self.addCleanup(ports.stop)
        self.addCleanup(self.tmp.cleanup)
        self.rt = FakeRuntime()
        self.progress = []

    def install(self, comp, confirmed=(), update=False):
        req = {"app": APP, "compose": comp, "composeSha256": "a" * 64, "confirmed": list(confirmed), "update": update}
        return main.do_install(req, self.rt, self.progress.append)

    def runtime_calls(self):
        return [c[0] for c in self.rt.calls]


class TestInstall(HelperTestCase):
    def test_privileged_refused_without_confirmation(self):
        """Done-criterion: privileged: true is refused unless confirmed, and the runtime is never called."""
        with self.assertRaisesRegex(ValidationError, "web/privileged"):
            self.install(compose(privileged=True))
        self.assertEqual(self.rt.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "apps", APP["id"])))

    def test_privileged_installs_after_confirmation_and_is_recorded(self):
        self.install(compose(privileged=True), confirmed=["web/privileged"])
        self.assertIn("create_container", self.runtime_calls())
        spec = [c[1][0] for c in self.rt.calls if c[0] == "create_container"][0]
        self.assertTrue(spec.privileged)
        with open(os.path.join(self.tmp.name, "apps", APP["id"], "confirmations.json")) as f:
            records = json.load(f)
        self.assertEqual(records[0]["findings"], ["web/privileged"])
        self.assertEqual(records[0]["composeSha256"], "a" * 64)

    def test_confirmation_of_another_finding_does_not_count(self):
        with self.assertRaises(ValidationError):
            self.install(compose(privileged=True, network_mode="host"), confirmed=["web/privileged"])
        self.assertEqual(self.rt.calls, [])

    def test_unsupported_keys_are_refused(self):
        with self.assertRaisesRegex(ValidationError, "build"):
            self.install(compose(build="."))
        self.assertEqual(self.rt.calls, [])

    def test_clean_install_creates_network_and_container(self):
        result = self.install(compose())
        self.assertEqual(result["containers"], 1)
        self.assertEqual(self.runtime_calls(), ["pull", "create_network", "create_container", "start"])
        spec = self.rt.calls[2][1][0]
        self.assertEqual(spec.image, "docker.io/library/nginx:1.27")
        self.assertEqual(spec.name, "pitstore-org.example.demo-web")
        self.assertEqual(spec.labels[translate.LABEL_APP], APP["id"])
        self.assertEqual(spec.networks, ["pitstore-org.example.demo"])

    def test_ports_are_checked_except_own_ports_on_update(self):
        self.install(compose())
        self.assertEqual(self.port_check.call_count, 1)
        self.install(compose(), update=True)
        self.assertEqual(self.port_check.call_count, 1, "the app's own port is not re-checked on update")

    def test_failed_update_restores_the_previous_state(self):
        self.install(compose())
        adir = os.path.join(self.tmp.name, "apps", APP["id"])
        with open(os.path.join(adir, "plan.json")) as f:
            before = json.load(f)

        def failing_create(spec):
            raise runtime.RuntimeError_("no space left")
        self.rt.create_container = failing_create
        with self.assertRaises(main.HelperError):
            self.install(compose(ports=["18090:80"]), update=True)
        with open(os.path.join(adir, "plan.json")) as f:
            self.assertEqual(json.load(f), before)

    def test_state_is_written_before_containers_are_created(self):
        seen = []
        original = self.rt.__getattr__("create_container")

        def create(spec):
            seen.append(os.path.exists(os.path.join(self.tmp.name, "apps", APP["id"], "plan.json")))
            return original(spec)
        self.rt.create_container = create
        self.install(compose())
        self.assertEqual(seen, [True])

    def test_second_install_is_refused(self):
        self.install(compose())
        with self.assertRaises(main.HelperError):
            self.install(compose())

    def test_secrets_are_generated_stored_privately_and_reused_on_update(self):
        comp = compose(environment={"PASSWORD": "@@pitstore-secret:default@@",
                                    "APP_KEY": "@@pitstore-secret:vabc-32@@",
                                    "URL": "postgres://u:@@pitstore-secret:default@@@db/x"})
        self.install(comp)
        env = self.rt.calls[2][1][0].env
        self.assertRegex(env["PASSWORD"], r"^[A-Za-z0-9]{24}$")
        self.assertRegex(env["APP_KEY"], r"^[A-Za-z0-9]{32}$")
        self.assertEqual(env["URL"], f"postgres://u:{env['PASSWORD']}@db/x")
        adir = os.path.join(self.tmp.name, "apps", APP["id"])
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(adir, "secrets.json")).st_mode), 0o600)
        with open(os.path.join(adir, "plan.json")) as f:
            plan = f.read()
        self.assertNotIn(env["PASSWORD"], plan, "plan.json must not contain secret values")
        self.assertIn("@@pitstore-secret:default@@", plan)

        self.install(comp, update=True)
        env2 = [c[1][0] for c in self.rt.calls if c[0] == "create_container"][-1].env
        self.assertEqual(env2["PASSWORD"], env["PASSWORD"])

    def test_bind_mounts_under_data_dir_are_created(self):
        src = os.path.join(self.tmp.name, "data", APP["id"], "config")
        self.install(compose(volumes=[f"{src}:/config"]))
        self.assertTrue(os.path.isdir(src))

    def test_bind_mount_into_other_app_data_is_refused(self):
        src = os.path.join(self.tmp.name, "data", "org.example.other", "x")
        with self.assertRaisesRegex(main.HelperError, "another app"):
            self.install(compose(volumes=[f"{src}:/x"]))

    def test_symlink_to_system_directory_is_refused(self):
        link = os.path.join(self.tmp.name, "innocent")
        os.symlink("/etc", link)
        with self.assertRaisesRegex(main.HelperError, "resolves to the system directory"):
            self.install(compose(volumes=[f"{link}:/x"]))
        self.assertNotIn("create_container", self.runtime_calls())

    def test_failed_start_rolls_back(self):
        def failing_start(cid):
            raise runtime.RuntimeError_("boom")
        self.rt.start = failing_start
        with self.assertRaisesRegex(main.HelperError, "boom"):
            self.install(compose())
        self.assertEqual(self.rt.containers, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "apps", APP["id"], "plan.json")))


class TestInputValidation(unittest.TestCase):
    def tr(self, comp, rootless=True):
        return translate.translate(comp, APP["id"], "1", rootless)

    def test_ports(self):
        for bad in (["9090:80"], ["0:80"], ["70000:80"], ["8000-8010:80"], ["80"], ["abc:80"], ["1.2.3:8080:80"],
                    [{"target": 80, "published": "8080", "protocol": "sctp"}]):
            with self.subTest(bad), self.assertRaises(ValidationError):
                self.tr(compose(ports=bad))
        with self.assertRaisesRegex(ValidationError, "below 1024"):
            self.tr(compose(ports=["80:80"]))
        spec = self.tr(compose(ports=["80:80"]), rootless=False)
        self.assertEqual(spec.containers[0].ports[0].host_port, 80)
        spec = self.tr(compose(ports=["127.0.0.1:18080:80/udp"]))
        p = spec.containers[0].ports[0]
        self.assertEqual((p.host_ip, p.host_port, p.container_port, p.protocol), ("127.0.0.1", 18080, 80, "udp"))

    def test_host_paths_must_be_normalized(self):
        for bad in ("/srv/../etc:/x", "/srv//x:/x", "/srv/./x:/x", "/srv/x/:/x"):
            with self.subTest(bad), self.assertRaises(ValidationError):
                self.tr(compose(volumes=[bad]))

    def test_env(self):
        for bad in ({"BAD KEY": "x"}, {"K": "a\0b"}, {"K": "x" * 40000}, ["=x"]):
            with self.subTest(repr(bad)[:40]), self.assertRaises(ValidationError):
                self.tr(compose(environment=bad))
        env = self.tr(compose(environment={"A": 1, "B": True, "C": None, "D": "x y"})).containers[0].env
        self.assertEqual(env, {"A": "1", "B": "true", "D": "x y"})

    def test_command_is_an_argv_list(self):
        spec = self.tr(compose(command="sh -c 'echo $HOME; rm -rf /'"))
        self.assertEqual(spec.containers[0].command, ["sh", "-c", "echo $HOME; rm -rf /"])

    def test_images(self):
        n = translate.normalize_image
        self.assertEqual(n("nginx"), "docker.io/library/nginx:latest")
        self.assertEqual(n("linuxserver/sonarr:4"), "docker.io/linuxserver/sonarr:4")
        self.assertEqual(n("ghcr.io/a/b:1.0"), "ghcr.io/a/b:1.0")
        self.assertEqual(n("localhost:5000/x"), "localhost:5000/x:latest")
        self.assertEqual(n("a/b@sha256:" + "0" * 64), "docker.io/a/b@sha256:" + "0" * 64)
        for bad in ("", "UPPER/case", "a b", "a/b:t@g", "-x", "a/../b", "a;rm -rf /"):
            with self.subTest(bad), self.assertRaises(ValidationError):
                n(bad)

    def test_depends_on_order_and_cycles(self):
        comp = compose(depends_on=["db"])
        comp["services"]["db"] = {"image": "postgres:16"}
        self.assertEqual([c.service for c in self.tr(comp).containers], ["db", "web"])
        comp["services"]["db"]["depends_on"] = ["web"]
        with self.assertRaisesRegex(ValidationError, "cycle"):
            self.tr(comp)

    def test_durations_and_sizes(self):
        self.assertEqual(translate.parse_duration_ns("1m30s", "x"), 90 * 10 ** 9)
        self.assertEqual(translate.parse_size("64M", "x"), 64 * 1024 ** 2)
        self.assertEqual(translate.parse_size("1gb", "x"), 1024 ** 3)


class _Handler(http.server.BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        _Handler.requests.append((self.command, self.path, body))
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        payload = json.dumps({"Id": "abc"}).encode()
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_DELETE = do_POST

    def log_message(self, *args):
        pass


class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    def get_request(self):
        request, _ = super().get_request()
        return request, ("local", 0)


class TestRuntimeWire(unittest.TestCase):
    """Requests on the socket: encoded paths, JSON bodies."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "podman.sock")
        self.server = _UnixHTTPServer(self.path, _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        _Handler.requests = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_path_segments_are_encoded(self):
        rt = runtime.PodmanRuntime(self.path)
        rt.start("x/../../images;rm -rf /")
        rt.remove_container("a b?c")
        self.assertEqual(_Handler.requests[0][1], "/v4.0.0/libpod/containers/x%2F..%2F..%2Fimages%3Brm%20-rf%20%2F/start")
        self.assertTrue(_Handler.requests[1][1].startswith("/v4.0.0/libpod/containers/a%20b%3Fc?"))

    def test_create_body_is_json(self):
        spec = translate.translate(compose(environment={"X": "'; rm -rf / #"}), APP["id"], "1", True).containers[0]
        runtime.PodmanRuntime(self.path).create_container(spec)
        body = json.loads(_Handler.requests[0][2])
        self.assertEqual(body["env"], {"X": "'; rm -rf / #"})
        self.assertEqual(body["portmappings"], [{"host_port": 18080, "container_port": 80, "protocol": "tcp"}])
        self.assertEqual(body["Networks"], {"pitstore-org.example.demo": {"aliases": ["web"]}})

    def test_socket_checks(self):
        runtime.check_socket(self.path, os.getuid())
        with self.assertRaisesRegex(runtime.RuntimeError_, "does not exist"):
            runtime.check_socket(self.path + ".missing", os.getuid())
        with self.assertRaisesRegex(runtime.RuntimeError_, "not a socket"):
            runtime.check_socket(self.tmp.name, os.getuid())


class TestEntryPoint(unittest.TestCase):
    def run_main(self, verb, payload):
        stdin = mock.MagicMock()
        stdin.buffer.read.return_value = payload
        out = []
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(main, "emit", out.append):
            code = main.main(["pitstore-helper", verb])
        return code, out

    def test_rejects_oversized_and_malformed_requests(self):
        self.assertEqual(self.run_main("list", b"x" * (main.MAX_REQUEST + 1))[0], 1)
        code, out = self.run_main("list", b"[1]")
        self.assertEqual((code, out[0]["type"]), (1, "error"))
        code, out = self.run_main("frobnicate", b'{"backend": "podman", "scope": "user"}')
        self.assertEqual(code, 1)

    def test_docker_needs_root(self):
        if os.geteuid() == 0:
            self.skipTest("running as root")
        code, out = self.run_main("list", b'{"backend": "docker", "scope": "user"}')
        self.assertEqual(code, 1)
        self.assertIn("administrative access", out[0]["message"])

    def test_system_scope_never_falls_back_to_the_user(self):
        if os.geteuid() == 0:
            self.skipTest("running as root")
        code, out = self.run_main("list", b'{"backend": "podman", "scope": "system"}')
        self.assertEqual(code, 1)
        self.assertIn("administrative access", out[0]["message"])
        code, out = self.run_main("list", b'{"backend": "podman"}')
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
