/* snip.fm service worker — offline shell + runtime caching.
   Bump CACHE when the shell changes so clients pick up the new build. */
const CACHE = 'snipfm-v4';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];
const ART_CACHE = 'snipfm-art-v4';
const ART_MAX = 160;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache entries one by one: one 404 must not break the install.
    await Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== ART_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

/* Network first, fall back to the cached copy (shell for navigations). */
async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (fallback) {
      const shell = await cache.match(fallback);
      if (shell) return shell;
    }
    throw err;
  }
}

/* Serve from cache, refresh in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  let hit = await cache.match(request);
  /* An opaque (no-cors) copy is unreadable, so handing it to a CORS request
     would taint the album-art canvas and break colour sampling. Never reuse it. */
  const wantsCors = request.mode !== 'no-cors';
  if (hit && wantsCors && hit.type === 'opaque') hit = undefined;
  const network = fetch(request).then(res => {
    const storable = res && res.ok && !(res.type === 'opaque' && wantsCors);
    if (storable) cache.put(request, res.clone()).then(() => trim(cacheName, ART_MAX)).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await network) || new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept audio: previews use range requests and must stream live.
  if (req.destination === 'audio' || req.headers.has('range')) return;

  // JSONP fallbacks embed a unique callback name in the URL, so caching them
  // would both miss every time and slowly flood the cache.
  if (url.searchParams.has('callback')) return;

  // Navigations: fresh HTML when online, cached shell when not.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, './index.html'));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, CACHE));
    return;
  }

  if (url.hostname === 'cdn.tailwindcss.com' || url.hostname.endsWith('mzstatic.com') || url.hostname.endsWith('dzcdn.net')) {
    event.respondWith(staleWhileRevalidate(req, ART_CACHE));
    return;
  }

  // iTunes search / lyrics: try the network, keep a copy for offline.
  if (url.hostname === 'itunes.apple.com' || url.hostname === 'api.deezer.com' || url.hostname === 'api.lyrics.ovh') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).then(() => trim(CACHE, 120)).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
    })());
  }
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
