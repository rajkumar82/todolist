// Makes the app installable and lets it open without a connection.
//   pages + assets: network first, cached copy when offline
//   api reads:      network first, last answer when offline (so lists stay readable)
//   api writes:     never touched, they simply fail offline and the app shows a message
const CACHE = 'todo-v2';
const SHELL = ['/', '/style.css', '/app.js', '/icon-192.png', '/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // any /<name> page is the same shell; fall back to whichever page was cached last
        if (req.mode === 'navigate') return (await caches.match('/')) || Response.error();
        return Response.error();
      }),
  );
});
