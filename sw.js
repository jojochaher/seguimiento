/* Cache del cascarón de la app para que abra sin conexión. La versión cambia en cada deploy. */
const V = 'seg-2026.11.11-0034';
const SHELL = ['./', './index.html', './store.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  /* red primero (para que los cambios lleguen), cache si no hay red */
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

/* notificaciones push (devoluciones de Claude) */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Devolución lista', { body: d.body || '', icon: './icon-192.png', badge: './icon-192.png', tag: 'devolucion', data: { url: d.url || './?claude=1' } });
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); cs.forEach(c => c.postMessage({ tipo: 'devolucion' }));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './?claude=1', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { const c = cs[0]; if (c) { c.postMessage({ tipo: 'devolucion' }); return c.focus().then(() => c.navigate ? c.navigate(url) : null); } return self.clients.openWindow(url); }));
});
