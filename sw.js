/*
 * Offline support: the app shell is cached so the tracker opens without a
 * connection. Same-origin files use stale-while-revalidate (instant load,
 * updated in the background); price/sync API calls always go to the network.
 */
const CACHE = 'investment-tracker-v3';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/portfolio.js', 'js/prices.js', 'js/sync.js', 'js/charts.js', 'js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Fonts: cache-first, so the retro look survives offline.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
