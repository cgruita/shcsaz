"""Build images/preview.png (1200x630 OG/share image) and refresh OG meta tags in index.html.

Run: python3 scripts/build_preview.py   (also called automatically by build_events.py)
Basemap: OpenStreetMap standard tiles, (c) OpenStreetMap contributors. Tiles cached in data/tile_cache/.
"""
import datetime, io, json, math, os, re, urllib.request
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(ROOT, "data", "events.geojson")
OUT = os.path.join(ROOT, "images", "preview.png")
LOGO = os.path.join(ROOT, "images", "light-on-logo.png")
INDEX = os.path.join(ROOT, "index.html")
TILE_CACHE = os.path.join(ROOT, "data", "tile_cache")
SITE = "https://cgruita.github.io/shcsaz/"
W, H, PANEL = 1200, 630, 470
NAVY, MUTED, LINE = "#0f2a43", "#b9c7d6", "#3b5875"
FD = "/System/Library/Fonts/Supplemental/"


def font(name, size):
    for n in (name, "Arial.ttf"):
        try:
            return ImageFont.truetype(FD + n, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


def lonlat_px(lon, lat, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def tile(z, x, y):
    os.makedirs(TILE_CACHE, exist_ok=True)
    p = os.path.join(TILE_CACHE, f"{z}_{x}_{y}.png")
    if not os.path.exists(p):
        req = urllib.request.Request(
            f"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            headers={"User-Agent": "shcsaz-preview/1.0 (+https://cgruita.github.io/shcsaz/)"})
        with urllib.request.urlopen(req, timeout=20) as r, open(p, "wb") as f:
            f.write(r.read())
    return Image.open(p).convert("RGB")


def basemap(pts, mw, mh):
    lons = [p[0] for p in pts] + [-112.45, -111.70]
    lats = [p[1] for p in pts] + [33.30, 33.72]
    z = 11
    x0, y1 = lonlat_px(min(lons), min(lats), z)
    x1, y0 = lonlat_px(max(lons), max(lats), z)
    pad = 0.12
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = (x1 - x0) * (1 + pad), (y1 - y0) * (1 + pad)
    if bw / bh < mw / mh:
        bw = bh * mw / mh
    else:
        bh = bw * mh / mw
    left, top = cx - bw / 2, cy - bh / 2
    scale = 1
    canvas = Image.new("RGB", (int(bw * scale) + 1024, int(bh * scale) + 1024), "white")
    tx0, ty0 = int(left // 256), int(top // 256)
    for tx in range(tx0, int((left + bw) // 256) + 1):
        for ty in range(ty0, int((top + bh) // 256) + 1):
            canvas.paste(tile(z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    ox, oy = (left - tx0 * 256) * scale, (top - ty0 * 256) * scale
    img = canvas.crop((int(ox), int(oy), int(ox + bw * scale), int(oy + bh * scale))).resize((mw, mh), Image.LANCZOS)
    img = Image.blend(img, Image.new("RGB", img.size, "white"), 0.30)
    k = mw / bw
    proj = lambda lon, lat: ((lonlat_px(lon, lat, z)[0] - left) * k, (lonlat_px(lon, lat, z)[1] - top) * k)
    return img, proj


def fit(draw, text, f, maxw):
    if draw.textlength(text, font=f) <= maxw:
        return text
    while text and draw.textlength(text + "…", font=f) > maxw:
        text = text[:-1]
    return text.rstrip(" ,&-") + "…"


def week_label(dates):
    mon = min(dates) - datetime.timedelta(days=min(dates).weekday())
    sun = mon + datetime.timedelta(days=6)
    if mon.month == sun.month:
        return f"{mon:%b} {mon.day}–{sun.day}", mon
    return f"{mon:%b} {mon.day} – {sun:%b} {sun.day}", mon


def build_preview():
    feats = json.load(open(GEOJSON))["features"]
    feats.sort(key=lambda f: (f["properties"]["date"],
                              datetime.datetime.strptime(f["properties"]["start_time"] or "12:00 AM", "%I:%M %p")))
    dates = [datetime.date.fromisoformat(f["properties"]["date"]) for f in feats] or [datetime.date.today()]
    label, _ = week_label(dates)
    n = len(feats)

    img = Image.new("RGB", (W, H), NAVY)
    pts = [f["geometry"]["coordinates"] for f in feats]
    mw = W - PANEL
    m, proj = basemap(pts, mw, H)
    img.paste(m, (PANEL, 0))
    d = ImageDraw.Draw(img)

    # pins (numbered, weekday-colored)
    pf = font("Arial Bold.ttf", 17)
    placed = []
    for i, f in enumerate(feats, 1):
        x, y = proj(*f["geometry"]["coordinates"])
        x += PANEL
        for _ in range(6):  # nudge overlapping pins apart
            hit = next(((px, py) for px, py in placed if math.hypot(x - px, y - py) < 30), None)
            if not hit:
                break
            ang = math.atan2(y - hit[1], x - hit[0]) if (x, y) != hit else -math.pi / 4
            x, y = hit[0] + 31 * math.cos(ang), hit[1] + 31 * math.sin(ang)
        placed.append((x, y))
        r = 15
        d.ellipse((x - r, y - r + 2, x + r, y + r + 2), fill=(0, 0, 0, 60))
        d.ellipse((x - r, y - r, x + r, y + r), fill=f["properties"]["color"], outline="white", width=3)
        d.text((x, y), str(i), font=pf, fill="white", anchor="mm")
    af = font("Arial.ttf", 11)
    att = "© OpenStreetMap contributors"
    tw = d.textlength(att, font=af)
    d.rectangle((W - tw - 12, H - 18, W, H), fill="white")
    d.text((W - 6, H - 9), att, font=af, fill="#555", anchor="rm")

    # panel
    x0 = 36
    d.text((x0, 30), "Senior Living Events", font=font("Arial Bold.ttf", 40), fill="white")
    d.text((x0, 84), f"{label}  ·  {n} event{'s' if n != 1 else ''}", font=font("Arial Bold.ttf", 28), fill="#fbbf24")
    d.text((x0, 122), "Phoenix metro · assisted living", font=font("Arial.ttf", 19), fill=MUTED)
    d.line((x0, 156, PANEL - 30, 156), fill=LINE, width=2)

    days = {}
    for i, f in enumerate(feats, 1):
        days.setdefault(f["properties"]["date"], []).append((i, f["properties"]))
    rows = n + len(days)
    avail = H - 170 - 70
    lh = max(18, min(30, avail // max(rows, 1)))
    nf, df = font("Arial.ttf", lh - 9), font("Arial Bold.ttf", lh - 9)
    y = 168
    for ds, evs in days.items():
        dt = datetime.date.fromisoformat(ds)
        d.text((x0, y), f"{dt:%a} {dt:%b} {dt.day}".upper(), font=df, fill=MUTED)
        y += lh
        for i, p in evs:
            cy = y + (lh - 9) // 2 + 1
            d.ellipse((x0, cy - 9, x0 + 18, cy + 9), fill=p["color"])
            d.text((x0 + 9, cy), str(i), font=font("Arial Bold.ttf", 11), fill="white", anchor="mm")
            d.text((x0 + 28, y), fit(d, p["name"], nf, PANEL - x0 - 60), font=nf, fill="white")
            y += lh

    # credit
    if os.path.exists(LOGO):
        logo = Image.open(LOGO).convert("RGBA")
        lh2 = 34
        logo = logo.resize((int(logo.width * lh2 / logo.height), lh2), Image.LANCZOS)
        cf = font("Arial.ttf", 14)
        d.text((x0, H - 30 - lh2 // 2), "Map by", font=cf, fill=MUTED, anchor="lm")
        lx, ly = x0 + 54, H - 30 - lh2
        d.rounded_rectangle((lx - 8, ly - 4, lx + logo.width + 8, ly + lh2 + 4), radius=8, fill="white")
        img.paste(logo, (lx, ly), logo)
    d.text((PANEL - 30, H - 30 - 17), "cgruita.github.io/shcsaz", font=font("Arial.ttf", 14), fill=MUTED, anchor="rm")

    img.save(OUT, optimize=True)
    print(f"Wrote {OUT} ({n} events, {label})")
    update_meta(label, n)


def update_meta(label, n):
    ver = open(os.path.join(ROOT, "version.txt")).read().strip()
    title = f"Senior Living Events · {label}"
    desc = f"{label} · {n} assisted living event{'s' if n != 1 else ''} across the Valley"
    block = "\n".join([
        "  <!-- og:start (generated by scripts/build_preview.py) -->",
        '  <meta name="description" content="%s" />' % desc,
        '  <meta property="og:type" content="website" />',
        '  <meta property="og:title" content="%s" />' % title,
        '  <meta property="og:description" content="%s" />' % desc,
        f'  <meta property="og:url" content="{SITE}" />',
        f'  <meta property="og:image" content="{SITE}images/preview.png?v={ver}" />',
        '  <meta property="og:image:width" content="1200" />',
        '  <meta property="og:image:height" content="630" />',
        '  <meta name="twitter:card" content="summary_large_image" />',
        '  <meta name="twitter:title" content="%s" />' % title,
        '  <meta name="twitter:description" content="%s" />' % desc,
        f'  <meta name="twitter:image" content="{SITE}images/preview.png?v={ver}" />',
        "  <!-- og:end -->",
    ])
    html = open(INDEX).read()
    if "<!-- og:start" in html:
        html = re.sub(r"  <!-- og:start.*?<!-- og:end -->", lambda _: block, html, flags=re.S)
    else:
        html = html.replace('  <meta name="viewport"', block + '\n  <meta name="viewport"', 1)
    open(INDEX, "w").write(html)
    print(f"Updated OG tags in index.html (v={ver})")


if __name__ == "__main__":
    build_preview()
