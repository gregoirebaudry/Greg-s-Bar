const CACHE_NAME = 'gregs-bar-admin-v1';
const APP_SHELL = ['./admin.html','./manifest.webmanifest','./ping_double.wav','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => { if (event.request.method !== 'GET') return; event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); });
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (error) { payload = {}; }
  event.waitUntil(self.registration.showNotification(payload.title || 'New cocktail order', {
    body: payload.body || 'A new cocktail order just arrived.',
    tag: payload.tag || 'bar-order',
    renotify: true,
    requireInteraction: true,
    badge: payload.badge || './icons/icon-192.png',
    icon: payload.icon || './icons/icon-512.png',
    data: { url: payload.url || './admin.html' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './admin.html';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    for (const client of clientList) {
      if ('focus' in client) {
        client.navigate(targetUrl).catch(() => {});
        return client.focus();
      }
    }
    return clients.openWindow ? clients.openWindow(targetUrl) : undefined;
  }));
});
