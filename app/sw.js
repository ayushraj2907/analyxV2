// Offline support. The build stamps BUILD with the data build time, so every
// nightly update installs a fresh cache automatically.
const BUILD = '__BUILD__';
const CACHE = 'analyx-' + BUILD;
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/i18n.js', 'js/recommend.js', 'js/parse.js', 'js/speech.js', 'js/chart.js', 'js/explain.js',
  'i18n/en.json', 'i18n/hi.json', 'icons/icon-192.png', 'icons/icon-512.png',
  'config/profile_rules.json', 'config/app_defaults.json', 'config/scoring.json',
  'data/meta.json', 'data/funds.json', 'data/benchmarks.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('analyx-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isData = url.origin === location.origin && /\/(data|config|i18n)\//.test(url.pathname);
  if (isData) {
    // network first, so numbers are always the latest; cached copy when offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // app shell & fonts: cache first, refresh in background
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
