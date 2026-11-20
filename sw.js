/* Service worker：讓網頁可以離線開啟、安裝成 App，並處理系統通知的點擊。
 * 自己的檔案：有網路時一律抓最新的（更新馬上生效），沒網路才用上次存下來的。
 * Firebase 程式庫：網址帶版本號、內容不會變，存過就直接用。 */
const SHELL_CACHE = 'pomodoro-shell-v1';
const LIB_CACHE = 'pomodoro-libs-v1';
const SHELL_FILES = [
    './', 'index.html', 'style.css', 'script.js', 'sync.js', 'firebase-config.js',
    'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.startsWith('pomodoro-') && k !== SHELL_CACHE && k !== LIB_CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(SHELL_CACHE);
    // 一律向伺服器確認有沒有新版（cache: 'no-cache'），不用瀏覽器暫存的舊檔：
    // GitHub Pages 讓每個檔案暫存 10 分鐘，剛更新時可能拿到新的頁面配上舊的程式，新功能就會不正常
    const fresh = request.mode === 'navigate' ? fetch(request.url, { cache: 'no-cache' }) : fetch(request, { cache: 'no-cache' });
    const fromNetwork = fresh.then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    });
    const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS));
    try {
        return await Promise.race([fromNetwork, timeout]);
    } catch (err) {
        fromNetwork.catch(() => {}); // 逾時後網路那邊才失敗的話，不要變成未處理的錯誤
        const cached = await cache.match(request, { ignoreSearch: true })
            || (request.mode === 'navigate' ? await cache.match('index.html') : null);
        return cached || fromNetwork;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(LIB_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
    else if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) event.respondWith(cacheFirst(request));
    // 其他（登入、資料庫連線）不處理，照常走網路
});

// 點了通知：把蕃茄鐘叫到前面。同時開著好幾個的話，優先選「安裝成 App」開的那個
// （它的網址帶有 ?app=1），其次是目前看得到的，最後才是其他分頁；都沒有才開新的。
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const tag = event.notification.tag;
    event.waitUntil((async () => {
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const score = c => (c.url.includes('app=1') ? 4 : 0) + (c.focused ? 2 : 0) + (c.visibilityState === 'visible' ? 1 : 0);
        list.sort((a, b) => score(b) - score(a));
        for (const client of list) {
            try {
                client.postMessage({ type: 'notification-click', tag });
                await client.focus();
                return;
            } catch (err) { /* 這個叫不到前面，試下一個 */ }
        }
        await self.clients.openWindow(tag === 'pomodoro-expense' ? './?app=1&do=expense' : './?app=1');
    })());
});
