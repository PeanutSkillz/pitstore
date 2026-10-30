#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Log in to the local Cockpit with headless Chromium, open each PitStore
page, save a screenshot and fail on browser console errors.

    screenshots.py OUTDIR

Uses Cockpit's own WebDriver BiDi driver (test/common/webdriver_bidi.py,
needs python3-aiohttp, chromium and chromedriver). Credentials come from
PITSTORE_TEST_USER / PITSTORE_TEST_PASSWORD so they never appear in argv.
"""

import asyncio
import base64
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
from webdriver_bidi import ChromiumBidi  # noqa: E402

# Cockpit URL; set PITSTORE_TEST_BASE when Cockpit runs with a UrlRoot
BASE = os.environ.get("PITSTORE_TEST_BASE", "https://localhost:9090").rstrip("/")
PAGES = {"dashboard": "Dashboard", "appstore": "Appstore"}
# a catalog app without risky options and one with privileged: true
CLEAN_APP = "org.icewhale.2fauth"
RISKY_APP = "org.icewhale.homeassistant"


async def run_js(browser, code, *args):
    result = await browser.bidi("script.callFunction", functionDeclaration=code,
                                arguments=[{"type": "string", "value": a} for a in args],
                                awaitPromise=True, target={"context": browser.context})
    # the driver already deserializes the BiDi remote value into a plain value
    return result["result"]


def test_password():
    """The test password, from a file (keeps it out of command lines and logs) or the environment."""
    path = os.environ.get("PITSTORE_TEST_PASSWORD_FILE")
    if path:
        with open(path) as f:
            return f.read().strip()
    return os.environ["PITSTORE_TEST_PASSWORD"]


async def wait_js(browser, code, timeout=60):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            if await run_js(browser, code):
                return
        except Exception:
            pass  # the context may be navigating; calls can also time out then
        await asyncio.sleep(0.25)
    shot = await browser.bidi("browsingContext.captureScreenshot", context=browser.top_context)
    Path(os.environ.get("PITSTORE_SHOT_DIR", "."), "timeout.png").write_bytes(base64.b64decode(shot["data"]))
    raise TimeoutError(f"condition not met: {code} (screenshot in timeout.png)")


async def save_shot(browser, path):
    shot = await browser.bidi("browsingContext.captureScreenshot", context=browser.top_context)
    path.write_bytes(base64.b64decode(shot["data"]))


async def login(browser):
    """Log in to Cockpit with the test credentials from the environment."""
    await browser.bidi("browsingContext.navigate", context=browser.top_context, url=f"{BASE}/", wait="complete")
    # login.js attaches its handlers only once the form is shown
    await wait_js(browser, "() => document.readyState === 'complete' && "
                           "document.getElementById('login-button')?.offsetParent !== null")
    logged_in = "() => !!document.querySelector('#host-apps, nav')"
    for attempt in (1, 2):
        # a slow first login must not be retried on the already loaded shell
        await run_js(browser, """(user, password) => {
            const button = document.getElementById('login-button');
            if (!button) return false;
            document.getElementById('login-user-input').value = user;
            document.getElementById('login-password-input').value = password;
            button.click();
            return true;
        }""", os.environ["PITSTORE_TEST_USER"], test_password())
        try:
            await wait_js(browser, logged_in, timeout=20 if attempt == 1 else 60)
            break
        except TimeoutError:
            if attempt == 2:
                raise


async def main(outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 900})
        await login(browser)

        failures = []
        for page, title in PAGES.items():
            browser.switch_to_top()
            await browser.bidi("browsingContext.navigate", context=browser.top_context,
                               url=f"{BASE}/pitstore/{page}", wait="complete")
            frame = f"cockpit1:localhost/pitstore/{page}"
            await wait_js(browser, f"() => !!document.querySelector(\"iframe[name='{frame}']\")")
            await browser.switch_to_frame(frame)
            await wait_js(browser, f"() => document.querySelector('h1')?.textContent === '{title}'")
            browser.switch_to_top()
            menu = await run_js(browser, "() => [...document.querySelectorAll('nav a')]"
                                         ".map(a => a.textContent.trim()).join('|')")
            for label in PAGES.values():
                if label not in (menu or "").split("|"):
                    failures.append(f"menu entry {label} missing")
            await asyncio.sleep(1)  # let fonts and icons settle
            await save_shot(browser, outdir / f"{page}.png")
            print(f"ok   {page}: heading '{title}' rendered")

        # Appstore with the live catalog, loaded through the bridge
        await browser.switch_to_frame("cockpit1:localhost/pitstore/appstore")
        await wait_js(browser, "() => document.querySelectorAll('.pitstore-app-card').length > 50", timeout=120)
        count = await run_js(browser, "() => String(document.querySelectorAll('.pitstore-app-card').length)")
        await wait_js(browser, "() => document.querySelectorAll('img.pitstore-app-icon[src^=\"data:image/\"]').length > 10",
                      timeout=120)
        print(f"ok   appstore: {count} app cards, icons shown as data: URLs")
        await save_shot(browser, outdir / "appstore-catalog.png")

        for app_id, expected in ((CLEAN_APP, "No risky options found"),
                                 (RISKY_APP, "This app asks for risky permissions")):
            await browser.switch_to_frame("cockpit1:localhost/pitstore/appstore")
            await run_js(browser, """(id) => {
                const card = document.getElementById('app-' + id);
                card.querySelector('input, button').click();
                return true;
            }""", app_id)
            await wait_js(browser, f"() => document.body.innerText.includes({expected!r})", timeout=60)
            await asyncio.sleep(2)  # screenshots in the dialog
            print(f"ok   details of {app_id}: '{expected}'")
            await save_shot(browser, outdir / f"details-{app_id}.png")
            await run_js(browser, """() => {
                [...document.querySelectorAll('.pf-v6-c-modal-box button')]
                    .find(b => b.textContent === 'Close').click();
                return true;
            }""")
            await wait_js(browser, "() => !document.querySelector('.pf-v6-c-modal-box')")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        for e in errors:
            failures.append(f"console: {e}")
        if failures:
            print("FAILED:\n  " + "\n  ".join(failures))
            sys.exit(1)
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
