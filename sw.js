// Minimal service worker so Biblicall can be installed to the home screen.
// It does not cache anything: every request goes to the network as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
