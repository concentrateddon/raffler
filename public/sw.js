// Bump CACHE on every deploy so installed copies pick up the new files.
const CACHE = 'raffler-v1';

const INDEX = './';
const ASSETS = [
  INDEX,
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

// Cloudflare redirects (e.g. /index.html -> /). Safari refuses to serve a
// redirected response to a navigation, so rebuild it without redirect metadata.
function clean(response) {
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        ASSETS.map(async (url) => {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (!res.ok) throw new Error(`Precache failed: ${url} (${res.status})`);
          await cache.put(url, clean(res));
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cachedResponse =
          (await caches.match(request, { ignoreSearch: true })) || (await caches.match(INDEX));
        if (cachedResponse) {
          // Safari security check fix: strip redirect metadata
          if (cachedResponse.redirected) {
            return new Response(cachedResponse.body, {
              status: cachedResponse.status,
              statusText: cachedResponse.statusText,
              headers: cachedResponse.headers,
            });
          }
          return cachedResponse;
        }
        return await fetch(request);
      })()
    );
    return;
  }

  // Sub-resources (css, js, icons, manifest): cache first, same origin only.
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      return cached || fetch(request);
    })()
  );
});
