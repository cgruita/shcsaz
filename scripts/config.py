"""Local configuration - fill in your own values below.
"""

import os
import re

# Google Sheets: File > Share > Publish to web > select the events sheet/tab > CSV
# Temporary stand-in until the real Sheet exists: local CSV with this week's events.
# Once you've moved this data into Google Sheets and published it, swap this for
# the https:// CSV URL - fetch_events.py accepts either.
SHEET_CSV_URL = os.path.join(os.path.dirname(__file__), "..", "data", "events_source.csv")

# Mapbox: js/config.js is the one place the token needs to be hardcoded (it has
# to ship to the browser regardless), so read it from there instead of keeping
# a second committed copy here.
_JS_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "js", "config.js")


def _read_mapbox_token() -> str:
    with open(_JS_CONFIG_PATH) as f:
        contents = f.read()
    match = re.search(r'MAPBOX_TOKEN\s*=\s*"([^"]+)"', contents)
    if not match:
        raise RuntimeError(f"Could not find MAPBOX_TOKEN in {_JS_CONFIG_PATH}")
    return match.group(1)


MAPBOX_TOKEN = _read_mapbox_token()
