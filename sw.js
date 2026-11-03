// Offline shell for the A4 Bus Survey PWA.
// Bump CACHE_NAME whenever app files change so devices pick up the update.
const CACHE_NAME = 'a4-bus-survey-v2';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './config.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/favicon-32.png',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const req = event.request;
    // Never cache data sync or the shared route list.
    if (req.method !== 'GET' || req.url.includes('script.google.com') || req.url.includes('googleusercontent.com')) return;
    // Network first so updates arrive when online; cache when offline.
    event.respondWith(
        fetch(req)
            .then(res => {
                if (res && (res.ok || res.type === 'opaque')) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
});
