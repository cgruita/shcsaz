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
let map = null; // Mapbox GL map (WebGL path)
let glPopup = null; // the single open Mapbox GL detail popup, if any
let glPopupId = null; // id of the event whose GL popup is open (its box label is hidden)
let leaflet = null; // { map, markers: Map<id, marker> } - set when rendering the no-WebGL fallback
let currentView = "map"; // "map" | "split" | "table"
// mapboxgl.supported() is the authoritative check (it also rejects broken /
// blocklisted WebGL); fall back to the generic probe if the GL script failed
// to load at all. ?nowebgl=1 forces the Leaflet fallback for testing.
const webglSupported =
  !/[?&]nowebgl=1\b/.test(location.search) &&
  (window.mapboxgl && mapboxgl.supported ? mapboxgl.supported() : supportsWebGL());

// Mapbox raster tiles - rendered server-side, so they work without WebGL.
const RASTER_TILE_URL =
  `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;
const TILE_ATTRIBUTION =
  '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function updateDebugPanel() {
  let panel = document.getElementById("debug-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "debug-panel";
    document.body.appendChild(panel);
  }
  const mode = webglSupported ? "Interactive map (GL)" : "Leaflet fallback";
  const lines = [`WebGL: ${webglSupported ? "yes" : "no"}`, `Mode: ${mode}`, `View: ${currentView}`];
  if (leaflet && leaflet.map) {
    lines.push(`Zoom: ${leaflet.map.getZoom().toFixed(2)}`);
    lines.push(`Markers: ${leaflet.markers.size}`);
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

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A stretchable ("9-patch") rounded rectangle used as the background image
// behind the GL map's labels - Mapbox GL has no native text box, so this image
// is fitted around the text via icon-text-fit. One is built per weekday colour
// so the border matches the pin.
function makeLabelBg(borderColor) {
  const pr = 2;
  const size = 40 * pr;
  const margin = 1.5 * pr; // transparent breathing room around the box
  const border = 2 * pr;
  const outerR = 9 * pr;
  const innerR = Math.max(1, outerR - border);
  const boxOrigin = margin;
  const boxSize = size - 2 * margin;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Opaque border colour filling the whole box...
  roundRectPath(ctx, boxOrigin, boxOrigin, boxSize, boxSize, outerR);
  ctx.fillStyle = borderColor;
  ctx.fill();

  // ...then carve the interior to fully transparent and lay in the wash, so the
  // border stays a pure, opaque copy of the pin colour (no white bleed).
  const inner = boxOrigin + border;
  const innerSize = boxSize - 2 * border;
  ctx.globalCompositeOperation = "destination-out";
  roundRectPath(ctx, inner, inner, innerSize, innerSize, innerR);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  roundRectPath(ctx, inner, inner, innerSize, innerSize, innerR);
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fill();

  // Stretch zone must clear the whole rounded corner or the arc distorts when
  // the box is fitted to the text. The content box, though, hugs the border so
  // the text sits close to it instead of floating in a padded field.
  const stretchStart = margin + outerR;
  const contentPad = margin + border + 1;
  return {
    data: ctx.getImageData(0, 0, size, size),
    options: {
      pixelRatio: pr,
      stretchX: [[stretchStart, size - stretchStart]],
      stretchY: [[stretchStart, size - stretchStart]],
      content: [contentPad, contentPad, size - contentPad, size - contentPad],
    },
  };
}

function timeToMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr || "").trim());
  if (!match) return 0;
  let [, hours, minutes, period] = match;
  hours = parseInt(hours, 10) % 12;
  if (period.toUpperCase() === "PM") hours += 12;
  return hours * 60 + parseInt(minutes, 10);
}

function eventWhen(p) {
  return p.end_time ? `${p.start_time} - ${p.end_time}` : p.start_time;
}

function compareEvents(a, b) {
  const dateDiff = a.properties.date.localeCompare(b.properties.date);
  if (dateDiff !== 0) return dateDiff;
  return timeToMinutes(a.properties.start_time) - timeToMinutes(b.properties.start_time);
}

// ---------------------------------------------------------------------------
// Sidebar event list
// ---------------------------------------------------------------------------

function renderEventRow(p) {
  const when = eventWhen(p);

  const details = [];
  if (p.image_url) {
    details.push(lightboxThumb(p, "event-details-link", "event-thumb"));
  }
  details.push(directionsLink(p, "event-details-link"));
  if (p.event_url) {
    details.push(`<a href="${escapeAttr(p.event_url)}" target="_blank" rel="noopener" class="event-details-link" onclick="event.stopPropagation()">View details &#8599;</a>`);
  }

  return `
    <div class="event-row" data-id="${escapeAttr(p.id)}" style="--row-color: ${escapeAttr(p.color)}">
      <div class="event-name">${escapeHtml(p.name)}${eventBadges(p)}</div>
      <div class="event-when">${escapeHtml(when)}</div>
      <div class="event-where">${escapeHtml(p.venue)}${p.city ? `, ${escapeHtml(p.city)}` : ""}</div>
      ${details.length ? `<div class="event-details">${details.join("")}</div>` : ""}
    </div>
  `;
}

function rsvpBadge(p) {
  return p.rsvp ? ' <span class="rsvp-badge">RSVP</span>' : "";
}

function recurringBadge(p) {
  return p.recurring
    ? ' <span class="recurring-badge" title="Recurring event">↻</span>'
    : "";
}

// A "get directions" link searching for the event's street address (so the maps
// app shows the address, not a lat/long). Falls back to the venue name if the
// CSV row has no address.
//
// Apple Maps links only open the native app on iOS/iPadOS (and, on macOS, only
// in Safari) - every other desktop browser gets an "unsupported browser" page.
// So Apple Maps is used only on real iPhones/iPads; everything else, including
// all Macs, gets Google Maps, which works in every browser.
function directionsUrl(p) {
  const addr = [p.address, p.city].filter(Boolean).join(", ");
  const query = encodeURIComponent(addr ? `${addr}, AZ` : p.venue || p.name || "");
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
  return ios
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function directionsLink(p, cls) {
  return (
    `<a href="${escapeAttr(directionsUrl(p))}" target="_blank" rel="noopener"` +
    `${cls ? ` class="${cls}"` : ""} onclick="event.stopPropagation()">Directions &#8599;</a>`
  );
}

function flyerBadge(p) {
  return p.image_url || p.has_image
    ? ' <span class="flyer-badge" title="Has a flyer">FLYER</span>'
    : "";
}

function eventBadges(p) {
  return recurringBadge(p) + rsvpBadge(p);
}

// ---------------------------------------------------------------------------
// Flyer lightbox + shared map detail card
// ---------------------------------------------------------------------------

// An <a> that, when clicked, opens the flyer in the in-page lightbox instead of
// navigating. The href stays real so it still works if JS is disabled / for
// "open in new tab".
function lightboxThumb(p, linkClass, imgClass) {
  return (
    `<a href="${escapeAttr(p.image_url)}" class="${linkClass}" ` +
    `data-lightbox="${escapeAttr(p.image_url)}" data-lightbox-alt="${escapeAttr(p.name)} flyer">` +
    `<img class="${imgClass}" src="${escapeAttr(p.image_url)}" alt="${escapeAttr(p.name)} flyer" loading="lazy" />` +
    `</a>`
  );
}

function ensureLightbox() {
  let el = document.getElementById("lightbox");
  if (el) return el;
  el = document.createElement("div");
  el.id = "lightbox";
  el.hidden = true;
  el.innerHTML =
    '<button type="button" class="lightbox-close" aria-label="Close flyer">&times;</button>' +
    '<img class="lightbox-img" alt="" />';
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest(".lightbox-close")) closeLightbox();
  });
  document.body.appendChild(el);
  return el;
}

function onLightboxKey(e) {
  if (e.key === "Escape") closeLightbox();
}

function openLightbox(src, alt) {
  if (!src) return;
  const el = ensureLightbox();
  const img = el.querySelector(".lightbox-img");
  img.src = src;
  img.alt = alt || "";
  el.hidden = false;
  document.addEventListener("keydown", onLightboxKey);
}

function closeLightbox() {
  const el = document.getElementById("lightbox");
  if (!el || el.hidden) return;
  el.hidden = true;
  el.querySelector(".lightbox-img").src = "";
  document.removeEventListener("keydown", onLightboxKey);
}

// Capture phase so we intercept the click before it reaches an event row or a
// map marker - opening a flyer shouldn't also fire event selection / a popup.
document.addEventListener(
  "click",
  (e) => {
    const trigger = e.target.closest("[data-lightbox]");
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(trigger.getAttribute("data-lightbox"), trigger.getAttribute("data-lightbox-alt"));
  },
  true
);

// contact is free text like "480-555-1212 / name@example.com" - split on "/"
// and linkify the phone / email pieces.
function contactLinks(raw) {
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      if (token.includes("@") && !/\s/.test(token)) {
        return `<a href="mailto:${escapeAttr(token)}">${escapeHtml(token)}</a>`;
      }
      const dialable = token.replace(/[^\d+]/g, "");
      if (dialable.replace(/\D/g, "").length >= 7) {
        return `<a href="tel:${escapeAttr(dialable)}">${escapeHtml(token)}</a>`;
      }
      return escapeHtml(token);
    })
    .join(" &middot; ");
}

// The card shown in a map popup (GL and Leaflet share this markup).
function detailCardHtml(p, { showContact = false } = {}) {
  const lines = [
    `<strong>${escapeHtml(p.name)}</strong>${eventBadges(p)}`,
    `${escapeHtml(p.date_label)} &middot; ${escapeHtml(eventWhen(p))}`,
    `${escapeHtml(p.venue)}${p.city ? `, ${escapeHtml(p.city)}` : ""}`,
  ];
  if (p.description) lines.push(`<span class="map-popup-desc">${escapeHtml(p.description)}</span>`);
  if (showContact && p.contact) {
    lines.push(`<span class="map-popup-contact">${contactLinks(p.contact)}</span>`);
  }

  const thumb = p.image_url
    ? `<div class="map-popup-thumb">${lightboxThumb(p, "map-popup-thumb-link", "")}</div>`
    : "";

  const links = [directionsLink(p)];
  if (p.event_url) {
    links.push(
      `<a href="${escapeAttr(p.event_url)}" target="_blank" rel="noopener">View details &#8599;</a>`
    );
  }
  const linkBar = `<div class="map-popup-links">${links.join("")}</div>`;

  return `<div class="map-popup">${thumb}${lines.join("<br>")}${linkBar}</div>`;
}

function showGlPopup(feature) {
  if (!map) return;
  if (glPopup) glPopup.remove();
  // closeOnClick would auto-dismiss a popup created inside a map click handler;
  // the × button and selecting another event handle closing instead.
  const popup = new mapboxgl.Popup({ offset: 14, maxWidth: "300px", closeOnClick: false })
    .setLngLat(feature.geometry.coordinates)
    .setHTML(detailCardHtml(feature.properties))
    .addTo(map);
  popup.on("close", () => {
    if (glPopup === popup) {
      glPopup = null;
      glPopupId = null;
      updateGlLabelFilter();
    }
  });
  glPopup = popup;
  glPopupId = feature.properties.id;
  updateGlLabelFilter();
}

// The open popup already shows this event in full, so hide its box label.
function updateGlLabelFilter() {
  if (!map || !map.getLayer("event-labels")) return;
  map.setFilter("event-labels", glPopupId ? ["!=", ["get", "id"], glPopupId] : null);
}

function renderEventList(features) {
  const list = document.getElementById("event-list");
  const sorted = [...features].sort(compareEvents);

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

// ---------------------------------------------------------------------------
// Table view (works with or without WebGL)
// ---------------------------------------------------------------------------

const TABLE_COLUMNS = [
  { key: "date", label: "Date", get: (p) => p.date_label, sort: compareEvents },
  {
    key: "time",
    label: "Time",
    get: (p) => eventWhen(p),
    sort: (a, b) => timeToMinutes(a.properties.start_time) - timeToMinutes(b.properties.start_time),
  },
  { key: "name", label: "Event", get: (p) => p.name },
  { key: "category", label: "Category", get: (p) => p.category },
  { key: "venue", label: "Venue", get: (p) => p.venue },
  { key: "city", label: "City", get: (p) => p.city },
  { key: "recurring", label: "Recurring", get: (p) => (p.recurring ? "Yes" : "") },
  { key: "rsvp", label: "RSVP", get: (p) => (p.rsvp ? "Yes" : "") },
];

const tableState = { sortKey: "date", sortDir: 1, category: "all", city: "all", q: "" };

function uniqueSorted(features, field) {
  return [...new Set(features.map((f) => f.properties[field]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function filteredSortedFeatures() {
  const q = tableState.q.trim().toLowerCase();
  let rows = allFeatures.filter((f) => {
    const p = f.properties;
    if (tableState.category !== "all" && p.category !== tableState.category) return false;
    if (tableState.city !== "all" && p.city !== tableState.city) return false;
    if (q) {
      const haystack = `${p.name} ${p.venue} ${p.city} ${p.category}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const col = TABLE_COLUMNS.find((c) => c.key === tableState.sortKey) || TABLE_COLUMNS[0];
  const cmp =
    col.sort ||
    ((a, b) => String(col.get(a.properties)).localeCompare(String(col.get(b.properties))));
  rows.sort((a, b) => cmp(a, b) * tableState.sortDir || compareEvents(a, b));
  return rows;
}

function renderTableBody() {
  const tbody = document.querySelector("#events-table tbody");
  if (!tbody) return;
  const rows = filteredSortedFeatures();

  const countEl = document.getElementById("table-count");
  if (countEl) {
    countEl.textContent = `${rows.length} of ${allFeatures.length} event(s)`;
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="table-empty" colspan="${TABLE_COLUMNS.length + 1}">No events match these filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((f) => {
      const p = f.properties;
      const link = p.event_url
        ? `<a href="${escapeAttr(p.event_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Details &#8599;</a>`
        : p.image_url
        ? `<a href="${escapeAttr(p.image_url)}" data-lightbox="${escapeAttr(p.image_url)}" data-lightbox-alt="${escapeAttr(p.name)} flyer">Flyer &#8599;</a>`
        : "";
      const cells = TABLE_COLUMNS.map(
        (c) => `<td data-col="${c.key}">${escapeHtml(String(c.get(p) ?? ""))}</td>`
      ).join("");
      return `<tr class="table-row" data-id="${escapeAttr(p.id)}" style="--row-color: ${escapeAttr(p.color)}">${cells}<td class="table-link">${link}</td></tr>`;
    })
    .join("");

  tbody.querySelectorAll(".table-row").forEach((row) => {
    row.addEventListener("click", () => selectEvent(row.dataset.id));
  });
  syncActiveRows();
}

function renderTable(features) {
  const container = document.getElementById("event-table-view");
  const categories = uniqueSorted(features, "category");
  const cities = uniqueSorted(features, "city");

  const headerCells = TABLE_COLUMNS.map((c) => {
    const isSort = tableState.sortKey === c.key;
    const arrow = isSort ? (tableState.sortDir === 1 ? " ▲" : " ▼") : "";
    return `<th data-sort="${c.key}" class="${isSort ? "sorted" : ""}" role="button" tabindex="0" aria-sort="${
      isSort ? (tableState.sortDir === 1 ? "ascending" : "descending") : "none"
    }">${escapeHtml(c.label)}${arrow}</th>`;
  }).join("");

  container.innerHTML = `
    <div class="table-toolbar">
      <label>Category
        <select id="filter-category">
          <option value="all">All</option>
          ${categories
            .map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`)
            .join("")}
        </select>
      </label>
      <label>City
        <select id="filter-city">
          <option value="all">All</option>
          ${cities.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")}
        </select>
      </label>
      <label class="table-search">Search
        <input type="search" id="filter-search" placeholder="name, venue, city..." />
      </label>
      <span id="table-count" class="table-count"></span>
    </div>
    <div class="table-scroll">
      <table id="events-table">
        <thead><tr>${headerCells}<th>Link</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  const categorySel = container.querySelector("#filter-category");
  const citySel = container.querySelector("#filter-city");
  const search = container.querySelector("#filter-search");
  categorySel.value = tableState.category;
  citySel.value = tableState.city;
  search.value = tableState.q;

  categorySel.addEventListener("change", () => {
    tableState.category = categorySel.value;
    renderTableBody();
  });
  citySel.addEventListener("change", () => {
    tableState.city = citySel.value;
    renderTableBody();
  });
  search.addEventListener("input", () => {
    tableState.q = search.value;
    renderTableBody();
  });

  container.querySelectorAll("th[data-sort]").forEach((th) => {
    const activate = () => {
      const key = th.dataset.sort;
      if (tableState.sortKey === key) {
        tableState.sortDir *= -1;
      } else {
        tableState.sortKey = key;
        tableState.sortDir = 1;
      }
      renderTable(features); // re-render header arrows + body
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });

  renderTableBody();
}

// ---------------------------------------------------------------------------
// Selection - shared across map, table and sidebar
// ---------------------------------------------------------------------------

let selectedId = null;

function syncActiveRows() {
  document.querySelectorAll(".event-row, .table-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.id === selectedId);
  });
}

function selectEvent(id) {
  const feature = allFeatures.find((f) => f.properties.id === id);
  if (!feature) return;
  selectedId = id;

  if (map) {
    map.getSource("selected-event").setData({ type: "FeatureCollection", features: [feature] });
    map.flyTo({
      center: feature.geometry.coordinates,
      zoom: Math.max(map.getZoom(), 12),
      essential: true,
    });
    if (currentView !== "table") showGlPopup(feature);
  } else if (leaflet && leaflet.map) {
    const [lon, lat] = feature.geometry.coordinates;
    // animate:false - an animated setView can silently no-op if the container
    // was just un-hidden or resized, and an instant recenter is fine here.
    leaflet.map.setView([lat, lon], Math.max(leaflet.map.getZoom(), 13), { animate: false });
    highlightLeafletMarker(id);
    const marker = leaflet.markers.get(id);
    if (marker && currentView !== "table") {
      marker.openPopup();
      leaflet.popupId = id; // set after openPopup: it closes any prior popup first
    }
    updateLeafletLabels();
  }

  syncActiveRows();

  for (const sel of [".event-row", ".table-row"]) {
    scrollRowIntoView(document.querySelector(`${sel}[data-id="${CSS.escape(id)}"]`));
  }
}

// Center a selected row in its own scroll container. Sets scrollTop directly
// rather than scrollIntoView({behavior:"smooth"}), which is silently a no-op in
// some engines / with reduced-motion.
function scrollRowIntoView(row) {
  const scroller = row && row.closest("#event-list, .table-scroll");
  if (!scroller) return;
  const r = row.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (r.top >= s.top && r.bottom <= s.bottom) return; // already fully visible
  scroller.scrollTop += r.top - s.top - (s.height - r.height) / 2;
}

// ---------------------------------------------------------------------------
// Leaflet fallback map (no WebGL)
// ---------------------------------------------------------------------------

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/leaflet/leaflet.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Leaflet"));
    document.head.appendChild(script);
  });
}

function showFallbackNotice() {
  if (document.getElementById("map-static-notice")) return;
  const notice = document.createElement("div");
  notice.id = "map-static-notice";
  notice.textContent =
    "Your browser doesn't support the full interactive map - showing a lightweight version.";
  const split = document.getElementById("split");
  split.parentNode.insertBefore(notice, split);
}

function highlightLeafletMarker(id) {
  if (!leaflet) return;
  leaflet.markers.forEach((marker, markerId) => {
    const selected = markerId === id;
    marker.setStyle(
      selected
        ? { radius: 12, weight: 4, color: "#0f2a43" }
        : { radius: 8, weight: 2, color: "#ffffff" }
    );
    const tip = marker.getTooltip();
    const el = tip && tip.getElement();
    if (el) el.classList.toggle("selected", selected);
  });
}

function labelHtml(p) {
  return (
    `<span class="map-label-name">${escapeHtml(p.name)}${eventBadges(p)}${flyerBadge(p)}</span>` +
    `<span class="map-label-date">${escapeHtml(p.date_label)}</span>`
  );
}

function boxesOverlap(a, b, margin) {
  return !(
    a.right + margin < b.left ||
    a.left - margin > b.right ||
    a.bottom + margin < b.top ||
    a.top - margin > b.bottom
  );
}

// Permanent Leaflet tooltips don't collision-avoid on their own; replicate the
// GL map's behaviour - a label is hidden only if it would overlap one already
// placed. The selected event keeps its label UNLESS its popup is open, since
// the popup already shows the same event in full (we don't want both).
function updateLeafletLabels() {
  if (!leaflet) return;
  const lmap = leaflet.map;
  const size = lmap.getSize();
  const placed = [];

  // Scale the label text with zoom (the CSS only acts on this on small screens).
  const z = lmap.getZoom();
  const labelScale = Math.max(0.72, Math.min(1.15, 0.72 + (z - 9) * 0.07));
  document.getElementById("map").style.setProperty("--label-scale", labelScale.toFixed(3));

  const entries = [...leaflet.markers.entries()].sort((a, b) => {
    if (a[0] === selectedId) return -1;
    if (b[0] === selectedId) return 1;
    return 0;
  });

  for (const [id, marker] of entries) {
    const tip = marker.getTooltip();
    const el = tip && tip.getElement();
    if (!el) continue;
    el.style.borderColor = marker.options.fillColor;

    // The open popup already shows this event in full - don't also show its
    // compact label.
    if (id === leaflet.popupId) {
      el.style.display = "none";
      continue;
    }

    // Measure while laid out but invisible, then place.
    el.style.display = "";
    el.style.visibility = "hidden";
    const w = el.offsetWidth || 100;
    const h = el.offsetHeight || 28;
    const pt = lmap.latLngToContainerPoint(marker.getLatLng());

    if (pt.x < -40 || pt.x > size.x + 40 || pt.y < -40 || pt.y > size.y + 40) {
      el.style.display = "none";
      continue;
    }

    // Try the label to the right, then left, then nudged up/down on each side -
    // so a nearby label pushes this one aside instead of hiding it.
    const gapX = 8;
    const dv = h + 6;
    const candidates = [
      ["right", 0], ["left", 0],
      ["right", -dv], ["left", -dv],
      ["right", dv], ["left", dv],
      ["right", -2 * dv], ["left", 2 * dv],
    ];

    let chosen = null;
    for (const [dir, dy] of candidates) {
      const left = dir === "right" ? pt.x + gapX : pt.x - gapX - w;
      const b = { left, right: left + w, top: pt.y + dy - h / 2, bottom: pt.y + dy + h / 2 };
      if (!placed.some((p) => boxesOverlap(b, p, 3))) {
        chosen = { dir, dy, box: b };
        break;
      }
    }
    if (!chosen && id === selectedId) {
      const b = { left: pt.x + gapX, right: pt.x + gapX + w, top: pt.y - h / 2, bottom: pt.y + h / 2 };
      chosen = { dir: "right", dy: 0, box: b };
    }
    if (!chosen) {
      el.style.display = "none";
      continue;
    }

    tip.options.direction = chosen.dir;
    tip.options.offset = L.point(chosen.dir === "right" ? gapX : -gapX, chosen.dy);
    tip.update(); // re-reads direction/offset and repositions
    el.style.visibility = "";
    placed.push(chosen.box);
  }
}

function renderLeafletMap(features) {
  const mapEl = document.getElementById("map");
  mapEl.classList.add("leaflet-fallback");
  mapEl.innerHTML = "";

  const lmap = L.map(mapEl, { scrollWheelZoom: true }).setView([33.448, -112.074], 9);
  L.tileLayer(RASTER_TILE_URL, {
    tileSize: 512,
    zoomOffset: -1,
    maxZoom: 19,
    attribution: TILE_ATTRIBUTION,
  }).addTo(lmap);

  const markers = new Map();
  const latLngs = [];
  features.forEach((f) => {
    const [lon, lat] = f.geometry.coordinates;
    latLngs.push([lat, lon]);
    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      weight: 2,
      color: "#ffffff",
      fillColor: f.properties.color,
      fillOpacity: 1,
    })
      .bindPopup(detailCardHtml(f.properties))
      .bindTooltip(labelHtml(f.properties), {
        permanent: true,
        direction: "right",
        offset: [10, 0],
        className: "map-label",
        interactive: true,
      })
      .addTo(lmap);
    marker.on("click", () => selectEvent(f.properties.id));
    markers.set(f.properties.id, marker);
  });

  if (latLngs.length) {
    lmap.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40], maxZoom: 14, animate: false });
  }

  lmap.on("zoomend moveend", () => {
    updateDebugPanel();
    updateLeafletLabels();
  });
  // Swap the compact label for the full popup (and back) on the selected pin.
  lmap.on("popupopen", updateLeafletLabels);
  lmap.on("popupclose", () => {
    leaflet.popupId = null;
    updateLeafletLabels();
  });
  leaflet = { map: lmap, markers, popupId: null };

  // Leaflet mis-measures a container that was hidden or is still settling.
  requestAnimationFrame(() => {
    lmap.invalidateSize();
    updateLeafletLabels();
  });
  updateDebugPanel();
}

// ---------------------------------------------------------------------------
// View: map / split / table, with draggable resizers
//   - #split-handle    (horizontal) sizes map pane vs. table pane, split view
//   - #split-handle-v  (vertical)   sizes the map vs. the list, map/split views
// ---------------------------------------------------------------------------

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function refreshMapSize() {
  requestAnimationFrame(() => {
    if (map) map.resize();
    if (leaflet && leaflet.map) {
      leaflet.map.invalidateSize();
      updateLeafletLabels();
    }
  });
}

function setView(view) {
  currentView = view;
  document.getElementById("split").dataset.view = view;

  document.querySelectorAll(".view-toggle button").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  try {
    localStorage.setItem("events-view", view);
  } catch (e) {
    /* private mode / storage disabled - ignore */
  }

  if (view === "table" && glPopup) glPopup.remove();

  refreshMapSize();
  updateDebugPanel();
}

// Wire a splitter handle: dragging it (mouse/touch) or arrowing it (when
// focused) writes a 0..1 fraction into `cssVar` on `target`, which the CSS
// turns into flex ratios for the two panes.
function initResizer({ handleId, target, axis, cssVar, storeKey }) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  let ratio = parseFloat(getComputedStyle(target).getPropertyValue(cssVar)) || 0.6;
  try {
    const stored = parseFloat(localStorage.getItem(storeKey));
    if (Number.isFinite(stored)) ratio = stored;
  } catch (e) {
    /* ignore */
  }

  const apply = (r, persist) => {
    ratio = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r));
    target.style.setProperty(cssVar, ratio);
    if (persist) {
      try {
        localStorage.setItem(storeKey, ratio.toFixed(3));
      } catch (e) {
        /* ignore */
      }
    }
  };
  apply(ratio, false);

  let dragging = false;
  let rafPending = false;
  const pointerPos = (e) => {
    const t = e.touches && e.touches[0];
    return axis === "x" ? (t ? t.clientX : e.clientX) : t ? t.clientY : e.clientY;
  };
  const applyFromEvent = (e) => {
    const rect = target.getBoundingClientRect();
    const frac =
      axis === "x"
        ? (pointerPos(e) - rect.left) / rect.width
        : (pointerPos(e) - rect.top) / rect.height;
    apply(frac, false);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (map) map.resize();
        if (leaflet && leaflet.map) leaflet.map.invalidateSize();
      });
    }
  };

  const onMove = (e) => {
    if (!dragging) return;
    applyFromEvent(e);
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onUp);
    apply(ratio, true);
    if (leaflet && leaflet.map) updateLeafletLabels();
  };
  const onDown = (e) => {
    dragging = true;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    e.preventDefault();
  };

  handle.addEventListener("mousedown", onDown);
  handle.addEventListener("touchstart", onDown, { passive: false });
  handle.addEventListener("keydown", (e) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
    const step = e.key === back ? -0.03 : e.key === fwd ? 0.03 : 0;
    if (!step) return;
    e.preventDefault();
    apply(ratio + step, true);
    refreshMapSize();
  });
}

function initSplitHandles() {
  initResizer({
    handleId: "split-handle",
    target: document.getElementById("split"),
    axis: "y",
    cssVar: "--split",
    storeKey: "events-split-ratio",
  });
  initResizer({
    handleId: "split-handle-v",
    target: document.querySelector(".layout"),
    axis: "x",
    cssVar: "--split-x",
    storeKey: "events-split-x-ratio",
  });
}

// The events table (and therefore split/table views) is desktop-only.
const mobileMedia = window.matchMedia("(max-width: 768px)");

function initViewToggle() {
  document.querySelectorAll(".view-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  initSplitHandles();

  if (!mobileMedia.matches) {
    let stored = null;
    try {
      stored = localStorage.getItem("events-view");
    } catch (e) {
      /* ignore */
    }
    if (stored === "table" || stored === "split") setView(stored);
  }

  // Collapse to the map + days table if the viewport crosses into mobile.
  mobileMedia.addEventListener("change", (e) => {
    if (e.matches && currentView !== "map") setView("map");
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function loadEvents() {
  // Cache-bust: GitHub Pages serves this with a 10-min max-age, and the data
  // changes weekly, so without this a browser can show last week's events.
  return fetch(`data/events.geojson?t=${Date.now()}`).then((res) => res.json());
}

function onEventsLoaded(geojson) {
  allFeatures = geojson.features;
  document.getElementById("week-summary").textContent =
    `${geojson.features.length} event(s) this week`;
  renderEventList(geojson.features);
  renderTable(geojson.features);
  initViewToggle();
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
      map.addSource("events", { type: "geojson", data: geojson });

      const weekdayColors = {};
      for (const f of geojson.features) weekdayColors[f.properties.weekday] = f.properties.color;
      for (const [weekday, color] of Object.entries(weekdayColors)) {
        const imgId = `label-bg-${weekday}`;
        if (!map.hasImage(imgId)) {
          const bg = makeLabelBg(color);
          map.addImage(imgId, bg.data, bg.options);
        }
      }

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
          "icon-image": ["concat", "label-bg-", ["get", "weekday"]],
          "icon-text-fit": "both",
          "icon-text-fit-padding": [2, 5, 2, 5],
          "icon-allow-overlap": false,
          "text-field": [
            "concat",
            ["get", "name"],
            "\n",
            ["get", "date_label"],
            ["case", ["get", "rsvp"], "  ·  RSVP", ""],
            ["case", ["get", "has_image"], "  ·  FLYER", ""],
          ],
          // Small when zoomed out, only modestly larger up close.
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 7.5, 11, 10, 14, 13, 17, 17],
          // Let crowded labels flip to a free side instead of one being dropped.
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 1.4,
          "text-justify": "auto",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#0f2a43",
          "text-halo-color": "rgba(255, 255, 255, 0.95)",
          "text-halo-width": 1,
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

      onEventsLoaded(geojson);
    });
  });
} else {
  showFallbackNotice();
  Promise.all([loadEvents(), loadLeaflet()])
    .then(([geojson]) => {
      renderLeafletMap(geojson.features);
      onEventsLoaded(geojson);
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("map").textContent =
        "The map could not be loaded. Switch to the Table view to see this week's events.";
    });
}
