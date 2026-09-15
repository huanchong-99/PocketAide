#!/usr/bin/env node
'use strict';
/**
 * 供应商切换器的本地 Web 界面（按需起，不常驻）。
 *
 * 【为什么是按需 + 只绑本地 + token】这个页面能读到、也能改写你**所有供应商的明文 API Key**。
 * 让这样一个 HTTP 服务 7×24 常驻，等于给自己开一个长期暴露的取密钥口子。所以：
 *   - 只监听 127.0.0.1（外网/局域网都碰不到）
 *   - 端口随机（listen(0)，不占固定端口、也不可预测）
 *   - 每次启动生成一次性 token，所有 /api/* 都校验；token 只在启动时通过 URL 交给浏览器
 *   - 页面停止心跳 IDLE_MS 后进程自杀，关掉标签页服务就没了
 *
 * 【为什么复用 CMDS】写操作一律走 switch.js 的 CMDS——页面和命令行是同一套实现。
 * 两个入口各写一份的话，迟早出现"命令行切了、页面显示没切"这种对不上的事。
 *
 * 用法：
 *   node tools/switch/webui.js            起服务并打开浏览器
 *   node tools/switch/webui.js --no-open  只起服务，把 {url,port,token} 打到 stdout(供托盘用)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sw = require('./switch');
const procs = require('./procs');

const HTML = path.join(__dirname, 'webui.html');
const TOKEN = crypto.randomBytes(24).toString('hex');
const IDLE_MS = Number(process.env.SWITCH_UI_IDLE_MS || 45000);   // 无心跳多久后自杀
let lastBeat = Date.now();

// ---------------------------------------------------------------- 工具

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'no-store',
    // 页面只在本机、只由本进程提供，禁掉一切外部资源，杜绝 Key 被第三方脚本捎走
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    'referrer-policy': 'no-referrer',
  });
  res.end(buf);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1 << 20) { reject(new Error('请求体过大')); req.destroy(); return; }   // 防撑爆内存
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 时间安全比较，避免 token 被逐字节试探出来。 */
function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

const mask = (v) => {
  const s = String(v || '');
  return s.length <= 10 ? (s ? s.slice(0, 2) + '***' : '') : s.slice(0, 6) + '***' + s.slice(-4);
};

/**
 * 读档案，没有就当空的。
 * 首次使用（全新克隆、还没跑过 init）时 loadStore 会抛"还没有供应商档案"，
 * 若直接让它抛出去，用户打开设置页看到的就是一片报错——而这恰恰是他最需要引导的时刻。
 * 所以这里容错返回空档案，页面据此显示"播种 / 手动添加"的引导。
 */
function safeStore() {
  try { return sw.loadStore(); } catch (_) { return { current: null, providers: {} }; }
}

/** 给页面用的供应商视图：Key 一律打码，页面永远拿不到完整 Key（改 Key 只能整体覆盖写）。 */
function providersView() {
  const store = safeStore();
  return {
    current: store.current,
    providers: Object.entries(store.providers).map(([name, p]) => {
      const env = p.env || {};
      return {
        name, label: p.label || name,
        official: Boolean(p.official),
        current: name === store.current,
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        tokenMasked: mask(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
        hasToken: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
        model: env.ANTHROPIC_MODEL || p.model || '',
        aliases: {
          opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
          sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
          haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
          reasoning: env.ANTHROPIC_REASONING_MODEL || '',
        },
        catalog: p.catalog || [],
      };
    }),
  };
}

/** 会话进程概览：页面据此显示"还有几个会话在跑旧配置"。 */
function procsView() {
  try {
    const s = procs.scan();
    return {
      self: s.self,
      bridgeUp: s.bridgeNode.length > 0,
      bridgeClaude: s.bridgeClaude.map((p) => p.pid),
      terminalClaude: s.terminalClaude.map((p) => ({ pid: p.pid, self: p.pid === s.self })),
    };
  } catch (e) { return { error: e.message }; }
}

// ---------------------------------------------------------------- API

const API = {
  async state() {
    return { status: sw.buildStatus(), ...providersView(), procs: procsView() };
  },

  /**
   * 切换。这里是整个界面最要命的一条：**必须走完 探活→落盘→重启**。
   * 只改文件不重启，页面会显示"已切换"而系统照旧跑老供应商——纯粹的假象。
   * 所以直接调 CMDS.use（和命令行同一条路径），把它的重启结果原样回给页面显示。
   */
  async use(b) {
    const flags = { scope: b.scope || 'both' };
    if (b.killTerminals) flags['kill-terminals'] = true;
    if (b.force) flags.force = true;
    if (b.skipCheck) flags['skip-check'] = true;
    return sw.CMDS.use({ _: [b.name], flags });
  },

  async check(b) { return sw.CMDS.check({ _: b.name ? [b.name] : [], flags: {} }); },

  async model(b) {
    const flags = {};
    if (b.alias) flags.alias = b.alias;
    if (b.provider) flags.provider = b.provider;
    if (b.scope) flags.scope = b.scope;
    return sw.CMDS.model({ _: [b.model], flags });
  },

  async restart(b) {
    return sw.CMDS.restart({ _: [], flags: { scope: b.scope || 'bridge', 'include-self': Boolean(b.includeSelf) } });
  },

  /** 新增或整体更新一个供应商档。token 留空表示"不改动原有 Key"。 */
  async saveProvider(b) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new Error('名称只能用字母/数字/点/下划线/连字符，1-32 位');
    const store = safeStore();          // 首次添加时档案还不存在，不能用会抛的 loadStore
    const prev = store.providers[name] || {};
    const prevEnv = prev.env || {};

    if (b.official) {
      store.providers[name] = { label: b.label || name, official: true, model: b.model || 'opus[1m]', env: {}, catalog: prev.catalog || [] };
    } else {
      const url = String(b.baseUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
      const token = b.token ? String(b.token).trim() : (prevEnv.ANTHROPIC_AUTH_TOKEN || prevEnv.ANTHROPIC_API_KEY || '');
      if (!token) throw new Error('缺少 API Key');
      const model = String(b.model || '').trim();
      if (!model) throw new Error('缺少模型名');
      const env = { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model };
      // 别名档位选填；填了就连 _NAME 一起写（不少第三方端点缺 _NAME 会回落到官方模型名而 404）
      for (const [k, keys] of Object.entries({
        opus: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
        sonnet: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
        haiku: ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
        reasoning: ['ANTHROPIC_REASONING_MODEL'],
      })) {
        const v = b.aliases && String(b.aliases[k] || '').trim();
        if (v) for (const key of keys) env[key] = v;
      }
      const catalog = Array.from(new Set([...(prev.catalog || []), model, ...(b.catalog || [])].filter(Boolean)));
      store.providers[name] = { label: b.label || name, model, env, catalog };
    }
    sw.saveStore(store);
    return { saved: name, ...providersView() };
  },

  async deleteProvider(b) {
    return sw.CMDS.rm({ _: [b.name], flags: {} });
  },

  /** 从现有的全局/桥接配置播种档案。首次使用时页面上的"一键播种"走这里。 */
  async init() {
    const r = await sw.CMDS.init({ _: [], flags: { force: true } });
    return { ...r, ...providersView() };
  },

  /**
   * 「从本机当前配置复制」：把全局此刻用的那一档照搬成一个供应商档。
   * 官方订阅这一档不需要重新登录、也不需要填 Key（走已有的 OAuth 凭据）。
   */
  async importLocal(b) {
    const r = await sw.CMDS.import({ _: [], flags: b && b.name ? { name: b.name } : {} });
    return { ...r, ...providersView() };
  },

  async ping() { lastBeat = Date.now(); return { ok: true }; },
};

// ---------------------------------------------------------------- 服务

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return send(res, 400, { error: 'bad url' }); }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!tokenOk(url.searchParams.get('t'))) return send(res, 403, '无效的访问令牌。请从托盘菜单重新打开本页面。', 'text/plain; charset=utf-8');
    let html;
    try { html = fs.readFileSync(HTML, 'utf8'); } catch (e) { return send(res, 500, 'webui.html 缺失', 'text/plain; charset=utf-8'); }
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  if (url.pathname.startsWith('/api/')) {
    if (!tokenOk(req.headers['x-switch-token'])) return send(res, 403, { error: '无效的访问令牌' });
    const name = url.pathname.slice(5);
    const fn = API[name];
    if (!fn) return send(res, 404, { error: '未知接口: ' + name });
    lastBeat = Date.now();
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(res, 200, { ok: true, data: await fn(body) });
    } catch (e) {
      // 业务错误(探活失败、参数不合法等)原样回给页面显示，不吞
      return send(res, 200, { ok: false, error: (e && e.message) || String(e) });
    }
  }
  return send(res, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  process.stdout.write(JSON.stringify({ url, port, token: TOKEN }) + '\n');
  if (!process.argv.includes('--no-open')) {
    // start 需要一个空标题参数占位，否则带引号的 URL 会被当成窗口标题
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});

// 关掉页面 = 停止心跳 = 服务自己退出。按需起、用完即走，不留常驻取密钥口子。
setInterval(() => {
  if (Date.now() - lastBeat > IDLE_MS) { try { server.close(); } catch (_) {} process.exit(0); }
}, 5000).unref?.();
