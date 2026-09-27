/*
 * Offline support. When online, the app always loads the latest files from
 * the server (falling back to the saved copy if the network is slow or down);
 * when offline, it runs from the saved copy. Price and sync API calls are
 * never cached.
 */
importScripts('js/version.js');
const CACHE = 'investment-tracker-' + self.APP_VERSION;
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/version.js', 'js/portfolio.js', 'js/prices.js', 'js/sync.js', 'js/charts.js', 'js/app.js',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache, so an old copy can't be saved as the new version.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

async function fromNetwork(request, cache) {
  const res = await fetch(request, { cache: 'no-cache' });
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function fromCache(request, cache) {
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') return cache.match('index.html');
  return undefined;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Fonts never change: cache-first, so the retro look survives offline.
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
  // App files: network first, so updates show straight away.
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const network = fromNetwork(event.request, cache);
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
      // Slow network: use the saved copy now; the download still updates the cache.
      return (await fromCache(event.request, cache)) || (await network);
    } catch {
      return (await fromCache(event.request, cache)) || Response.error();
    }
  }));
});
