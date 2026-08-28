"""Extract event details from a flyer image using Claude.

Prints a ready-to-paste row for a weekly CSV (see data/weeks/README.md). You
still fill in `id`, `image_url`, and `include` - and always sanity-check the
result, since the model can misread a flyer.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 scripts/extract_flyer.py path/to/flyer.jpg
    python3 scripts/extract_flyer.py https://example.com/flyer.png

Model defaults to claude-opus-5; override with EXTRACT_MODEL=claude-sonnet-5.
"""

import base64
import csv
import datetime
import io
import json
import mimetypes
import os
import sys
import urllib.request

try:
    import anthropic
except ImportError:
    sys.exit("The 'anthropic' package is required:  pip install anthropic")

MODEL = os.environ.get("EXTRACT_MODEL", "claude-opus-5")

CATEGORIES = ["Networking", "Open House", "Ribbon Cutting", "Misc"]

# Column order of the weekly CSV (data/weeks/README.md).
CSV_COLUMNS = [
    "id", "name", "category", "start_date", "start_time", "end_time",
    "venue", "address", "city", "description", "event_url", "image_url",
    "contact", "recurring", "rsvp", "include",
]

# Fields the model fills; the rest of CSV_COLUMNS are left for you.
EXTRACT_FIELDS = [
    "name", "category", "start_date", "start_time", "end_time",
    "venue", "address", "city", "description", "event_url", "contact",
    "recurring", "rsvp",
]
_BOOL_FIELDS = {"recurring", "rsvp"}

_MAGIC = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
}
_SUPPORTED = ("image/jpeg", "image/png", "image/gif", "image/webp")


def load_image(source: str) -> tuple[bytes, str]:
    if source.startswith(("http://", "https://")):
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
            media_type = resp.headers.get_content_type()
    else:
        with open(source, "rb") as f:
            data = f.read()
        media_type = mimetypes.guess_type(source)[0] or ""

    if media_type not in _SUPPORTED:
        media_type = next((mt for magic, mt in _MAGIC.items() if data.startswith(magic)), "")
        if not media_type and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            media_type = "image/webp"
    if media_type not in _SUPPORTED:
        sys.exit(f"Not a JPEG/PNG/GIF/WEBP image: {source}")
    return data, media_type


PROMPT = """\
This image is a flyer or social post for a single business / community event in
the Phoenix, Arizona metro area (senior-living industry networking scene).

Extract the event details and reply with ONE JSON object and nothing else:

{{
  "name": "",          // event title
  "category": "",       // exactly one of: {categories}
                        //   ribbon cuttings -> "Ribbon Cutting"
                        //   open houses / tours -> "Open House"
                        //   social or educational, not clearly networking -> "Misc"
                        //   otherwise -> "Networking"
  "start_date": "",     // YYYY-MM-DD; resolve relative dates against the reference date below
  "start_time": "",     // e.g. "9:00 AM"
  "end_time": "",       // e.g. "10:30 AM", or "" if not shown
  "venue": "",          // venue / host business name
  "address": "",        // street address if shown, otherwise repeat the venue name
  "city": "",           // Phoenix-metro city
  "description": "",     // one short line of useful notes (recurring? guests welcome? cost?), or ""
  "event_url": "",       // registration / details URL if shown, else ""
  "contact": "",         // phone or email if shown, else ""
  "recurring": false,    // true if the flyer says this repeats (weekly, monthly, "every 2nd Tuesday", ...)
  "rsvp": false          // true only if the flyer says to RSVP / register / reserve a seat
}}

Reference date (today): {today}. That week runs {week_start} to {week_end}.
Use "" for anything not shown - do not guess. Unreadable field -> "".
"""


def extract(image_bytes: bytes, media_type: str) -> dict:
    today = datetime.date.today()
    week_start = today - datetime.timedelta(days=today.weekday())
    prompt = PROMPT.format(
        categories=", ".join(f'"{c}"' for c in CATEGORIES),
        today=today.isoformat(),
        week_start=week_start.isoformat(),
        week_end=(week_start + datetime.timedelta(days=6)).isoformat(),
    )
    resp = anthropic.Anthropic().messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.standard_b64encode(image_bytes).decode(),
                    },
                },
                {"type": "text", "text": prompt},
            ],
        }],
    )
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        text = text[4:] if text.startswith("json") else text
        text = text.strip("` \n")
    return json.loads(text)


def csv_row(fields: dict) -> str:
    row = {c: "" for c in CSV_COLUMNS}
    for key in EXTRACT_FIELDS:
        value = fields.get(key, "")
        if key in _BOOL_FIELDS:
            value = "yes" if value is True or str(value).strip().lower() in ("yes", "true", "1") else "no"
        row[key] = "" if value is None else str(value).strip()
    buf = io.StringIO()
    csv.writer(buf, quoting=csv.QUOTE_ALL).writerow([row[c] for c in CSV_COLUMNS])
    return buf.getvalue().strip()


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        sys.exit(__doc__)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=sk-ant-...")

    image_bytes, media_type = load_image(sys.argv[1])
    if len(image_bytes) > 4_500_000:
        print(
            f"Warning: image is {len(image_bytes) / 1e6:.1f} MB; the API caps at ~5 MB.",
            file=sys.stderr,
        )

    try:
        fields = extract(image_bytes, media_type)
    except anthropic.AuthenticationError:
        sys.exit("ANTHROPIC_API_KEY is invalid.")
    except anthropic.NotFoundError:
        sys.exit(f"Model '{MODEL}' is not available to this API key. Try EXTRACT_MODEL=claude-sonnet-5.")
    except anthropic.APIError as e:
        sys.exit(f"Claude API error: {e}")
    except json.JSONDecodeError:
        sys.exit("Could not parse the model's reply as JSON - rerun, or extract by hand.")

    print("\nExtracted (review carefully - the model can misread a flyer):\n")
    for key in EXTRACT_FIELDS:
        print(f"  {key:12} {fields.get(key, '') if fields.get(key, '') != '' else '-'}")

    print("\nCSV row - fill in id / image_url / include, then paste into the week's file:\n")
    print(",".join(f'"{c}"' for c in CSV_COLUMNS))
    print(csv_row(fields))
    print()


if __name__ == "__main__":
    main()
