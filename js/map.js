mapboxgl.accessToken = MAPBOX_TOKEN;

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch (e) {
    return false;
  }
}

let allFeatures = [];
let map = null;
let staticMapState = null; // { features, center, zoom, width, height } - set when rendering the no-WebGL fallback
const STATIC_ZOOM_MIN = 3;
const STATIC_ZOOM_MAX = 18;
const webglSupported = supportsWebGL();

function updateDebugPanel() {
  let panel = document.getElementById("debug-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "debug-panel";
    document.body.appendChild(panel);
  }
  const lines = [
    `WebGL: ${webglSupported ? "yes" : "no"}`,
    `Mode: ${webglSupported ? "Interactive map" : "Static fallback"}`,
  ];
  if (staticMapState) {
    const shown = document.querySelectorAll(".static-map-label").length;
    lines.push(`Zoom: ${staticMapState.zoom.toFixed(2)}`);
    lines.push(`Labels shown: ${shown}/${staticMapState.features.length}`);
  }
  panel.innerHTML = lines.join("<br>");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function timeToMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr || "").trim());
  if (!match) return 0;
  let [, hours, minutes, period] = match;
  hours = parseInt(hours, 10) % 12;
  if (period.toUpperCase() === "PM") hours += 12;
  return hours * 60 + parseInt(minutes, 10);
}

function renderEventRow(p) {
  const when = p.end_time ? `${p.start_time} - ${p.end_time}` : p.start_time;

  const details = [];
  if (p.image_url) {
    details.push(`<a href="${escapeAttr(p.image_url)}" target="_blank" rel="noopener" class="event-details-link" onclick="event.stopPropagation()">
      <img class="event-thumb" src="${escapeAttr(p.image_url)}" alt="${escapeAttr(p.name)} flyer" loading="lazy" />
    </a>`);
  }
  if (p.event_url) {
    details.push(`<a href="${escapeAttr(p.event_url)}" target="_blank" rel="noopener" class="event-details-link" onclick="event.stopPropagation()">View details &#8599;</a>`);
  }

  return `
    <div class="event-row" data-id="${escapeAttr(p.id)}" style="--row-color: ${escapeAttr(p.color)}">
      <div class="event-name">${escapeHtml(p.name)}</div>
      <div class="event-when">${escapeHtml(when)}</div>
      <div class="event-where">${escapeHtml(p.venue)}${p.city ? `, ${escapeHtml(p.city)}` : ""}</div>
      ${details.length ? `<div class="event-details">${details.join("")}</div>` : ""}
    </div>
  `;
}

function renderEventList(features) {
  const list = document.getElementById("event-list");
  const sorted = [...features].sort((a, b) => {
    const dateDiff = a.properties.date.localeCompare(b.properties.date);
    if (dateDiff !== 0) return dateDiff;
    return timeToMinutes(a.properties.start_time) - timeToMinutes(b.properties.start_time);
  });

  const days = [];
  const daysByDate = new Map();
  for (const feature of sorted) {
    const date = feature.properties.date;
    if (!daysByDate.has(date)) {
      const group = { date, features: [] };
      daysByDate.set(date, group);
      days.push(group);
    }
    daysByDate.get(date).features.push(feature);
  }

  list.innerHTML = days
    .map((day) => {
      const dayLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      const rows = day.features.map((f) => renderEventRow(f.properties)).join("");
      const dayColor = day.features[0].properties.color;
      return `
        <div class="day-group">
          <div class="day-header" style="--day-color: ${escapeAttr(dayColor)}">${dayLabel}</div>
          ${rows}
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".event-row").forEach((row) => {
    row.addEventListener("click", () => selectEvent(row.dataset.id));
  });
}

function selectEvent(id) {
  const feature = allFeatures.find((f) => f.properties.id === id);
  if (!feature) return;

  if (map) {
    map.getSource("selected-event").setData({ type: "FeatureCollection", features: [feature] });
    map.flyTo({
      center: feature.geometry.coordinates,
      zoom: Math.max(map.getZoom(), 12),
      essential: true,
    });
  } else {
    updateStaticMapHighlight(feature);
  }

  document.querySelectorAll(".event-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.id === id);
  });
  const activeRow = document.querySelector(`.event-row[data-id="${CSS.escape(id)}"]`);
  if (activeRow) activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function showStaticMapNotice() {
  const notice = document.createElement("div");
  notice.id = "map-static-notice";
  notice.textContent =
    "Showing a static map - interactive zoom and click aren't available in this browser.";
  document.querySelector(".layout").prepend(notice);
}

// Standard Web Mercator projection, same math the map tiles themselves use -
// lets us compute pixel positions for clickable hotspots over the static image.
function mercatorX(lon) {
  return (lon + 180) / 360;
}

function mercatorY(lat) {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

// Mapbox's Static Images API renders these GL/vector styles on a 512px tile
// grid (not the classic 256px raster convention) - confirmed empirically by
// sampling rendered pixels, since a 256px assumption placed markers exactly
// one zoom level too far out and off-frame.
const TILE_SIZE = 512;

function projectToPixel(lon, lat, center, zoom, width, height) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const centerX = mercatorX(center[0]) * scale;
  const centerY = mercatorY(center[1]) * scale;
  return {
    x: mercatorX(lon) * scale - centerX + width / 2,
    y: mercatorY(lat) * scale - centerY + height / 2,
  };
}

// Replicates a "fit bounds" calculation so we know the exact center/zoom the
// static image will use - "auto" mode doesn't tell us that, and we need the
// same values to place hotspots at the right pixel positions.
function fitBounds(features, width, height, padding) {
  const lons = features.map((f) => f.geometry.coordinates[0]);
  const lats = features.map((f) => f.geometry.coordinates[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const fracX = Math.max(maxLon - minLon, 0.0001) / 360;
  const fracY = Math.max(Math.abs(mercatorY(minLat) - mercatorY(maxLat)), 0.0001);

  const availableW = Math.max(width - 2 * padding, 50);
  const availableH = Math.max(height - 2 * padding, 50);

  const scale = Math.min(availableW / fracX, availableH / fracY);
  const zoom = Math.max(3, Math.min(Math.log2(scale / TILE_SIZE), 16));

  return { center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2], zoom };
}

function buildStaticMapUrl(features, width, height, center, zoom) {
  const overlays = features
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const color = f.properties.color.replace("#", "");
      return `pin-s+${color}(${lon},${lat})`;
    })
    .join(",");
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/${center[0]},${center[1]},${zoom}/${width}x${height}?access_token=${MAPBOX_TOKEN}`;
}

function updateStaticMapHighlight(feature) {
  if (!staticMapState) return;
  const ring = document.getElementById("static-map-ring");
  if (!ring) return;
  const [lon, lat] = feature.geometry.coordinates;
  const { center, zoom, width, height } = staticMapState;
  const { x, y } = projectToPixel(lon, lat, center, zoom, width, height);
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.display = "block";
}

const labelMeasureCtx = document.createElement("canvas").getContext("2d");

function estimateLabelSize(name, dateLabel) {
  labelMeasureCtx.font = "600 11px system-ui, -apple-system, sans-serif";
  const nameWidth = labelMeasureCtx.measureText(name).width;
  labelMeasureCtx.font = "11px system-ui, -apple-system, sans-serif";
  const dateWidth = labelMeasureCtx.measureText(dateLabel).width;
  return { width: Math.max(nameWidth, dateWidth) + 10, height: 30 };
}

function boxesOverlap(a, b, margin) {
  return !(
    a.right + margin < b.left ||
    a.left - margin > b.right ||
    a.bottom + margin < b.top ||
    a.top - margin > b.bottom
  );
}

function redrawStaticMap() {
  const { features, center, zoom, width, height } = staticMapState;

  document.querySelector(".static-map-image").src = buildStaticMapUrl(features, width, height, center, zoom);

  const wrap = document.querySelector(".static-map-wrap");
  wrap.querySelectorAll(".static-map-hotspot, .static-map-label").forEach((el) => el.remove());

  // Real collision detection instead of a hard zoom cutoff - a label is only
  // skipped if it would actually overlap one already placed, same spirit as
  // the interactive map's text-allow-overlap/text-optional behavior, so some
  // labels are visible even at the default zoomed-out view.
  const placedBoxes = [];
  features.forEach((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const { x, y } = projectToPixel(lon, lat, center, zoom, width, height);

    // Skip pins that have scrolled outside the current zoomed-in frame -
    // otherwise their labels float in the letterboxed space around the image.
    if (x < 0 || x > width || y < 0 || y > height) return;

    const hotspot = document.createElement("button");
    hotspot.type = "button";
    hotspot.className = "static-map-hotspot";
    hotspot.style.left = `${x}px`;
    hotspot.style.top = `${y}px`;
    hotspot.setAttribute("aria-label", f.properties.name);
    hotspot.addEventListener("click", () => selectEvent(f.properties.id));
    wrap.appendChild(hotspot);

    const { width: lw, height: lh } = estimateLabelSize(f.properties.name, f.properties.date_label);
    const box = { left: x + 12, top: y - lh / 2, right: x + 12 + lw, bottom: y + lh / 2 };
    if (placedBoxes.some((b) => boxesOverlap(box, b, 4))) return;
    placedBoxes.push(box);

    const label = document.createElement("div");
    label.className = "static-map-label";
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
    label.innerHTML = `<span class="static-map-label-name">${escapeHtml(f.properties.name)}</span><span class="static-map-label-date">${escapeHtml(f.properties.date_label)}</span>`;
    wrap.appendChild(label);
  });

  updateDebugPanel();

  const activeRow = document.querySelector(".event-row.active");
  const activeFeature = activeRow && features.find((f) => f.properties.id === activeRow.dataset.id);
  if (activeFeature) {
    updateStaticMapHighlight(activeFeature);
  } else {
    document.getElementById("static-map-ring").style.display = "none";
  }
}

function adjustStaticZoom(delta) {
  if (!staticMapState) return;
  staticMapState.zoom = Math.max(STATIC_ZOOM_MIN, Math.min(staticMapState.zoom + delta, STATIC_ZOOM_MAX));
  redrawStaticMap();
}

function renderStaticMap(features) {
  const mapEl = document.getElementById("map");
  mapEl.classList.add("static-fallback");
  // Clamp once, up front - the Static Images API caps requests at 1280px, and
  // hotspot positions must be computed against the SAME size actually rendered,
  // not the (possibly larger) container size, or pins and hit-targets drift apart.
  const width = Math.max(200, Math.min(Math.round(mapEl.clientWidth) || 800, 1280));
  const height = Math.max(200, Math.min(Math.round(mapEl.clientHeight) || 500, 1280));
  const padding = 40;
  const { center, zoom } = fitBounds(features, width, height, padding);
  staticMapState = { features, center, zoom, width, height };

  mapEl.innerHTML = `
    <div class="static-map-wrap" style="width: ${width}px; height: ${height}px;">
      <img alt="Map of this week's events" width="${width}" height="${height}" class="static-map-image" />
      <div id="static-map-ring"></div>
    </div>
    <div class="static-map-zoom-controls">
      <button type="button" id="static-zoom-in" aria-label="Zoom in">+</button>
      <button type="button" id="static-zoom-out" aria-label="Zoom out">&minus;</button>
    </div>
  `;

  document.getElementById("static-zoom-in").addEventListener("click", () => adjustStaticZoom(1));
  document.getElementById("static-zoom-out").addEventListener("click", () => adjustStaticZoom(-1));

  redrawStaticMap();
}

function loadEvents() {
  return fetch("data/events.geojson").then((res) => res.json());
}

updateDebugPanel();

if (webglSupported) {
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-112.074, 33.448], // Phoenix
    zoom: 9,
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  map.on("load", () => {
    loadEvents().then((geojson) => {
      allFeatures = geojson.features;

      map.addSource("events", { type: "geojson", data: geojson });

      map.addLayer({
        id: "event-points",
        type: "circle",
        source: "events",
        paint: {
          "circle-radius": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 9, 12, 13, 15, 20, 18, 30],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "event-labels",
        type: "symbol",
        source: "events",
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["get", "date_label"]],
          "text-size": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 10, 12, 16, 15, 30, 18, 48],
          "text-anchor": "left",
          "text-offset": [0.9, 0],
          "text-justify": "left",
          "text-allow-overlap": false,
          "text-optional": true,
        },
        paint: {
          "text-color": "#0f2a43",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      map.addSource("selected-event", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "event-points-highlight",
        type: "circle",
        source: "selected-event",
        paint: {
          "circle-radius": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 14, 12, 18, 15, 25, 18, 36],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#0f2a43",
        },
      });

      for (const layerId of ["event-points", "event-labels"]) {
        map.on("click", layerId, (e) => {
          selectEvent(e.features[0].properties.id);
        });
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      document.getElementById("week-summary").textContent =
        `${geojson.features.length} event(s) this week`;

      renderEventList(geojson.features);
    });
  });
} else {
  showStaticMapNotice();
  loadEvents().then((geojson) => {
    allFeatures = geojson.features;
    document.getElementById("week-summary").textContent =
      `${geojson.features.length} event(s) this week`;
    renderStaticMap(geojson.features);
    renderEventList(geojson.features);
  });
}
