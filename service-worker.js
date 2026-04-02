const CACHE_NAME = 'gregs-bar-v2';
const APP_ASSETS = [
  './',
  './index.html',
  './admin.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isNavigation = request.mode === 'navigate';
  const sameOrigin = url.origin === self.location.origin;

  if (isNavigation && sameOrigin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (error) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(request)) || (await cache.match('./index.html'));
      }
    })());
    return;
  }

  if (sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.status === 200 && request.url.startsWith(self.location.origin)) {
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        return cached || Response.error();
      }
    })());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: 'New cocktail order', body: 'You have a new order waiting.' };
  }

  const title = data.title || 'New cocktail order';
  const options = {
    body: data.body || 'You have a new order waiting.',
    icon: data.icon || './icon-512.png',
    badge: data.badge || './icon-192.png',
    data: {
      url: data.url || './admin.html'
    },
    tag: data.tag || 'bar-order',
    renotify: true,
    requireInteraction: false
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './admin.html';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      const clientUrl = new URL(client.url);
      const expected = new URL(targetUrl, self.location.origin);
      if (clientUrl.pathname === expected.pathname && 'focus' in client) {
        await client.focus();
        return;
      }
    }
    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const registration = await self.registration.pushManager.getSubscription();
    if (!registration) return;
    try {
      await fetch('./api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: registration.toJSON() })
      });
    } catch (error) {
      // Best effort only.
    }
  })());
});
