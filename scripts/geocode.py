"""Geocode event addresses via the Mapbox Geocoding API.

Results are cached in data/geocode_cache.json, keyed by address, so an
unchanged address is only ever geocoded once across weekly runs.
"""

import json
import os
import urllib.parse
import urllib.request

CACHE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "geocode_cache.json")


def load_cache() -> dict:
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            return json.load(f)
    return {}


def save_cache(cache: dict) -> None:
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)


def geocode(address: str, city: str, mapbox_token: str, cache: dict) -> tuple[float, float]:
    key = f"{address}, {city}"
    if key in cache:
        lat, lon = cache[key]
        return lat, lon

    query = urllib.parse.quote(f"{address}, {city}, AZ")
    url = (
        f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json"
        f"?access_token={mapbox_token}&limit=1"
    )
    with urllib.request.urlopen(url) as response:
        data = json.load(response)

    if not data.get("features"):
        raise ValueError(f"no geocoding result for address: {key}")

    lon, lat = data["features"][0]["center"]
    cache[key] = [lat, lon]
    return lat, lon
