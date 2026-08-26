"""Fetch the event table from a published Google Sheets CSV URL, or a local CSV file."""

import csv
import io
import urllib.request


def fetch(csv_source: str) -> list[dict]:
    if csv_source.startswith("http://") or csv_source.startswith("https://"):
        with urllib.request.urlopen(csv_source) as response:
            raw = response.read().decode("utf-8")
    else:
        with open(csv_source, encoding="utf-8") as f:
            raw = f.read()
    reader = csv.DictReader(io.StringIO(raw))
    return [row for row in reader]
