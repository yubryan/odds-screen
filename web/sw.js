// Service worker: makes the app installable and usable offline. App files are
// fetched from the network first (revalidated, so a new deploy shows up on the
// next load) and fall back to the cached copy only when offline. Odds API
// calls, ESPN images and fonts are left to the browser.
const CACHE = "oddscreen-v2";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/style.css", "data/media.json",
  "js/app.js", "js/router.js",
  "js/engine/config.js", "js/engine/ev.js", "js/engine/fair.js", "js/engine/media.js", "js/engine/middles.js",
  "js/engine/models.js", "js/engine/mvn.js", "js/engine/odds_math.js", "js/engine/oddsapi.js", "js/engine/parlay.js",
  "js/engine/screen.js", "js/engine/service.js", "js/engine/store.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // "no-cache" revalidates with the server (cheap 304 when unchanged) instead of trusting the HTTP cache
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
