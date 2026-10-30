#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""The Appstore must refuse a catalog source whose TLS certificate does not
validate. The caller points ~/.config/pitstore/settings.json of the test user
at such a host first (for example https://self-signed.badssl.com).
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
from screenshots import BASE, run_js, save_shot, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402


async def main(outdir):
    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.navigate", context=browser.top_context, url=f"{BASE}/", wait="complete")
        await wait_js(browser, "() => document.readyState === 'complete' && "
                               "document.getElementById('login-button')?.offsetParent !== null")
        await run_js(browser, """(user, password) => {
            document.getElementById('login-user-input').value = user;
            document.getElementById('login-password-input').value = password;
            document.getElementById('login-button').click();
            return true;
        }""", os.environ["PITSTORE_TEST_USER"], os.environ["PITSTORE_TEST_PASSWORD"])
        await wait_js(browser, "() => !!document.querySelector('#host-apps, nav')")
        await browser.bidi("browsingContext.navigate", context=browser.top_context,
                           url=f"{BASE}/pitstore/appstore", wait="complete")
        await wait_js(browser, "() => !!document.querySelector(\"iframe[name='cockpit1:localhost/pitstore/appstore']\")")
        await browser.switch_to_frame("cockpit1:localhost/pitstore/appstore")
        await wait_js(browser, "() => document.body.innerText.includes('The catalog could not be loaded')", timeout=60)
        text = await run_js(browser, "() => document.body.innerText")
        cards = await run_js(browser, "() => String(document.querySelectorAll('.pitstore-app-card').length)")
        browser.switch_to_top()
        await save_shot(browser, Path(outdir) / "tls-refused.png")
        detail = [line for line in text.splitlines() if "fetch" in line.lower() or "certificate" in line.lower()]
        if cards != "0":
            print(f"FAILED: {cards} apps shown from an untrusted source")
            sys.exit(1)
        print(f"ok   untrusted certificate refused: {detail[:1]}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
