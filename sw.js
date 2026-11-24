// Cache simples para o app abrir mesmo sem internet.
const CACHE = 'mimimei-v15';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/parsers.js', 'js/qr.js', 'js/cloud.js', 'js/account.js', 'js/firebase-config.js', 'vendor/firebase/firebase.js', 'vendor/zxing/share.js', 'vendor/zxing/reader/index.js', 'vendor/zxing/zxing_reader.wasm', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  // cache: 'reload' garante que a cópia offline é a versão recém-publicada, não uma antiga do navegador
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// rede primeiro, sempre conferindo com o servidor (cache: 'no-cache'), para nunca
// misturar arquivos de versões diferentes; a cópia guardada só é usada sem internet
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
