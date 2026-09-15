#!/usr/bin/env node
'use strict';
/**
 * 任务面板的本地 Web 服务。
 *
 * 【和供应商切换页的安全取舍为什么不一样】那个页面能读写明文 API Key，所以做成
 * 随机端口 + 一次性 token + 无心跳就自杀。这个页面装的是你的待办事项——敏感度低一档，
 * 而且**要支持 PWA 安装和离线**（已批准），那就必须有稳定地址：端口随机、进程自杀，
 * 装出来的图标点开就是白屏。所以这里换一套：
 *   - 固定端口（PWA 的 start_url 要稳定）
 *   - 持久 token，存 .token 文件（已 gitignore），首次带 URL 访问后种进 cookie
 *   - 仍然**只绑 127.0.0.1**，外网与局域网一律碰不到
 *   - 不自杀，随托盘同生命周期
 *
 * 【离线怎么办】服务没起的时候，Service Worker 拿缓存的页面 + 上次的数据快照顶上，
 * 明确标成「离线」且只读。这正是 PWA 在这儿唯一真正的价值：托盘没开也能查看任务。
 *
 * 【写操作都会通知飞书】每次改动都记一条事件（tools/panel/events.js），桥接攒一攒
 * 注入给 claude，让它在飞书回你一句确认。电脑上的动作不会只停在电脑上。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./tasks');
const EV = require('./events');

const DIR = __dirname;
const PORT = Number(process.env.PANEL_PORT || 8787);
const TOKEN_FILE = path.join(DIR, '.token');
const TOKEN = loadOrCreateToken();

/** 持久 token：PWA 装好后靠 cookie 访问，token 不能每次重启就换，否则装了等于白装。 */
function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch (_) {}
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, t, { encoding: 'utf8', mode: 0o600 }); } catch (_) {}
  return t;
}

// ---------------------------------------------------------------- HTTP 基础

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' 'self'",   // 'self' 是给 Service Worker 用的
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1 << 20) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 时间安全比较，避免 token 被逐字节试探。 */
function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN)); } catch (_) { return false; }
}

const cookieToken = (req) => {
  const m = /(?:^|;\s*)panel_t=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
};
const authed = (req, url) =>
  tokenOk(cookieToken(req)) || tokenOk(req.headers['x-panel-token']) || tokenOk(url.searchParams.get('t'));

// ---------------------------------------------------------------- API

const now = () => new Date();

const API = {
  /** 面板主数据：全部任务视图 + 体检。前端所有视图都从这一份派生，不再二次请求。 */
  async state() {
    const all = T.loadAll();
    const n = now();
    return {
      tasks: all.map((t) => T.toView(t, n)),
      health: T.healthCheck(all, n),
      // 面板→飞书这条线现在通不通。放在主数据里一起下发，页面每次刷新都能看到，
      // 不用你去猜"我刚才改的到底有没有发出去"。
      link: EV.linkHealth(),
      meta: {
        statuses: T.STATUSES, horizons: T.HORIZONS, priorities: T.PRIORITIES,
        projects: [...new Set(all.map((t) => t.fm.project).filter(Boolean))].sort(),
        staleThreshold: T.STALE_DAYS,
        serverTime: n.toISOString(),
      },
    };
  },

  async detail(b) {
    const t = T.loadOne(need(b.name, 'name'), b.bucket);
    return T.toDetail(t, now());
  },

  /** 改字段（含状态）。status 变化会自动补一条进度，见 tasks.setFields。 */
  async setFields(b) {
    const name = need(b.name, 'name');
    const t = T.loadOne(name, b.bucket);
    const changes = T.setFields(t, b.patch || {}, now());
    if (!changes.length) return { changed: [], note: '没有实际变化' };
    T.save(t);
    const st = changes.find((c) => c.field === 'status');
    EV.record(st
      ? { kind: 'status', name, title: t.title || name, from: st.from, to: st.to }
      : { kind: 'fields', name, title: t.title || name, changes });
    return { changed: changes, task: T.toDetail(t, now()) };
  },

  /** 重写「下一步计划」。卡片正面推的就是这条，之前只能看不能改。 */
  async setNext(b) {
    const name = need(b.name, 'name');
    const t = T.loadOne(name, b.bucket);
    const ch = T.setNext(t, b.text);
    if (!ch) return { changed: false, note: '没有实际变化' };
    T.save(t);
    EV.record({ kind: 'next', name, title: t.title || name, to: ch.to });
    return { changed: true, task: T.toDetail(t, now()) };
  },

  /** 归档。只放行 done/cancelled——安全底线在 tasks.archive 里，这里不重复判断。 */
  async archive(b) {
    const name = need(b.name, 'name');
    const t = T.loadOne(name, b.bucket);
    T.archive(t);
    EV.record({ kind: 'archive', name, title: t.title || name });
    return { name, bucket: 'archive' };
  },

  async addProgress(b) {
    const name = need(b.name, 'name');
    const text = String(b.text || '').trim();
    if (!text) throw new Error('进度内容不能为空');
    const t = T.loadOne(name, b.bucket);
    T.appendProgress(t, text, now());
    T.save(t);
    EV.record({ kind: 'progress', name, title: t.title || name, text });
    return { task: T.toDetail(t, now()) };
  },

  async create(b) {
    const t = T.create({
      name: b.name, title: b.title, status: b.status || 'running',
      horizon: b.horizon || '短期', project: b.project, priority: b.priority,
      deadline: b.deadline, plan: b.plan,
    }, now());
    EV.record({ kind: 'create', name: t.name, title: t.title || t.name });
    return { task: T.toDetail(t, now()) };
  },

  async health() { return T.healthCheck(T.loadAll(), now()); },

  async ping() { return { ok: true, t: Date.now() }; },
};

function need(v, what) {
  const s = String(v || '').trim();
  if (!s) throw new Error('缺少参数：' + what);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) throw new Error('非法任务名');
  return s;
}

// ---------------------------------------------------------------- 静态资源

const STATIC = {
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return send(res, 400, { error: 'bad url' }); }

  // Service Worker 与 manifest 必须免鉴权：SW 注册、PWA 安装时浏览器发的是不带 cookie 的请求。
  // 它们不含任何任务数据，放行没有信息泄露；真正的数据全在 /api/* 后面。
  if (STATIC[url.pathname]) {
    const [f, type] = STATIC[url.pathname];
    try { return send(res, 200, fs.readFileSync(path.join(DIR, f)), type, { 'cache-control': 'no-cache' }); }
    catch (_) { return send(res, 404, 'not found', 'text/plain; charset=utf-8'); }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!authed(req, url)) {
      return send(res, 403, '无效的访问令牌。请从托盘菜单重新打开本页面。', 'text/plain; charset=utf-8');
    }
    // 带 ?t= 进来就把 token 种进 cookie，然后跳到干净的 /：
    // 这样 PWA 装出来的图标（start_url 不带 token）也能访问，且 token 不会留在地址栏/历史里。
    if (url.searchParams.get('t')) {
      return send(res, 302, '', 'text/plain', {
        location: '/',
        'set-cookie': `panel_t=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`,
      });
    }
    try { return send(res, 200, fs.readFileSync(path.join(DIR, 'panel.html'), 'utf8'), 'text/html; charset=utf-8'); }
    catch (_) { return send(res, 500, 'panel.html 缺失', 'text/plain; charset=utf-8'); }
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authed(req, url)) return send(res, 403, { error: '无效的访问令牌' });
    const fn = API[url.pathname.slice(5)];
    if (!fn) return send(res, 404, { error: '未知接口' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(res, 200, { ok: true, data: await fn(body) });
    } catch (e) {
      // 业务错误原样回给页面显示，不吞
      return send(res, 200, { ok: false, error: (e && e.message) || String(e) });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`端口 ${PORT} 被占用。面板需要固定端口才能支持 PWA 安装；` +
      `换端口请设 PANEL_PORT 环境变量（注意换了端口原来装的 PWA 会失效）。\n`);
    process.exit(2);
  }
  process.stderr.write('服务异常: ' + e.message + '\n');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  process.stdout.write(JSON.stringify({ url, port: PORT, token: TOKEN }) + '\n');
  if (!process.argv.includes('--no-open')) {
    require('child_process').execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});

module.exports = { API, server, PORT, TOKEN };
