#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""End-to-end test of an app's life cycle through the Appstore UI:
install, open, stop, start, restart, update and remove.

    lifecycle.py OUTDIR [--app APP_ID] [--backend podman-user|podman-system|docker]

For podman-user it runs as the test user itself and fakes an older installed
version for the update step by editing its own plan.json. The system
backends need a test admin user with passwordless sudo (throwaway VM only).
"""

import argparse
import asyncio
import json
import subprocess
import os
import ssl
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
from screenshots import BASE, login, run_js, save_shot, test_password, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("outdir")
parser.add_argument("--app", default="com.icewhale.bentopdf")
parser.add_argument("--backend", default="podman-user", choices=["podman-user", "podman-system", "docker"])
ARGS = parser.parse_args()
APP_ID = ARGS.app
FRAME = "cockpit1:localhost/pitstore/appstore"
SYSTEM = ARGS.backend != "podman-user"
PLAN = ((Path("/var/lib/pitstore") if SYSTEM else Path.home() / ".local/share/pitstore") / "apps"
        / ARGS.backend.split("-")[0] / APP_ID / "plan.json")


def read_plan():
    if SYSTEM:
        return json.loads(subprocess.run(["sudo", "-n", "cat", str(PLAN)], check=True, capture_output=True).stdout)
    return json.loads(PLAN.read_text())


def write_plan(plan):
    if SYSTEM:
        subprocess.run(["sudo", "-n", "tee", str(PLAN)], input=json.dumps(plan).encode(), check=True,
                       stdout=subprocess.DEVNULL)
    else:
        PLAN.write_text(json.dumps(plan))


def plan_exists():
    if SYSTEM:
        return subprocess.run(["sudo", "-n", "test", "-e", str(PLAN)]).returncode == 0
    return PLAN.exists()

# click a button by its text in the topmost dialog (or the page)
CLICK = """(text) => {
    const boxes = document.querySelectorAll('.pf-v6-c-modal-box');
    const root = boxes.length ? boxes[boxes.length - 1] : document;
    const b = [...root.querySelectorAll('button, a.pf-v6-c-button')].find(b => b.textContent.trim() === text && !b.disabled);
    if (!b) return false;
    b.click();
    return true;
}"""
HAS_TEXT = "(text) => document.body.innerText.includes(text)"


async def click(browser, text, timeout=60):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await run_js(browser, CLICK, text):
            return
        await asyncio.sleep(0.5)
    raise TimeoutError(f"no enabled button {text!r}")


async def wait_text(browser, text, timeout=60):
    await wait_js(browser, f"() => document.body.innerText.includes({json.dumps(text)})", timeout=timeout)


async def open_details(browser):
    browser.switch_to_top()
    await browser.bidi("browsingContext.navigate", context=browser.top_context,
                       url=f"{BASE}/pitstore/appstore", wait="complete")
    await wait_js(browser, f"() => !!document.querySelector(\"iframe[name='{FRAME}']\")")
    await browser.switch_to_frame(FRAME)
    await wait_js(browser, f"() => !!document.getElementById('app-{APP_ID}')", timeout=120)
    await run_js(browser, """(id) => {
        document.getElementById('app-' + id).querySelector('input, button').click();
        return true;
    }""", APP_ID)
    await wait_text(browser, "What will run")


async def enable_admin(browser):
    """Switch the session to administrative access, as a user would."""
    browser.switch_to_top()
    await wait_js(browser, "() => document.body.innerText.includes('Limited access') || "
                           "document.body.innerText.includes('Administrative access')")
    if await run_js(browser, "() => document.body.innerText.includes('Administrative access')"):
        return
    await click(browser, "Limited access")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 60
    while loop.time() < deadline:
        if await run_js(browser, "() => document.body.innerText.includes('Administrative access') && "
                                 "!document.querySelector('.pf-v6-c-modal-box, .pf-v5-c-modal-box')"):
            return
        await run_js(browser, """(password) => {
            const box = document.querySelector('.pf-v6-c-modal-box, .pf-v5-c-modal-box');
            if (!box) return false;
            const input = box.querySelector('input[type=password]');
            if (input && !input.value) {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, password);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const button = [...box.querySelectorAll('button')]
                .find(b => ['Authenticate', 'Close'].includes(b.textContent.trim()) && !b.disabled);
            if (button) button.click();
            return true;
        }""", test_password())
        await asyncio.sleep(1)
    raise TimeoutError("administrative access could not be enabled")


def http_status(url):
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, timeout=10, context=ctx) as r:
            return r.status
    except Exception as e:
        return str(e)


async def main(outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    os.environ["PITSTORE_SHOT_DIR"] = str(outdir)

    async def shot(name):
        browser.switch_to_top()
        await save_shot(browser, outdir / f"{name}.png")
        await browser.switch_to_frame(FRAME)

    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 900})
        await login(browser)
        if SYSTEM:
            await enable_admin(browser)
            print("ok   administrative access enabled", flush=True)

        # install
        await open_details(browser)
        await click(browser, "Install")
        await wait_text(browser, "Run with")
        await wait_js(browser, "() => !!document.getElementById('pitstore-backend')")
        await run_js(browser, """(backend) => {
            const select = document.getElementById('pitstore-backend');
            if (![...select.options].some(o => o.value === backend))
                throw new Error('backend not offered: ' + backend);
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, backend);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }""", ARGS.backend)
        await asyncio.sleep(2)  # form is rebuilt for the backend
        await shot("install-dialog")
        await click(browser, "Install")
        await wait_js(browser, """() => document.body.innerText.includes('Running') ||
            document.body.innerText.includes('Installation failed')""", timeout=600)
        if await run_js(browser, "() => document.body.innerText.includes('Installation failed')"):
            message = await run_js(browser, """() => document.querySelector(
                '.pf-v6-c-modal-box .pf-m-danger .pf-v6-c-alert__description')?.innerText ?? ''""")
            await shot("install-failed")
            raise SystemExit(f"FAILED: installation failed: {message}")
        print(f"ok   installed {APP_ID} with {ARGS.backend}, running", flush=True)
        await shot("installed")

        # open: the link must point at the app, and the app must answer
        href = await run_js(browser, """() => [...document.querySelectorAll('a')]
            .find(a => a.textContent.trim() === 'Open')?.href ?? ''""")
        status = None
        for _ in range(30):
            status = http_status(href)
            if status == 200:
                break
            await asyncio.sleep(2)
        if status != 200:
            raise SystemExit(f"FAILED: {href} answered {status}")
        print(f"ok   open: {href} answered HTTP 200")

        # stop, start, restart
        await click(browser, "Stop")
        await wait_text(browser, "Stopped")
        print("ok   stopped")
        await click(browser, "Start")
        await wait_text(browser, "Running")
        print("ok   started")
        await click(browser, "Restart")
        await asyncio.sleep(3)
        await wait_text(browser, "Running")
        print("ok   restarted")

        # update: pretend an older version is installed
        plan = read_plan()
        if plan["backend"] != ARGS.backend.split("-")[0]:
            raise SystemExit(f"FAILED: installed with {plan['backend']}, expected {ARGS.backend}")
        current_hash = plan["app"]["contentHash"]
        plan["app"]["contentHash"] = "older"
        plan["app"]["version"] = "0.0.1"
        write_plan(plan)
        await open_details(browser)
        # the button is enabled once the new compose file is loaded and checked
        await wait_js(browser, """() => [...document.querySelectorAll('button')]
            .some(b => b.textContent.startsWith('Update to') && !b.disabled)""")
        await run_js(browser, """() => { [...document.querySelectorAll('button')]
            .find(b => b.textContent.startsWith('Update to') && !b.disabled).click(); return true; }""")
        await wait_text(browser, "Run with")
        await shot("update-dialog")
        await click(browser, "Update")
        # the dialog closes itself when the update has finished
        await wait_js(browser, """() => !document.querySelector('.pitstore-progress') &&
            !document.body.innerText.includes('Run with') && document.body.innerText.includes('Running')""",
                      timeout=600)
        plan = read_plan()
        if plan["app"]["contentHash"] != current_hash:
            raise SystemExit("FAILED: update did not record the catalog version")
        print(f"ok   updated to {plan['app']['version']}")

        # remove, including data
        await click(browser, "Remove")
        await wait_text(browser, "Also delete the app's data")
        await run_js(browser, "() => { document.getElementById('pitstore-delete-data').click(); return true; }")
        await click(browser, "Remove")
        await wait_js(browser, """() => [...document.querySelectorAll('button')]
            .some(b => b.textContent.trim() === 'Install')""", timeout=120)
        if plan_exists():
            raise SystemExit("FAILED: app state left behind")
        print("ok   removed")
        await shot("removed")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        if errors:
            raise SystemExit("FAILED: console errors:\n  " + "\n  ".join(errors))
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(ARGS.outdir))
