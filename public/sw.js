const CACHE_NAME = 'hcac-oft-v2';
const appRoot = new URL('./', self.registration.scope);
const appIndex = appRoot.href;
const coreAssets = [
  appIndex,
  new URL('manifest.webmanifest', appRoot).href,
  new URL('icons/icon.svg', appRoot).href,
  new URL('icons/icon-180.png', appRoot).href,
  new URL('icons/icon-192.png', appRoot).href,
  new URL('icons/icon-512.png', appRoot).href,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(coreAssets))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith('hcac-oft-') && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== 'GET' || requestUrl.origin !== appRoot.origin || !requestUrl.pathname.startsWith(appRoot.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(appIndex, response.clone());
          }
          return response;
        })
        .catch(async () => (await caches.match(appIndex)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;

      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
