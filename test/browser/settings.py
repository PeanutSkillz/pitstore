#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Settings of an installed app, from its dashboard tile: install an app
through the Appstore, change its web port with the settings dialog, then
remove it with its data from the same dialog.

    settings.py OUTDIR [--app APP_ID]

Runs as the rootless test user. With RomM (the default) the remove step also
covers data that a container created as another user (its database).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
if "--app" not in sys.argv:
    sys.argv += ["--app", "org.icewhale.romm"]
import lifecycle  # noqa: E402
from lifecycle_helpers import http_status  # noqa: E402
from screenshots import BASE, login, run_js, save_shot, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402

APP_ID = lifecycle.APP_ID
DASHBOARD = "cockpit1:localhost/pitstore/dashboard"
DATA = Path.home() / ".local/share/pitstore/data" / APP_ID


async def wait_http(port, expected=200, tries=90):
    status = None
    for _ in range(tries):
        status = http_status(f"http://localhost:{port}/")
        if status == expected:
            return
        await asyncio.sleep(2)
    raise SystemExit(f"FAILED: port {port} answered {status}, expected {expected}")


async def main(outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    os.environ["PITSTORE_SHOT_DIR"] = str(outdir)

    async def shot(name):
        browser.switch_to_top()
        await save_shot(browser, outdir / f"{name}.png")
        await browser.switch_to_frame(DASHBOARD)

    async def dashboard():
        browser.switch_to_top()
        await browser.bidi("browsingContext.navigate", context=browser.top_context,
                           url=f"{BASE}/pitstore/dashboard", wait="interactive", timeout=60)
        await wait_js(browser, f"() => !!document.querySelector(\"iframe[name='{DASHBOARD}']\")")
        await browser.switch_to_frame(DASHBOARD)
        await wait_js(browser, f"() => !!document.getElementById('tile-{APP_ID}')", timeout=60)

    async def open_settings():
        await run_js(browser, """(id) => {
            document.getElementById('tile-' + id).querySelector('.pitstore-settings-button').click();
            return true;
        }""", APP_ID)
        await lifecycle.wait_text(browser, "Published ports")

    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 1000})
        await login(browser)

        # install with the defaults
        await lifecycle.open_details(browser)
        await lifecycle.click(browser, "Install")
        await lifecycle.wait_text(browser, "Run with")
        await asyncio.sleep(2)
        old_port = await run_js(browser, "() => document.getElementById('port-0').value")
        await lifecycle.click(browser, "Install")
        await wait_js(browser, """() => document.body.innerText.includes('Running') ||
            document.body.innerText.includes('Installation failed')""", timeout=900)
        if await run_js(browser, "() => document.body.innerText.includes('Installation failed')"):
            raise SystemExit("FAILED: installation failed")
        await wait_http(old_port)
        print(f"ok   {APP_ID} installed, answers on port {old_port}", flush=True)

        # the settings dialog from the dashboard tile
        await dashboard()
        await open_settings()
        text = await run_js(browser, "() => document.querySelector('.pf-v6-c-modal-box').innerText")
        for expected in ("Runs with", f"{old_port} →", "Data folder", "Change settings…", "Remove…"):
            if expected not in text:
                raise SystemExit(f"FAILED: settings dialog lacks {expected!r}")
        print("ok   settings dialog shows backend, ports, data folder, change and remove")
        await shot("settings")

        # change the web port
        new_port = str(int(old_port) + 10)
        await lifecycle.click(browser, "Change settings…")
        await lifecycle.wait_text(browser, "Change settings of")
        await wait_js(browser, f"() => document.getElementById('port-0')?.value === {old_port!r}", timeout=60)
        await run_js(browser, """(port) => {
            const input = document.getElementById('port-0');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, port);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }""", new_port)
        await asyncio.sleep(1)
        await shot("change-settings")
        await lifecycle.click(browser, "Save")
        await wait_js(browser, "() => !document.querySelector('.pf-v6-c-modal-box')", timeout=900)
        await wait_http(new_port)
        if http_status(f"http://localhost:{old_port}/") == 200:
            raise SystemExit(f"FAILED: the old port {old_port} still answers")
        plan = json.loads(lifecycle.PLAN.read_text())
        if not any(p[0] == int(new_port) for p in plan.get("ports", [])):
            raise SystemExit(f"FAILED: plan ports {plan.get('ports')} lack {new_port}")
        print(f"ok   port changed to {new_port}: new port answers, old port does not, plan updated")

        # remove with its data from the settings dialog
        await dashboard()
        await open_settings()
        await lifecycle.click(browser, "Remove…")
        await lifecycle.wait_text(browser, "Also delete the app's data")
        await run_js(browser, "() => { document.getElementById('pitstore-delete-data').click(); return true; }")
        await lifecycle.click(browser, "Remove")
        await wait_js(browser, f"() => !document.getElementById('tile-{APP_ID}') && "
                               "!document.querySelector('.pf-v6-c-modal-box')", timeout=180)
        if lifecycle.PLAN.exists() or DATA.exists():
            raise SystemExit("FAILED: app state or data left behind")
        print("ok   removed with its data from the settings dialog (state and data folder gone)")
        await shot("removed")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        if errors:
            raise SystemExit("FAILED: console errors:\n  " + "\n  ".join(errors))
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
