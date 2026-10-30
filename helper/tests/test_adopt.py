# SPDX-License-Identifier: LGPL-2.1-or-later
"""Tests for showing and taking over existing containers (adopt.py)."""

import copy
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from pitstore import adopt, main, runtime  # noqa: E402

IMG_WEB = "a" * 64
IMG_DB = "b" * 64


def container(name, image, image_id, project="romm", service=None, running=True, privileged=False,
              mounts=(), ports=None, restart="unless-stopped", labels=None, devices=None):
    lbl = {"com.docker.compose.project": project, "com.docker.compose.service": service or name} if project else {}
    lbl.update(labels or {})
    return {
        "Id": name + "-id", "Name": "/" + name, "Image": "sha256:" + image_id,
        "State": {"Running": running},
        "Config": {"Image": image, "Env": ["PATH=/usr/bin", "DB_PASSWD=hunter2", "TZ=UTC"], "Labels": lbl,
                   "Cmd": ["serve"]},
        "HostConfig": {"Privileged": privileged, "NetworkMode": f"{project or name}_default",
                       "RestartPolicy": {"Name": restart}, "PortBindings": ports or {}, "ShmSize": 67108864,
                       "Devices": devices or []},
        "Mounts": list(mounts),
    }


def listing(info):
    return {"Id": info["Id"], "Names": [info["Name"]], "Image": info["Config"]["Image"],
            "State": "running" if info["State"]["Running"] else "exited", "Status": "",
            "Labels": info["Config"]["Labels"],
            "Ports": [{"PrivatePort": int(k.split("/")[0]), "PublicPort": int(v[0]["HostPort"]), "Type": k.split("/")[1]}
                      for k, v in info["HostConfig"]["PortBindings"].items()]}


class FakeRuntime:
    name = "docker"

    def __init__(self, infos):
        self.infos = {i["Name"].lstrip("/"): i for i in infos}
        self.calls = []
        self.fail_on = None
        self.compat = mock.Mock()
        self.compat.request.side_effect = lambda *a, **k: self.calls.append(("compat",) + a)

    def list_all(self):
        return [listing(i) for i in self.infos.values()]

    def list_containers(self, app_id=None):
        return []  # containers with PitStore labels

    def inspect(self, name):
        for i in self.infos.values():
            if name in (i["Name"].lstrip("/"), i["Id"]):
                return copy.deepcopy(i)
        raise runtime.RuntimeError_("no such container", 404)

    def rename(self, cid, new):
        self.calls.append(("rename", cid, new))
        for key, i in list(self.infos.items()):
            if i["Id"] == cid:
                i["Name"] = "/" + new
                self.infos[new] = self.infos.pop(key)

    def __getattr__(self, name):
        def call(*args):
            self.calls.append((name,) + args)
            if self.fail_on == name:
                raise runtime.RuntimeError_("boom")
            if name == "create_container":
                return args[0].name
        return call

    def mutations(self):
        return [c[0] for c in self.calls]


def romm(**web_kw):
    web = container("romm", "rommapp/romm:4.8.1", IMG_WEB, service="romm",
                    mounts=[{"Type": "bind", "Source": "/DATA/AppData/romm/library", "Destination": "/romm/library", "RW": True},
                            {"Type": "volume", "Name": "romm_data", "Destination": "/data", "RW": True}],
                    ports={"8080/tcp": [{"HostIp": "", "HostPort": "8285"}]}, **web_kw)
    db = container("romm-db", "mariadb:11.8.2", IMG_DB, service="romm-db")
    return [web, db]


class AdoptTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = mock.patch.object(main, "base_dir", return_value=self.tmp.name)
        p.start()
        self.addCleanup(p.stop)
        self.progress = []

    def analyze(self, rt, key="romm"):
        return adopt.analyze(rt, key)

    def do_adopt(self, rt, choices, app_id="local.romm"):
        req = {"group": "romm", "appId": app_id, "title": "RomM", "choices": choices}
        with mock.patch.object(main, "check_port_free"), mock.patch.object(main, "prepare_bind"):
            return main.do_adopt(req, rt, self.progress.append)


class TestListing(AdoptTestCase):
    def test_groups_by_compose_project_and_skips_pitstore_containers(self):
        own = container("pitstore-x-web", "nginx", IMG_WEB, project=None, labels={"io.pitstore.app": "org.x.y"})
        lonely = container("adminer", "adminer", IMG_WEB, project=None)
        rt = FakeRuntime(romm() + [own, lonely])
        groups = adopt.list_foreign(rt, set())
        self.assertEqual([g["key"] for g in groups], ["adminer", "romm"])
        self.assertEqual(sorted(c["name"] for c in groups[1]["containers"]), ["romm", "romm-db"])
        self.assertEqual(groups[1]["managedBy"], "docker compose")
        self.assertEqual(adopt.list_foreign(rt, {"adminer"})[0]["key"], "romm", "adopted containers are not foreign")

    def test_casaos_is_recognised(self):
        rt = FakeRuntime([container("app", "x", IMG_WEB, labels={"com.docker.compose.project.working_dir": "/var/lib/casaos/apps/app"})])
        self.assertEqual(adopt.list_foreign(rt, set())[0]["managedBy"], "CasaOS")


class TestAnalysis(AdoptTestCase):
    def test_reconstruct_keeps_mounts_ports_and_hides_nothing_secret_in_output(self):
        rt = FakeRuntime(romm())
        analysis, compose, containers = self.analyze(rt)
        web = compose["services"]["romm"]
        self.assertEqual(web["ports"], [{"target": 8080, "published": "8285", "protocol": "tcp"}])
        self.assertIn({"type": "volume", "source": "romm_data", "target": "/data", "read_only": False}, web["volumes"])
        self.assertEqual(compose["volumes"], {"romm_data": None})
        self.assertEqual(containers, {"romm": "romm", "romm-db": "romm-db"})
        out = json.dumps(analysis)
        self.assertNotIn("hunter2", out, "environment values never leave the helper")
        self.assertIn("DB_PASSWD", out, "credential names are listed")

    def test_checks(self):
        web, db = romm(privileged=True, restart="no")
        db["Mounts"] = [{"Type": "volume", "Name": "f" * 64, "Destination": "/var/lib/mysql", "RW": True}]
        other = container("other", "x", IMG_WEB, project=None, ports={"80/tcp": [{"HostPort": "8285"}]})
        rt = FakeRuntime([web, db, other])
        analysis, _, _ = self.analyze(rt)
        ids = {c["id"]: c for c in analysis["checks"]}
        self.assertEqual(ids["romm/privileged"]["severity"], "decision")
        self.assertEqual([c["id"] for c in ids["romm/privileged"]["corrections"]], ["keep", "remove"])
        self.assertIn("port:romm:8285/tcp", ids)
        self.assertIn("restart:romm", ids)
        self.assertIn("anon-volume:romm-db:/var/lib/mysql", ids)
        self.assertIn("managed-elsewhere", ids)
        self.assertFalse(analysis["recreatePossible"])

    def test_host_network_cannot_be_removed(self):
        web, db = romm()
        web["HostConfig"]["NetworkMode"] = "host"
        analysis, _, _ = self.analyze(FakeRuntime([web, db]))
        net = next(c for c in analysis["checks"] if c["id"] == "romm/net-host")
        self.assertEqual([c["id"] for c in net["corrections"]], ["keep"])


class TestAdopt(AdoptTestCase):
    def test_risky_option_needs_a_decision(self):
        rt = FakeRuntime(romm(privileged=True))
        with self.assertRaisesRegex(adopt.AdoptError, "choose how to handle"):
            self.do_adopt(rt, {})
        with self.assertRaisesRegex(adopt.AdoptError, "choose how to handle"):
            self.do_adopt(rt, {"romm/privileged": {"choice": "make-it-safe"}})
        self.assertEqual(rt.calls, [])

    def test_in_place_changes_nothing_and_records_confirmation(self):
        rt = FakeRuntime(romm(privileged=True))
        result = self.do_adopt(rt, {"romm/privileged": {"choice": "keep"}})
        self.assertEqual(result["mode"], "in-place")
        self.assertEqual(rt.calls, [], "no runtime changes for an in-place takeover")
        adir = os.path.join(self.tmp.name, "apps", "docker", "local.romm")
        with open(os.path.join(adir, "plan.json")) as f:
            plan = json.load(f)
        self.assertEqual(plan["adopted"]["containers"], {"romm": "romm", "romm-db": "romm-db"})
        self.assertNotIn("hunter2", json.dumps(plan))
        with open(os.path.join(adir, "confirmations.json")) as f:
            self.assertEqual(json.load(f)[0]["findings"], ["romm/privileged"])
        self.assertEqual(adopt.list_foreign(rt, main.adopted_names(rt)), [], "no longer listed as foreign")

    def test_in_place_app_is_listed_and_can_be_controlled_and_released(self):
        rt = FakeRuntime(romm())
        self.do_adopt(rt, {})
        listed = main.do_list(rt)["apps"]
        self.assertEqual(listed[0]["id"], "local.romm")
        self.assertEqual(listed[0]["adopted"], "in-place")
        self.assertEqual(sorted(c["service"] for c in listed[0]["containers"]), ["romm", "romm-db"])
        main.do_lifecycle({"appId": "local.romm"}, rt, "stop")
        self.assertEqual([c[0] for c in rt.calls], ["stop", "stop"])
        with self.assertRaisesRegex(main.HelperError, "release it"):
            main.do_remove({"appId": "local.romm", "deleteData": True}, rt, self.progress.append)
        main.do_release({"appId": "local.romm"}, rt)
        self.assertEqual(main.do_list(rt)["apps"], [])
        self.assertNotIn("remove_container", rt.mutations(), "releasing never deletes containers")

    def test_recreate_with_corrections_keeps_data_and_exact_images(self):
        rt = FakeRuntime(romm(privileged=True, restart="no"))
        result = self.do_adopt(rt, {"romm/privileged": {"choice": "remove"}, "restart:romm": {"choice": "set"}})
        self.assertEqual(result["mode"], "recreated")
        specs = [c[1] for c in rt.calls if c[0] == "create_container"]
        web = next(s for s in specs if s.service == "romm")
        self.assertFalse(web.privileged)
        self.assertEqual(web.restart, "unless-stopped")
        self.assertEqual(web.image, "sha256:" + IMG_WEB, "same image, no pull")
        self.assertNotIn("pull", rt.mutations())
        self.assertIn(("bind", "/DATA/AppData/romm/library"), [(m.kind, m.source) for m in web.mounts])
        self.assertIn(("volume", "romm_data"), [(m.kind, m.source) for m in web.mounts], "existing volume reused by name")
        deletes = [c for c in rt.calls if c[0] == "compat" and c[1] == "DELETE"]
        self.assertEqual(len(deletes), 2)
        self.assertTrue(all(c[3]["v"] == "false" for c in deletes), "old containers removed without their volumes")

    def test_recreate_failure_restores_the_original_containers(self):
        rt = FakeRuntime(romm(restart="no"))
        rt.fail_on = "start"
        with self.assertRaisesRegex(adopt.AdoptError, "rolled back"):
            self.do_adopt(rt, {"restart:romm": {"choice": "set"}})
        self.assertEqual(sorted(rt.infos), ["romm", "romm-db"], "original names restored")
        self.assertFalse(any(c[0] == "compat" and c[1] == "DELETE" for c in rt.calls))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "apps", "docker", "local.romm")))

    def test_recreate_refused_with_anonymous_volume(self):
        web, db = romm(restart="no")
        db["Mounts"] = [{"Type": "volume", "Name": "f" * 64, "Destination": "/var/lib/mysql", "RW": True}]
        rt = FakeRuntime([web, db])
        with self.assertRaisesRegex(adopt.AdoptError, "anonymous volumes"):
            self.do_adopt(rt, {"restart:romm": {"choice": "set"}})
        self.assertEqual(rt.calls, [])

    def test_recreate_requires_removing_unsupported_settings(self):
        web, db = romm(restart="no")
        web["HostConfig"]["Runtime"] = "nvidia"
        rt = FakeRuntime([web, db])
        with self.assertRaisesRegex(adopt.AdoptError, "remove: Not supported"):
            self.do_adopt(rt, {"restart:romm": {"choice": "set"}})
        result = self.do_adopt(rt, {})
        self.assertEqual(result["mode"], "in-place", "taking over as it is still works")

    def test_port_change_is_validated_on_the_server(self):
        other = container("other", "x", IMG_WEB, project=None, ports={"80/tcp": [{"HostPort": "8285"}]})
        rt = FakeRuntime(romm() + [other])
        with self.assertRaisesRegex(adopt.AdoptError, "invalid port"):
            self.do_adopt(rt, {"port:romm:8285/tcp": {"choice": "change", "value": "80; rm -rf /"}})
        result = self.do_adopt(rt, {"port:romm:8285/tcp": {"choice": "change", "value": "18285"}})
        web = next(c[1] for c in rt.calls if c[0] == "create_container" and c[1].service == "romm")
        self.assertEqual(result["mode"], "recreated")
        self.assertEqual(web.ports[0].host_port, 18285)

    def test_existing_app_id_is_refused(self):
        rt = FakeRuntime(romm())
        self.do_adopt(rt, {})
        rt2 = FakeRuntime(romm())
        with self.assertRaisesRegex(main.HelperError, "already exists"):
            self.do_adopt(rt2, {})


if __name__ == "__main__":
    unittest.main()
