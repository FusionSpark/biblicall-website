// BibliCall service worker: lets BibliCall be installed to the home screen and show the reminders people ask for.
// It does not cache anything: every request goes to the network as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'BibliCall', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        try { await w.focus(); if ('navigate' in w) await w.navigate(url); return; } catch (err) {}
      }
    }
    await self.clients.openWindow(url);
  })());
});
