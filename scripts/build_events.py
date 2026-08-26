"""Weekly pipeline: Google Sheet (CSV) -> geocode -> filter to current week -> events.geojson

Usage:
    python3 build_events.py
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import config
import fetch_events
import geocode as geocode_module

WEEKDAY_COLORS = {
    "Monday": "#6366F1",
    "Tuesday": "#22C55E",
    "Wednesday": "#EAB308",
    "Thursday": "#DB2777",
    "Friday": "#EF4444",
    "Saturday": "#A855F7",
    "Sunday": "#6B7280",
}

REQUIRED_FIELDS = ["name", "event_type", "start_date", "start_time", "venue", "address", "city", "status"]

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "events.geojson")


def current_week_bounds(today: datetime.date) -> tuple[datetime.date, datetime.date]:
    week_start = today - datetime.timedelta(days=today.weekday())
    week_end = week_start + datetime.timedelta(days=6)
    return week_start, week_end


def validate(row: dict) -> list[str]:
    return [field for field in REQUIRED_FIELDS if not row.get(field, "").strip()]


def build() -> None:
    rows = fetch_events.fetch(config.SHEET_CSV_URL)
    cache = geocode_module.load_cache()

    week_start, week_end = current_week_bounds(datetime.date.today())

    features = []
    for row in rows:
        missing = validate(row)
        if missing:
            print(f"Skipping '{row.get('name', '<unnamed>')}': missing {missing}")
            continue

        if row["status"].strip().lower() != "active":
            continue

        try:
            event_date = datetime.date.fromisoformat(row["start_date"].strip())
        except ValueError:
            print(f"Skipping '{row['name']}': bad start_date '{row['start_date']}'")
            continue

        if not (week_start <= event_date <= week_end):
            continue

        try:
            lat, lon = geocode_module.geocode(
                row["address"].strip(), row["city"].strip(), config.MAPBOX_TOKEN, cache
            )
        except ValueError as e:
            print(f"Skipping '{row['name']}': {e}")
            continue

        weekday = event_date.strftime("%A")

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": row.get("id", ""),
                    "name": row["name"],
                    "event_type": row["event_type"],
                    "date": row["start_date"],
                    "date_label": event_date.strftime("%a, %b %d"),
                    "start_time": row["start_time"],
                    "end_time": row.get("end_time", ""),
                    "venue": row["venue"],
                    "address": row["address"],
                    "city": row["city"],
                    "description": row.get("description", ""),
                    "event_url": row.get("event_url", ""),
                    "image_url": row.get("image_url", ""),
                    "contact": row.get("contact", ""),
                    "weekday": weekday,
                    "color": WEEKDAY_COLORS[weekday],
                },
            }
        )

    geocode_module.save_cache(cache)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, indent=2)

    print(f"Wrote {len(features)} event(s) to {OUTPUT_PATH}")


if __name__ == "__main__":
    build()
