/* LANShare service worker.
 *
 * Two jobs: keep the app shell available so a launch from the home screen is
 * instant, and cache thumbnails so scrolling a large album a second time
 * costs nothing. Everything else always goes to the network — a photo
 * library is only useful when it reflects what is actually on the server.
 */

// Bump whenever the shell changes, or an installed PWA keeps serving the old
// index.html and app.js out of its own cache.
const VERSION = 'v2';
const SHELL_CACHE = `lanshare-shell-${VERSION}`;
const THUMB_CACHE = `lanshare-thumbs-${VERSION}`;
const MAX_THUMBS = 600;

const SHELL_ASSETS = [
  '/',
  '/assets/style.css',
  '/assets/app.js',
  '/assets/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing asset must not fail the whole install.
    await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, THUMB_CACHE]);
    for (const name of await caches.keys()) {
      if (!keep.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/** Keep the thumbnail cache from growing without bound. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  for (const key of keys.slice(0, keys.length - maxEntries)) {
    await cache.delete(key);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Thumbnails are immutable — their URL carries the file's mtime — so a
  // cache hit is always the right answer.
  if (url.pathname === '/api/thumb') {
    event.respondWith((async () => {
      const cache = await caches.open(THUMB_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
        trimCache(THUMB_CACHE, MAX_THUMBS);
      }
      return response;
    })());
    return;
  }

  // Never cache the rest of the API, media bytes, or the login exchange:
  // stale listings and stale sessions are both worse than a network trip.
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return;

  // App shell: network first, falling back to cache when offline, so an
  // update is picked up as soon as the server is reachable.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && (request.mode === 'navigate' || url.pathname.startsWith('/assets/'))) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw new Error('Offline and not cached');
    }
  })());
});
