# SPDX-License-Identifier: LGPL-2.1-or-later
"""Small helpers shared by the browser tests."""

import ssl
import urllib.request


def http_status(url):
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, timeout=10, context=ctx) as r:
            return r.status
    except Exception as e:
        return str(e)
