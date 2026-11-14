/* 離線快取：讓 App 可以安裝，沒網路時也打得開。
   自己網站的檔案「先上網拿最新的」，拿不到才用快取，所以你更新 GitHub 後，使用者下次打開就是新版。
   three.js、Firebase 程式庫這些外部檔案版本固定，用快取就好。 */
const CACHE = 'arpet-v4';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'js/config.js', 'js/catalog.js', 'js/sounds.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'privacy.html', 'delete-account.html'];
const LIBS = ['cdn.jsdelivr.net', 'www.gstatic.com'];   // www.gstatic.com：Firebase 程式庫、Draco 解碼器

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {            // 自己的檔案：先網路，失敗才用快取
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (LIBS.includes(url.hostname)) {        // 版本固定的程式庫：先快取
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
  // 其他（Firebase 登入、資料庫連線）一律不快取
});
