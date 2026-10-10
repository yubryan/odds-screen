// Service worker: makes the app installable and instant. App files are served
// from cache and refreshed in the background (stale-while-revalidate), so a new
// deploy shows up on the next launch. Odds API calls always go to the network.
const CACHE = "oddscreen-v1";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/style.css", "data/media.json",
  "js/app.js", "js/router.js",
  "js/engine/config.js", "js/engine/ev.js", "js/engine/fair.js", "js/engine/media.js", "js/engine/middles.js",
  "js/engine/models.js", "js/engine/mvn.js", "js/engine/odds_math.js", "js/engine/oddsapi.js", "js/engine/parlay.js",
  "js/engine/screen.js", "js/engine/service.js", "js/engine/store.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // odds API, ESPN images, fonts: network as usual
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
