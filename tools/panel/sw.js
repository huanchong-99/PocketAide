/* 任务面板 Service Worker —— 让托盘没开时也能查看任务。
 *
 * 【离线在这里到底解决什么】面板服务是随托盘起的。托盘没开 / 服务没起时，PWA 图标点开
 * 本来就是白屏——这正是 PWA 在本项目唯一真正的价值：把上一次看到的任务留在本地，
 * 断开时仍然能查。所以策略是：
 *   - app shell（HTML/图标/manifest）：缓存优先，保证秒开、也保证服务挂了还能渲染
 *   - /api/state：网络优先，成功就顺手存一份快照；失败就回放快照，并打上 offline 标记
 *   - 写操作（除 state/detail 外的 /api/*）：绝不缓存、绝不重放。
 *     离线时排队补写看着贴心，实则危险——你在飞书那头可能已经改过同一个任务，
 *     等服务回来再把旧指令灌进去就是静默覆盖。宁可直接失败，让页面告诉你"离线，改不了"。
 */

// 改版式/配色后必须改这个号：shell 是缓存优先的，不换 key 的话老页面会一直被端出来。
// 副作用是快照也跟着清掉（旧 cache 整个删），下次联机打开会重新存，可接受。
const VER = 'panel-v2';
const SHELL = ['/', '/icon.svg', '/manifest.webmanifest'];
const DATA_KEY = '/__snapshot__/state';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/state') { e.respondWith(stateFirstNetwork(req)); return; }

  // 其余 /api/*：只走网络。失败就如实报错，不做任何离线兜底。
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ ok: false, error: '离线：面板服务没在运行，此操作需要联机（从托盘启动面板后重试）' }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }
      ))
    );
    return;
  }

  // app shell：缓存优先
  if (req.method === 'GET') {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit || fetch(req).then((r) => {
          if (r.ok) { const cp = r.clone(); caches.open(VER).then((c) => c.put(req, cp)); }
          return r;
        }).catch(() => caches.match('/', { ignoreSearch: true }))
      )
    );
  }
});

/** 网络优先 + 快照兜底。回放时给数据打 offline 标记，页面据此变成只读并显示提示。 */
async function stateFirstNetwork(req) {
  try {
    const r = await fetch(req);
    const body = await r.clone().json().catch(() => null);
    if (body && body.ok) {
      const c = await caches.open(VER);
      await c.put(DATA_KEY, new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));
    }
    return r;
  } catch (_) {
    const c = await caches.open(VER);
    const hit = await c.match(DATA_KEY);
    if (hit) {
      const body = await hit.json();
      if (body && body.data) { body.data.offline = true; body.data.snapshotAt = body.data.meta && body.data.meta.serverTime; }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    return new Response(
      JSON.stringify({ ok: false, error: '离线，且本地还没有任何缓存快照——先联机打开一次面板。' }),
      { headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
}
