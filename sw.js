/* 구독달력 서비스 워커: 앱 파일을 미리 저장해 두고(캐시 우선) 오프라인에서도 열리게 한다.
 * 앱 파일을 바꿔 배포할 때마다 CACHE 버전을 올려야 휴대폰에 새 파일이 들어간다. */
const CACHE = 'subcal-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/xlsx.full.min.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — 브라우저 HTTP 캐시에 남은 옛 파일 말고 서버의 새 파일을 받는다(GitHub Pages는 짧게 캐시한다)
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // ?demo=1 같은 주소 뒤 값은 무시하고 같은 파일로 찾는다
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
