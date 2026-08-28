"""Local configuration - fill in your own values below.
"""

import datetime
import os
import re

_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def week_csv_path(today: datetime.date | None = None) -> str:
    """Path to the CSV for the week containing `today` (defaults to today).

    Files live in data/weeks/ and are named after that week's Monday, e.g.
    data/weeks/2026-08-24.csv. fetch_events.fetch() also accepts an https:// URL,
    so this can later be swapped for a published Google Sheet if needed.
    """
    today = today or datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    return os.path.join(_DATA_DIR, "weeks", f"{monday.isoformat()}.csv")

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
