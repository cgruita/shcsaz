# Weekly event sources

One CSV per week. The file name is the **Monday** of that week, ISO format:

```
data/weeks/2026-08-24.csv   -> week of Mon Aug 24 – Sun Aug 30, 2026
```

`build_events.py` automatically loads the file for the current week (based on
today's date), geocodes the addresses, and writes `data/events.geojson`, which
the map reads.

## Columns

| column        | required | notes |
|---------------|----------|-------|
| `id`          | yes      | stable unique id, e.g. `e001` — keep it the same if you edit a row |
| `name`        | yes      | event title |
| `category`    | no       | one of `Networking`, `Open House`, `Ribbon Cutting`, `Misc`. Blank or anything else → `Misc` |
| `start_date`  | yes      | `YYYY-MM-DD`, must fall inside that week |
| `start_time`  | yes      | e.g. `9:00 AM` |
| `end_time`    | no       | e.g. `10:30 AM` |
| `venue`       | yes      | shown on the map/list |
| `address`     | yes      | street address (or venue name) used for geocoding |
| `city`        | yes      | used for geocoding |
| `description` | no       | free text |
| `event_url`   | no       | "View details" link |
| `image_url`   | no       | flyer thumbnail |
| `contact`     | no       | phone / email, internal reference |
| `recurring`   | no       | `yes` shows a "↻" badge (event repeats weekly/monthly); anything else = none |
| `rsvp`        | no       | `yes` shows an "RSVP" badge on the event; anything else (`no`, blank) = none |
| `include`     | yes      | `yes` puts the event on the map; anything else (`no`, blank) keeps it out |

## Adding next week

Copy the latest file to `data/weeks/<next-monday>.csv`, replace the rows, then
run `python3 scripts/build_events.py`.

## Reading flyer text

`scripts/ocr_flyers.swift` transcribes every image in `data/flyers/` (macOS
Vision - free, offline, no API key):

```
swift scripts/ocr_flyers.swift                       # all images in data/flyers/
swift scripts/ocr_flyers.swift data/flyers/foo.png   # specific files
```

## Getting a row from a flyer image

`scripts/extract_flyer.py` reads a flyer (file or URL) with Claude and prints a
draft CSV row - fill in `id` / `image_url` / `include`, sanity-check it, and
paste it in:

Drop the image in `data/flyers/` (git-ignored) or pass any path / URL:

```
export ANTHROPIC_API_KEY=sk-ant-...
python3 scripts/extract_flyer.py data/flyers/handels-ribbon-cutting.jpg
python3 scripts/extract_flyer.py https://example.com/flyer.png
```
