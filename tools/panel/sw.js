/* 任务面板 Service Worker —— 让托盘没开时也能查看任务。
 *
 * 【离线在这里到底解决什么】面板服务是随托盘起的。托盘没开 / 服务没起时，PWA 图标点开
 * 本来就是白屏——这正是 PWA 在本项目唯一真正的价值：把上一次看到的任务留在本地，
 * 断开时仍然能查。所以策略是：
 *   - 一切都**网络优先、缓存兜底**（见下），成功的响应顺手存一份
 *   - /api/state 额外把数据快照单独存一份；回放时打 offline 标记，页面据此转只读
 *   - 写操作（除 state/detail 外的 /api/*）：绝不缓存、绝不重放。
 *     离线时排队补写看着贴心，实则危险——你在飞书那头可能已经改过同一个任务，
 *     等服务回来再把旧指令灌进去就是静默覆盖。宁可直接失败，让页面告诉你"离线，改不了"。
 *
 * 【为什么 shell 不用缓存优先】真踩过：改完 panel.html 刷新，页面纹丝不动——SW 把上一版
 * 从缓存里端了出来，得记着改 VER 才会更新。更糟的是带 `?t=` 进来时，缓存优先直接返回了
 * 缓存页，服务端那个"种 cookie 然后 302 到干净 /"的重定向根本没机会发生，token 就留在
 * 地址栏和浏览器历史里了。
 * 服务在 127.0.0.1 上，网络优先的代价是亚毫秒级的一跳，换来"改了就能看到"和重定向正常
 * 工作，完全值。缓存退回本来的位置：只在服务真的连不上时兜底。
 */

// 缓存 key。shell 改成网络优先之后，改版式已经不需要动这个号了（联机时永远拿最新的）；
// 只有缓存结构本身变了才需要换，换一次会连带清掉数据快照。
const VER = 'panel-v3';
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

  // app shell：网络优先，失败才回缓存（理由见文件头）
  if (req.method === 'GET') e.respondWith(shellNetworkFirst(req));
});

async function shellNetworkFirst(req) {
  try {
    const r = await fetch(req);
    // 只缓存正常的 200。重定向/403 存进去会把"未授权"这种临时状态固化成离线时的样子。
    if (r.ok && r.status === 200 && r.type !== 'opaqueredirect') {
      const cp = r.clone();
      caches.open(VER).then((c) => c.put(new Request(new URL(req.url).pathname), cp)).catch(() => {});
    }
    return r;
  } catch (_) {
    const c = await caches.open(VER);
    const hit = (await c.match(req, { ignoreSearch: true })) || (await c.match('/', { ignoreSearch: true }));
    if (hit) return hit;
    return new Response('离线，且本地还没有缓存过这个页面——先联机打开一次面板。',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

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
