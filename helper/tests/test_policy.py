# SPDX-License-Identifier: LGPL-2.1-or-later
"""Tests for helper/pitstore/policy.py against the shared vectors."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "helper"))

from pitstore import policy  # noqa: E402

with open(os.path.join(ROOT, "test", "policy-vectors", "compose.json")) as f:
    VECTORS = json.load(f)


class TestVectors(unittest.TestCase):
    def test_vectors(self):
        self.assertGreater(len(VECTORS), 20)
        for vector in VECTORS:
            with self.subTest(vector["description"]):
                result = policy.evaluate(vector["compose"])
                self.assertEqual([f["key"] for f in result["findings"]], vector["findings"])
                self.assertEqual([u["path"] for u in result["unsupported"]], vector["unsupported"])


class TestPrivileged(unittest.TestCase):
    """Done-criterion: privileged: true is never accepted without confirmation."""

    def test_privileged_is_a_finding(self):
        compose = {"services": {"app": {"image": "x", "privileged": True}}}
        keys = [f["key"] for f in policy.evaluate(compose)["findings"]]
        self.assertEqual(keys, ["app/privileged"])


class TestHelpers(unittest.TestCase):
    def test_normalize_path(self):
        self.assertEqual(policy.normalize_path("//a/./b/../c/"), "/a/c")
        self.assertEqual(policy.normalize_path("/../../etc"), "/etc")
        self.assertEqual(policy.normalize_path("/"), "/")

    def test_parse_volume(self):
        self.assertEqual(policy.parse_volume("/a:/b:ro"), ("bind", "/a", "/b"))
        self.assertEqual(policy.parse_volume("data:/b"), ("volume", "data", "/b"))
        self.assertEqual(policy.parse_volume("/anon"), ("volume", "", "/anon"))
        self.assertIsNone(policy.parse_volume(":/b"))
        self.assertIsNone(policy.parse_volume({"type": "bind", "target": "/b"}))

    def test_garbage_input(self):
        for bad in (None, [], "x", {"services": []}, {"services": {"a": "b"}}):
            with self.subTest(repr(bad)):
                self.assertTrue(policy.evaluate(bad)["unsupported"])


if __name__ == "__main__":
    unittest.main()
