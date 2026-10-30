#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Takeover test with Docker: show other apps, analyse, take over with
corrections (recreate) and as is (in place), control and release.

    adopt.py OUTDIR

Runs as an admin test user with passwordless sudo (throwaway VM only); the
test creates its own "foreign" containers with docker run.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
sys.argv = [sys.argv[0], sys.argv[1], "--backend", "docker"]
import lifecycle  # noqa: E402
from lifecycle_helpers import http_status  # noqa: E402
from screenshots import BASE, login, run_js, save_shot, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402

FRAME = "cockpit1:localhost/pitstore/dashboard"


def docker(*args, check=True):
    return subprocess.run(["sudo", "-n", "docker", *args], check=check, capture_output=True, text=True).stdout


def inspect(name):
    return json.loads(docker("inspect", name))[0]


def setup_foreign():
    for name in ("demo-web", "demo-db", "legacy"):
        docker("rm", "-f", name, check=False)
    subprocess.run(["sudo", "-n", "install", "-d", "/srv/demo-html"], check=True)
    subprocess.run(["sudo", "-n", "tee", "/srv/demo-html/index.html"], input=b"demo app\n", check=True,
                   stdout=subprocess.DEVNULL)
    compose = ["--label", "com.docker.compose.project=demo"]
    docker("run", "-d", "--name", "demo-web", *compose, "--label", "com.docker.compose.service=web",
           "--privileged", "--restart", "no", "-p", "18090:80",
           "-v", "/srv/demo-html:/usr/share/nginx/html:ro", "-v", "demo_data:/data", "nginx:1.27-alpine")
    docker("run", "-d", "--name", "demo-db", *compose, "--label", "com.docker.compose.service=db",
           "--restart", "unless-stopped", "-e", "POSTGRES_PASSWORD=not-shown-anywhere", "busybox:1.36",
           "sleep", "100000")
    # redis declares VOLUME /data: an anonymous volume
    docker("run", "-d", "--name", "legacy", "--restart", "unless-stopped", "redis:7-alpine")
    return inspect("demo-web")["Image"]


async def dashboard(browser):
    browser.switch_to_top()
    await browser.bidi("browsingContext.navigate", context=browser.top_context,
                       url=f"{BASE}/pitstore/dashboard", wait="interactive", timeout=60)
    await wait_js(browser, f"() => !!document.querySelector(\"iframe[name='{FRAME}']\")")
    await browser.switch_to_frame(FRAME)


async def shot(browser, outdir, name):
    browser.switch_to_top()
    await save_shot(browser, outdir / f"{name}.png")
    await browser.switch_to_frame(FRAME)


async def click_in(browser, root_id, text):
    ok = await run_js(browser, """(id, text) => {
        const root = document.getElementById(id);
        const b = root && [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled);
        if (!b) return false;
        b.click();
        return true;
    }""", root_id, text)
    if not ok:
        raise SystemExit(f"FAILED: no enabled {text!r} in #{root_id}")


async def main(outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    os.environ["PITSTORE_SHOT_DIR"] = str(outdir)
    image_before = setup_foreign()
    print("ok   created foreign containers demo-web, demo-db (project demo) and legacy")
    await asyncio.sleep(5)  # let the new network interfaces settle

    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 1000})
        await login(browser)
        await lifecycle.enable_admin(browser)
        await dashboard(browser)
        await wait_js(browser, """() => !!document.getElementById('foreign-docker-demo') &&
            !!document.getElementById('foreign-docker-legacy')""", timeout=60)
        print("ok   other apps listed: demo, legacy")
        await shot(browser, outdir, "other-apps")

        # demo: analyse and take over with corrections
        await click_in(browser, "foreign-docker-demo", "Take over…")
        await wait_js(browser, "() => document.body.innerText.includes('Checks (')", timeout=60)
        text = await run_js(browser, "() => document.querySelector('.pf-v6-c-modal-box').innerText")
        for expected in ("Risky option: privileged", "does not start again after a reboot", "Also managed by docker compose",
                         "has credentials in its environment"):
            if expected not in text:
                raise SystemExit(f"FAILED: analysis lacks {expected!r}")
        if "not-shown-anywhere" in text:
            raise SystemExit("FAILED: an environment value is shown")
        print("ok   analysis: privileged, restart policy, compose, credential names (no values)")
        await shot(browser, outdir, "analysis-demo")
        await run_js(browser, """() => {
            document.getElementById('choice-web/privileged-remove').click();
            document.getElementById('choice-restart:web-set').click();
            return true;
        }""")
        await wait_js(browser, "() => document.body.innerText.includes('The containers will be recreated')")
        # every decision is made, so the button must be enabled right away
        await wait_js(browser, """() => [...document.querySelectorAll('.pf-v6-c-modal-box button')]
            .some(b => b.textContent.trim() === 'Take over' && !b.disabled)""", timeout=5)
        await asyncio.sleep(1)  # button colour transition
        await shot(browser, outdir, "analysis-demo-corrections")
        await lifecycle.click(browser, "Take over")
        await wait_js(browser, """() => !document.querySelector('.pf-v6-c-modal-box') &&
            (document.getElementById('tile-local.demo')?.innerText ?? '').includes('Running')""", timeout=180)
        new = inspect("pitstore-local.demo-web")
        assert not new["HostConfig"]["Privileged"], "privileged removed"
        assert new["HostConfig"]["RestartPolicy"]["Name"] == "unless-stopped", "restart policy set"
        assert new["Image"] == image_before, "same image"
        assert any(m.get("Name") == "demo_data" for m in new["Mounts"]), "named volume reused"
        assert docker("ps", "-a", "--filter", "name=^demo-web$", "-q").strip() == "", "old container removed"
        assert http_status("http://localhost:18090/") == 200, "app answers"
        print("ok   demo taken over and recreated: not privileged, restarts, same image and volume, answers HTTP 200")
        await shot(browser, outdir, "taken-over")

        # legacy: anonymous volume, so only in place
        await click_in(browser, "foreign-docker-legacy", "Take over…")
        await wait_js(browser, "() => document.body.innerText.includes('anonymous volume')", timeout=60)
        await lifecycle.click(browser, "Take over")
        await wait_js(browser, """() => !document.querySelector('.pf-v6-c-modal-box') &&
            !!document.getElementById('tile-local.legacy')""", timeout=60)
        legacy_id = inspect("legacy")["Id"]
        await click_in(browser, "tile-local.legacy", "Stop")
        await wait_js(browser, "() => document.getElementById('tile-local.legacy').innerText.includes('Stopped')")
        await click_in(browser, "tile-local.legacy", "Start")
        await wait_js(browser, "() => document.getElementById('tile-local.legacy').innerText.includes('Running')")
        print("ok   legacy taken over as it is; stop and start from its tile")
        # release from the tile's settings dialog
        await run_js(browser, """() => {
            document.getElementById('tile-local.legacy').querySelector('.pitstore-settings-button').click();
            return true;
        }""")
        await lifecycle.wait_text(browser, "Published ports")
        text = await run_js(browser, "() => document.querySelector('.pf-v6-c-modal-box').innerText")
        if "Remove…" in text or "Change settings…" in text:
            raise SystemExit("FAILED: an app taken over as it is offers remove or change settings")
        await lifecycle.click(browser, "Release…")
        await lifecycle.click(browser, "Release")
        await wait_js(browser, """() => !document.getElementById('tile-local.legacy') &&
            !!document.getElementById('foreign-docker-legacy')""", timeout=60)
        assert inspect("legacy")["Id"] == legacy_id and inspect("legacy")["State"]["Running"], "container untouched"
        print("ok   legacy released: same container, still running, listed under other apps again")
        await shot(browser, outdir, "released")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        if errors:
            raise SystemExit("FAILED: console errors:\n  " + "\n  ".join(errors))
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
