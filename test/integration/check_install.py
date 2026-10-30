#!/usr/bin/python3 -I
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Install smoke test for PitStore, run on the test machine itself.

    check_install.py baseline STATE.json
        Record the Cockpit packages, their pages and the listening TCP ports.

    check_install.py verify STATE.json --installed|--removed
        Compare against the baseline: every page from the baseline must still
        load, PitStore's menu entries must be present (or absent), its pages
        must use Cockpit's default Content-Security-Policy, and no new
        listening TCP port may exist.

Credentials come from the environment (PITSTORE_TEST_USER and
PITSTORE_TEST_PASSWORD) so they never appear on a command line.
Only the Python standard library is used.
"""

import argparse
import base64
import http.client
import json
import os
import ssl
import subprocess
import sys

COCKPIT_HOST = "localhost"
COCKPIT_PORT = 9090
PITSTORE_PAGES = {"dashboard": "Dashboard", "appstore": "Appstore"}
DEFAULT_CSP = {
    "default-src": "'self'",
    "connect-src": "'self'",
    "form-action": "'self'",
    "base-uri": "'self'",
    "object-src": "'none'",
    "font-src": "'self' data:",
    "img-src": "'self' data:",
}
# cockpit-ws adds the origin of its own WebSocket to connect-src on every page
WS_CONNECT_SRC = f"wss://{COCKPIT_HOST}:{COCKPIT_PORT} 'self'"
# a built-in Cockpit page whose manifest has no CSP override, as a live reference
REFERENCE_PAGE = "users/index"


class Cockpit:
    def __init__(self, user, password):
        # the test talks to the local cockpit-ws with its self-signed certificate
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        self.context = context
        self.cookie = None
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        status, headers, body = self.request("/cockpit/login", {"Authorization": f"Basic {token}"})
        if status != 200:
            # cockpit-ws explains the problem in a small JSON body
            raise SystemExit(f"login failed: HTTP {status}: {body[:300].decode(errors='replace')}")
        for name, value in headers:
            if name.lower() == "set-cookie" and value.startswith("cockpit="):
                self.cookie = value.split(";", 1)[0]
        if not self.cookie:
            raise SystemExit("login did not return a session cookie")

    def request(self, path, headers=None):
        conn = http.client.HTTPSConnection(COCKPIT_HOST, COCKPIT_PORT, context=self.context, timeout=30)
        hdrs = dict(headers or {})
        if self.cookie:
            hdrs["Cookie"] = self.cookie
        conn.request("GET", path, headers=hdrs)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, resp.getheaders(), body

    def manifests(self):
        status, _, body = self.request("/cockpit/@localhost/manifests.json")
        if status != 200:
            raise SystemExit(f"manifests.json: HTTP {status}")
        return json.loads(body)


def menu_pages(manifests):
    """Return {"pkg/entry": label} for all menu and tools entries."""
    pages = {}
    for pkg, manifest in manifests.items():
        for section in ("menu", "tools"):
            for entry, info in (manifest.get(section) or {}).items():
                path = info.get("path", entry)
                path = path.split("#", 1)[0].removesuffix(".html")
                pages[f"{pkg}/{path}"] = info.get("label", entry)
    return pages


def listening_ports():
    # ss is only read; no user data is involved, argv is fixed
    out = subprocess.run(["ss", "-H", "-tln"], check=True, capture_output=True, text=True).stdout
    ports = set()
    for line in out.splitlines():
        fields = line.split()
        if len(fields) >= 4:
            ports.add(fields[3])
    return sorted(ports)


def parse_csp(value):
    policy = {}
    for item in value.split(";"):
        item = item.strip()
        if item:
            key, _, rest = item.partition(" ")
            policy[key] = rest.strip()
    return policy


def check_page(cockpit, page, failures):
    status, headers, body = cockpit.request(f"/cockpit/@localhost/{page}.html")
    if status != 200 or b"<html" not in body.lower():
        failures.append(f"page {page}: HTTP {status}")
        return None
    return dict((k.lower(), v) for k, v in headers)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["baseline", "verify"])
    parser.add_argument("state")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--installed", action="store_true")
    group.add_argument("--removed", action="store_true")
    args = parser.parse_args()

    cockpit = Cockpit(os.environ["PITSTORE_TEST_USER"], os.environ["PITSTORE_TEST_PASSWORD"])
    manifests = cockpit.manifests()
    pages = menu_pages(manifests)

    if args.mode == "baseline":
        failures = []
        for page in pages:
            check_page(cockpit, page, failures)
        if failures:
            raise SystemExit("baseline is not clean:\n  " + "\n  ".join(failures))
        state = {"pages": pages, "ports": listening_ports()}
        with open(args.state, "w") as f:
            json.dump(state, f, indent=2)
        print(f"baseline: {len(pages)} pages OK, ports {state['ports']}")
        return

    with open(args.state) as f:
        state = json.load(f)
    failures = []

    for page, label in state["pages"].items():
        if page not in pages:
            failures.append(f"page {page} ({label}) disappeared from the menu")
        elif check_page(cockpit, page, failures) is not None:
            print(f"ok   {page} ({label})")

    for entry, label in PITSTORE_PAGES.items():
        page = f"pitstore/{entry}"
        if args.installed:
            if pages.get(page) != label:
                failures.append(f"{page}: expected menu entry '{label}', got {pages.get(page)!r}")
                continue
            headers = check_page(cockpit, page, failures)
            if headers is None:
                continue
            raw_csp = headers.get("content-security-policy", "")
            csp = parse_csp(raw_csp)
            for key, value in DEFAULT_CSP.items():
                allowed = {value, WS_CONNECT_SRC} if key == "connect-src" else {value}
                if csp.get(key) not in allowed:
                    failures.append(f"{page}: CSP {key} is {csp.get(key)!r}, expected {value!r}")
            if set(csp) - set(DEFAULT_CSP) - {"block-all-mixed-content"}:
                failures.append(f"{page}: CSP has extra directives: {sorted(set(csp) - set(DEFAULT_CSP))}")
            reference = check_page(cockpit, REFERENCE_PAGE, failures)
            if reference is not None and reference.get("content-security-policy") != raw_csp:
                failures.append(f"{page}: CSP differs from {REFERENCE_PAGE}: {raw_csp!r}")
            if any("unsafe" in v or "*" in v for v in csp.values()):
                failures.append(f"{page}: CSP contains unsafe or wildcard sources: {csp}")
            print(f"ok   {page} ({label}), CSP matches the Cockpit default")
        elif page in pages:
            failures.append(f"{page} is still in the menu after removal")

    extra = sorted(set(listening_ports()) - set(state["ports"]))
    if extra:
        failures.append(f"new listening TCP ports: {extra}")
    else:
        print("ok   no new listening TCP ports")

    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
