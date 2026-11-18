// Cache simples para o app abrir mesmo sem internet.
const CACHE = 'mimimei-v6';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/parsers.js', 'js/qr.js', 'js/cloud.js', 'js/account.js', 'js/firebase-config.js', 'vendor/firebase/firebase.js', 'vendor/zxing/share.js', 'vendor/zxing/reader/index.js', 'vendor/zxing/zxing_reader.wasm', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// rede primeiro (pega atualizações), cache como reserva
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
