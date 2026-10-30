#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Install one catalog app through the Appstore UI, wait until it runs and
answers on its web port, and take screenshots of the dialog and of the app.
The app is left installed (for manual inspection).

    install_app.py OUTDIR --app APP_ID [--backend podman-user|podman-system|docker]
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
from lifecycle_helpers import http_status  # noqa: E402
from screenshots import login, run_js, save_shot, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("outdir")
parser.add_argument("--app", required=True)
parser.add_argument("--backend", default="podman-user", choices=["podman-user", "podman-system", "docker"])
ARGS = parser.parse_args()

# reuse the dialog helpers of the life-cycle test without running it
sys.argv = [sys.argv[0], ARGS.outdir, "--app", ARGS.app, "--backend", ARGS.backend]
import lifecycle  # noqa: E402


async def main(outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    os.environ["PITSTORE_SHOT_DIR"] = str(outdir)
    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 900})
        await login(browser)
        if ARGS.backend != "podman-user":
            await lifecycle.enable_admin(browser)
        await lifecycle.open_details(browser)
        await lifecycle.click(browser, "Install")
        await lifecycle.wait_text(browser, "Run with")
        await wait_js(browser, "() => !!document.getElementById('pitstore-backend')")
        await run_js(browser, """(backend) => {
            const select = document.getElementById('pitstore-backend');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, backend);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }""", ARGS.backend)
        await asyncio.sleep(2)
        browser.switch_to_top()
        await save_shot(browser, outdir / "install-dialog.png")
        await browser.switch_to_frame(lifecycle.FRAME)
        await lifecycle.click(browser, "Install")
        await wait_js(browser, """() => document.body.innerText.includes('Running') ||
            document.body.innerText.includes('Installation failed')""", timeout=900)
        if await run_js(browser, "() => document.body.innerText.includes('Installation failed')"):
            browser.switch_to_top()
            await save_shot(browser, outdir / "install-failed.png")
            raise SystemExit("FAILED: installation failed (see install-failed.png)")
        href = await run_js(browser, """() => [...document.querySelectorAll('a')]
            .find(a => a.textContent.trim() === 'Open')?.href ?? ''""")
        print(f"ok   {ARGS.app} installed with {ARGS.backend}, running; Open -> {href}", flush=True)
        browser.switch_to_top()
        await save_shot(browser, outdir / "installed.png")

        # the app itself, on this machine (localhost) instead of the public host name
        url = "http://localhost:" + href.split(":", 2)[2].split("/", 1)[0] + "/"
        status = None
        for _ in range(90):
            status = http_status(url)
            if status == 200:
                break
            await asyncio.sleep(2)
        print(f"ok   {url} answered {status}" if status == 200 else f"FAILED: {url} answered {status}", flush=True)
        await browser.bidi("browsingContext.navigate", context=browser.top_context, url=url, wait="complete")
        await asyncio.sleep(5)
        await save_shot(browser, outdir / "app.png")
        print("ok   screenshot of the app saved")


if __name__ == "__main__":
    asyncio.run(main(Path(ARGS.outdir)))
