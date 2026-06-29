// エイポン Service Worker — オフライン対応（アプリの殻をキャッシュ）
const CACHE = 'eipon-v3';
const ASSETS = [
  './', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 重要: Supabase（認証・DBのAPI）は絶対にキャッシュしない。
  // ここをキャッシュすると古いデータが返り、保存が反映されないように見える。
  let host = '';
  try { host = new URL(req.url).hostname; } catch (_) {}
  if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return;

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accept.includes('text/html');

  if (isHTML) {
    // HTMLは「最新優先」。取れなければキャッシュにフォールバック（オフライン）。
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // それ以外（アイコン・フォント・ライブラリ等の静的アセット）は「キャッシュ優先」。
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => { try { c.put(req, copy); } catch (_) {} });
      return res;
    }).catch(() => hit))
  );
});
