/* Weekly cache name: bump this whenever MAP_VERSION changes
   (js/config.js, version.txt, and the ?v= params in index.html). */
const CACHE_NAME = "al-events-2026-11-22-1";

const PRECACHE = [
  "/",
  "/index.html",
  "/css/styles.css?v=2026-11-22-1",
  "/js/config.js?v=2026-11-22-1",
  "/js/map.js?v=2026-11-22-1",
  "/manifest.webmanifest",
  "/version.txt",
  "/data/events.geojson",
  "/images/icons/icon-192.png",
  "/images/icons/icon-512.png",
  "/images/icons/apple-touch-icon.png",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Strip cache-busting query params (?t= Date.now(), etc.) so the cache
// does not grow a new entry on every load. Keep ?v= keys as-is — those
// change with the weekly version and match the precache URLs.
function cacheKey(request) {
  const url = new URL(request.url);
  if (url.searchParams.has("t") && !url.searchParams.has("v")) {
    url.search = "";
    return new Request(url.href, {
      method: request.method,
      headers: request.headers,
      mode: request.mode === "navigate" ? "same-origin" : request.mode,
      credentials: request.credentials,
      cache: request.cache
    });
  }
  return request;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(request);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(key, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached =
      (await cache.match(key)) ||
      (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    if (request.mode === "navigate") {
      const fallback = (await cache.match("/index.html")) || (await cache.match("/"));
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
