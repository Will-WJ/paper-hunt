// Service Worker：应用外壳离线可用
// 数据请求（bioRxiv / Europe PMC）走页面层的 IndexedDB 缓存，不在这里拦

const VERSION = 'v1.0.6';
const CACHE = `ph-${VERSION}`;

// 关键：预缓存时给每个资源加上版本号查询串。
// GitHub Pages 的 CDN 对同名文件有 10 分钟缓存，如果发版瞬间 CDN 还是旧内容，
// 新装的 SW 会把旧文件锁死在缓存里。加上 ?v=版本号 后，每次发版都是全新 URL，
// CDN 必然回源，就不会再出现"发了新版但用户一直看到旧版"。
const BASE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './js/config.js',
  './js/utils.js',
  './js/store.js',
  './js/api.js',
  './js/match.js',
  './manifest.webmanifest',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

const versioned = (p) => (p === './' ? p : `${p}?v=${VERSION}`);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(BASE.map(versioned)))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 接口请求交给页面层

  // 页面导航：优先网络，断网时回落到缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('./index.html', { ignoreSearch: true }).then((hit) => hit || caches.match('./'))
        )
    );
    return;
  }

  // 静态资源：先给缓存（忽略版本号查询串），同时后台更新
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
