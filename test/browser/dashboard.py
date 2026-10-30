#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Dashboard test: app tile (status, open, stop, start, restart) and the
system summary. The caller installs the app first (see test/vm/full-test.sh).

    dashboard.py OUTDIR APP_ID
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "common"))
from lifecycle_helpers import http_status  # noqa: E402
from screenshots import BASE, login, run_js, save_shot, wait_js  # noqa: E402
from webdriver_bidi import ChromiumBidi  # noqa: E402

FRAME = "cockpit1:localhost/pitstore/dashboard"


def tile_js(body):
    return f"""(id) => {{ const tile = document.getElementById('tile-' + id); if (!tile) return false; {body} }}"""


async def tile_click(browser, app_id, text):
    clicked = await run_js(browser, tile_js(f"""
        const b = [...tile.querySelectorAll('button, a')].find(b => b.textContent.trim() === {text!r} && !b.disabled);
        if (!b) return false;
        b.click();
        return true;"""), app_id)
    if not clicked:
        raise SystemExit(f"FAILED: no enabled {text!r} button on the tile")


async def wait_state(browser, app_id, state, timeout=60):
    await wait_js(browser, f"""() => (document.getElementById('tile-{app_id}')?.innerText ?? '')
        .includes({state!r}) && !document.getElementById('tile-{app_id}').querySelector('[aria-label="Working"]')""",
                  timeout=timeout)


async def main(outdir, app_id):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    os.environ["PITSTORE_SHOT_DIR"] = str(outdir)
    async with ChromiumBidi(headless=True) as browser:
        await browser.bidi("browsingContext.setViewport", context=browser.top_context,
                           viewport={"width": 1280, "height": 900})
        await login(browser)
        await browser.bidi("browsingContext.navigate", context=browser.top_context,
                           url=f"{BASE}/pitstore/dashboard", wait="complete", timeout=60)
        await wait_js(browser, f"() => !!document.querySelector(\"iframe[name='{FRAME}']\")")
        await browser.switch_to_frame(FRAME)

        await wait_state(browser, app_id, "Running", timeout=90)
        print(f"ok   tile for {app_id} shows Running")

        # summary: every card shows a value once two CPU samples exist
        await wait_js(browser, """() => ['cpu', 'memory', 'disk', 'uptime'].every(id => {
            const card = document.getElementById('pitstore-summary-' + id);
            return card && !card.querySelector('.pf-v6-c-spinner') && /\\d/.test(card.innerText);
        })""", timeout=30)
        summary = await run_js(browser, """() => ['cpu', 'memory', 'disk', 'uptime']
            .map(id => document.getElementById('pitstore-summary-' + id).innerText.replace(/\\s+/g, ' ')).join(' | ')""")
        print(f"ok   summary: {summary}")
        await wait_js(browser, f"() => !!document.getElementById('tile-{app_id}')?.querySelector('img[src^=\"data:image/\"]')",
                      timeout=60)
        print("ok   app icon shown as a data: URL")
        browser.switch_to_top()
        await save_shot(browser, outdir / "dashboard.png")
        await browser.switch_to_frame(FRAME)

        href = await run_js(browser, tile_js("""
            return [...tile.querySelectorAll('a')].find(a => a.textContent.trim() === 'Open')?.href ?? '';"""), app_id)
        status = http_status(href)
        if status != 200:
            raise SystemExit(f"FAILED: Open link {href} answered {status}")
        print(f"ok   open: {href} answered HTTP 200")

        await tile_click(browser, app_id, "Stop")
        await wait_state(browser, app_id, "Stopped")
        print("ok   stopped from the tile")
        await tile_click(browser, app_id, "Start")
        await wait_state(browser, app_id, "Running")
        print("ok   started from the tile")
        await tile_click(browser, app_id, "Restart")
        await wait_state(browser, app_id, "Running")
        print("ok   restarted from the tile")

        errors = [str(m) for m in browser.logs if m.level == "error"]
        if errors:
            raise SystemExit("FAILED: console errors:\n  " + "\n  ".join(errors))
        print("ok   no console errors")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
