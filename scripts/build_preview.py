"""Build images/preview.png (1200x630 OG/share image) + images/preview@2x.png (2400x1260, for posting) and refresh OG meta tags in index.html.

Run: python3 scripts/build_preview.py   (also called automatically by build_events.py)
Basemap: OpenStreetMap standard tiles, (c) OpenStreetMap contributors. Tiles cached in data/tile_cache/.
"""
import datetime, io, json, math, os, re, urllib.request
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(ROOT, "data", "events.geojson")
OUT = os.path.join(ROOT, "images", "preview.png")
OUT2X = os.path.join(ROOT, "images", "preview@2x.png")
LOGO_LG = os.path.join(ROOT, "images", "light-on-logo-lg.png")
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


def _t(t):
    m = re.match(r"\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])", t or "")
    if not m:
        return None
    h, mm, ap = m.group(1), m.group(2), m.group(3).lower() + "m"
    return (h + (":" + mm if mm and mm != "00" else "")), ap


def short_time(p, with_end=True):
    s = _t(p.get("start_time"))
    if not s:
        return ""
    e = _t(p.get("end_time")) if with_end else None
    if not e:
        return s[0] + s[1]
    return (s[0] if s[1] == e[1] else s[0] + s[1]) + "–" + e[0] + e[1]


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


def basemap(pts, mw, mh, S=1):
    lons = [p[0] for p in pts] + [-112.45, -111.70]
    lats = [p[1] for p in pts] + [33.30, 33.72]
    z = 11 + int(math.log2(S))  # 2x: one zoom level up, native-res tiles
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
    label, n = render(1, OUT)
    render(2, OUT2X)
    update_meta(label, n)


def render(S, out):
    W2, H2, P2 = W * S, H * S, PANEL * S
    q = lambda v: v * S
    feats = json.load(open(GEOJSON))["features"]
    feats.sort(key=lambda f: (f["properties"]["date"],
                              datetime.datetime.strptime(f["properties"]["start_time"] or "12:00 AM", "%I:%M %p")))
    dates = [datetime.date.fromisoformat(f["properties"]["date"]) for f in feats] or [datetime.date.today()]
    label, _ = week_label(dates)
    n = len(feats)

    img = Image.new("RGB", (W2, H2), NAVY)
    pts = [f["geometry"]["coordinates"] for f in feats]
    mw = W2 - P2
    m, proj = basemap(pts, mw, H2, S)
    img.paste(m, (P2, 0))
    d = ImageDraw.Draw(img)

    # pins (numbered, weekday-colored)
    pf = font("Arial Bold.ttf", q(17))
    placed = []
    for i, f in enumerate(feats, 1):
        x, y = proj(*f["geometry"]["coordinates"])
        x += P2
        for _ in range(6):  # nudge overlapping pins apart
            hit = next(((px, py) for px, py in placed if math.hypot(x - px, y - py) < q(30)), None)
            if not hit:
                break
            ang = math.atan2(y - hit[1], x - hit[0]) if (x, y) != hit else -math.pi / 4
            x, y = hit[0] + q(31) * math.cos(ang), hit[1] + q(31) * math.sin(ang)
        placed.append((x, y))
        r = q(15)
        d.ellipse((x - r, y - r + q(2), x + r, y + r + q(2)), fill=(0, 0, 0, 60))
        d.ellipse((x - r, y - r, x + r, y + r), fill=f["properties"]["color"], outline="white", width=q(3))
        d.text((x, y), str(i), font=pf, fill="white", anchor="mm")
    af = font("Arial.ttf", q(11))
    att = "© OpenStreetMap contributors"
    tw = d.textlength(att, font=af)
    d.rectangle((W2 - tw - q(12), H2 - q(18), W2, H2), fill="white")
    d.text((W2 - q(6), H2 - q(9)), att, font=af, fill="#555", anchor="rm")

    # panel
    x0 = q(36)
    d.text((x0, q(30)), "Senior Living Events", font=font("Arial Bold.ttf", q(40)), fill="white")
    d.text((x0, q(84)), f"{label}  ·  {n} event{'s' if n != 1 else ''}", font=font("Arial Bold.ttf", q(28)), fill="#fbbf24")
    d.text((x0, q(122)), "Phoenix metro · assisted living", font=font("Arial.ttf", q(19)), fill=MUTED)
    d.line((x0, q(156), P2 - q(30), q(156)), fill=LINE, width=q(2))

    days = {}
    for i, f in enumerate(feats, 1):
        days.setdefault(f["properties"]["date"], []).append((i, f["properties"]))
    rows = n + len(days)
    avail = H - 170 - 70
    lh = max(18, min(30, avail // max(rows, 1)))
    nf, df = font("Arial.ttf", q(lh - 9)), font("Arial Bold.ttf", q(lh - 9))
    y = q(168)
    tcol = d.textlength("10:30–11:30a", font=df) * 0 + d.textlength("12:30–4:30p", font=df)
    for ds, evs in days.items():
        dt = datetime.date.fromisoformat(ds)
        d.text((x0, y), f"{dt:%a} {dt:%b} {dt.day}".upper(), font=df, fill=MUTED)
        y += q(lh)
        for i, p in evs:
            cy = y + q((lh - 9) // 2 + 1)
            d.ellipse((x0, cy - q(9), x0 + q(18), cy + q(9)), fill=p["color"])
            d.text((x0 + q(9), cy), str(i), font=font("Arial Bold.ttf", q(11)), fill="white", anchor="mm")
            tx = x0 + q(28)
            t = short_time(p)
            if d.textlength(t, font=df) > tcol:
                t = short_time(p, with_end=False)
            d.text((tx, y), t, font=df, fill="#fbbf24")
            d.text((tx + tcol + q(8), y), fit(d, p["name"], nf, P2 - tx - tcol - q(38)), font=nf, fill="white")
            y += q(lh)

    # credit
    src = LOGO_LG if S > 1 and os.path.exists(LOGO_LG) else LOGO
    if os.path.exists(src):
        logo = Image.open(src).convert("RGBA")
        lh2 = q(34)
        logo = logo.resize((int(logo.width * lh2 / logo.height), lh2), Image.LANCZOS)
        cf = font("Arial.ttf", q(14))
        d.text((x0, H2 - q(30) - lh2 // 2), "Map by", font=cf, fill=MUTED, anchor="lm")
        lx, ly = x0 + q(72), H2 - q(30) - lh2
        d.rounded_rectangle((lx - q(8), ly - q(4), lx + logo.width + q(8), ly + lh2 + q(4)), radius=q(8), fill="white")
        img.paste(logo, (lx, ly), logo)
    d.text((P2 - q(30), H2 - q(30) - q(17)), "cgruita.github.io/shcsaz", font=font("Arial.ttf", q(14)), fill=MUTED, anchor="rm")

    img.save(out, optimize=True)
    print(f"Wrote {out} ({n} events, {label})")
    return label, n


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
