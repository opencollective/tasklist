'use strict';
// App-shell cache: serve the page instantly (and offline), refresh it in the
// background. Relay/blossom traffic is cross-origin and passes straight through.
const CACHE = 'tasklist-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];
self.addEventListener('install', (e) => {
e.waitUntil(caches.open(CACHE)
.then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {}))))
.then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
e.waitUntil(caches.keys()
.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
.then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
const req = e.request;
if (req.method !== 'GET') return;
if (new URL(req.url).origin !== location.origin) return;
const key = req.mode === 'navigate' ? './' : req;
e.respondWith(caches.match(key).then((hit) => {
const refresh = fetch(req).then((res) => {
if (res && res.ok) {
const copy = res.clone();
caches.open(CACHE).then((c) => c.put(key, copy));
}
return res;
}).catch(() => hit);
return hit || refresh;
}));
});
