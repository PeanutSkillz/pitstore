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

BASE = "https://localhost:9090"
PAGES = {"dashboard": "Dashboard", "appstore": "Appstore"}


async def run_js(browser, code, *args):
    result = await browser.bidi("script.callFunction", functionDeclaration=code,
                                arguments=[{"type": "string", "value": a} for a in args],
                                awaitPromise=True, target={"context": browser.context})
    # the driver already deserializes the BiDi remote value into a plain value
    return result["result"]


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
    Path("timeout.png").write_bytes(base64.b64decode(shot["data"]))
    raise TimeoutError(f"condition not met: {code} (screenshot in timeout.png)")


async def main(outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 800})
        await browser.bidi("browsingContext.navigate", context=browser.top_context,
                           url=f"{BASE}/", wait="complete")
        # login.js attaches its handlers only once the form is shown
        await wait_js(browser, "() => document.readyState === 'complete' && "
                               "document.getElementById('login-button')?.offsetParent !== null")
        logged_in = "() => !!document.querySelector('#host-apps, nav')"
        for attempt in (1, 2):
            await run_js(browser, """(user, password) => {
                document.getElementById('login-user-input').value = user;
                document.getElementById('login-password-input').value = password;
                document.getElementById('login-button').click();
                return true;
            }""", os.environ["PITSTORE_TEST_USER"], os.environ["PITSTORE_TEST_PASSWORD"])
            try:
                await wait_js(browser, logged_in, timeout=20 if attempt == 1 else 60)
                break
            except TimeoutError:
                if attempt == 2:
                    raise

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
            shot = await browser.bidi("browsingContext.captureScreenshot", context=browser.top_context)
            path = outdir / f"{page}.png"
            path.write_bytes(base64.b64decode(shot["data"]))
            print(f"ok   {page}: heading '{title}' rendered, saved {path}")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        for e in errors:
            failures.append(f"console: {e}")
        if failures:
            print("FAILED:\n  " + "\n  ".join(failures))
            sys.exit(1)
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
