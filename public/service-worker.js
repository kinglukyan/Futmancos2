const CACHE_NAME = 'futmancos-shell-v25';
const APP_SHELL = ['/', '/offline.html', '/manifest.webmanifest', '/assets/app-icon-192.png', '/assets/app-icon-512.png', '/assets/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch (error) { console.warn('PWA precache skipped:', path, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('futmancos-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('push', event => {
  let notification = {};
  try { notification = event.data?.json() || {}; } catch { notification = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(notification.title || 'Futmancos', {
    body: notification.body || 'Há uma atualização da associação.',
    icon: '/assets/app-icon-192.png', badge: '/assets/app-icon-192.png',
    data: { url: notification.url || '/' },
    tag: notification.tag || notification.title || 'futmancos',
    renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus().then(() => existing.navigate(target)) : self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/', response.clone());
        }
        return response;
      } catch (error) {
        return (await caches.match(request)) || (await caches.match('/offline.html')) || (await caches.match('/'));
      }
    })());
  }
});

