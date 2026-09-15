#!/usr/bin/env node
'use strict';
/**
 * PocketAide — 供应商 / 模型切换底座（tools/switch）
 *
 * 【身份】这是**基础设施**，不是技能。它决定"整套系统此刻用哪个供应商、哪个模型在跑"，
 * 在桥接启动时就参与工作（被 bridge/main.js 直接 require），而不是等用户开口才被唤起。
 * 能被对话驱动（"切回官方"）只是它的一个入口，不是它的身份。
 *
 * 【它接管了什么】原 bridge/main.js 的 ANTHROPIC_* 同步逻辑：
 *     for (const k of Object.keys(glb.env)) if (k.startsWith('ANTHROPIC_')) cur.env[k] = glb.env[k];
 * 那段只覆盖、不删除。实测后果：全局切到某第三方供应商时桥接跟着同步过去；之后全局把
 * ANTHROPIC_* 整组删掉切回官方订阅，桥接却因为"删除同步不过去"卡在旧供应商上长达数周——
 * 终端跑官方模型、飞书跑第三方模型，使用者全程不知情。
 *
 * 【核心不变量】写入 = **先删净目标端所有 ANTHROPIC_*，再写当前供应商的键**。
 * 于是"删除"天然可被同步，"切回官方"就是"一个都不写"，不可能再留残影。
 *
 * 【第二不变量】顶层 settings.model 与 env.ANTHROPIC_MODEL 永远一致。
 * 实测优先级是 ANTHROPIC_MODEL 赢（配置里顶层 model 写着上一家的模型名，实跑却是另一个），
 * 两者不一致就会让人看着配置猜错模型。本模块保证：看到什么就是在跑什么。
 *
 * 用法见 README.md；机器调用一律加 --json。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const procs = require('./procs');

const REPO = path.resolve(__dirname, '..', '..');
const STORE = path.join(__dirname, 'providers.json');            // 真实档案(含 Key)，gitignore
const EXAMPLE = path.join(__dirname, 'providers.example.json');  // 脱敏模板，入库
const HOME_CLAUDE = path.join(os.homedir(), '.claude');
const BRIDGE_HOME = path.join(REPO, 'bridge', '.claude-home');

// 两个落地端。系统的"供应商配置"永远是这两处的合集，任何一处漂移都算故障。
const SCOPES = {
  global: {
    label: '全局(终端会话)',
    settings: path.join(HOME_CLAUDE, 'settings.json'),
    projects: path.join(HOME_CLAUDE, 'projects'),
  },
  bridge: {
    label: '桥接(飞书会话)',
    settings: path.join(BRIDGE_HOME, 'settings.json'),
    projects: path.join(BRIDGE_HOME, 'projects'),
  },
};

// 模型别名 → 对应的环境变量组。第三方端点大多要求 _NAME 一起给，缺了会回落到官方名而 404。
const ALIAS_ENV = {
  opus: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
  sonnet: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
  haiku: ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
  reasoning: ['ANTHROPIC_REASONING_MODEL'],
};

class SwitchError extends Error {}
const fail = (msg) => { throw new SwitchError(msg); };

// ---------------------------------------------------------------- 基础读写

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback === undefined ? null : fallback;
    fail(`读取失败 ${file}: ${e.message}`);
  }
  try { return JSON.parse(stripBom(raw)); }
  // 解析失败绝不"当空处理后覆盖"——那会把用户整份 settings 抹掉。宁可中止。
  catch (e) { fail(`${file} 不是合法 JSON（拒绝覆盖，请先修复）: ${e.message}`); }
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 原子写 + 滚动备份。改的是"整个 Claude Code 还能不能用"的文件，必须经得起半路断电。
function writeJsonAtomic(file, obj, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) rollBackup(file);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);   // 同盘 rename，Windows 下走 MOVEFILE_REPLACE_EXISTING，原子覆盖
}

const BACKUP_KEEP = 5;
function rollBackup(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tag = `${base}.switch-bak-`;
  try { fs.copyFileSync(file, path.join(dir, tag + Date.now())); } catch (_) { return; }
  try {
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(tag)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

// ---------------------------------------------------------------- 档案库

function loadStore() {
  const s = readJson(STORE, null);
  if (!s) fail(`还没有供应商档案。先跑一次：node tools/switch/switch.js init`);
  s.providers = s.providers || {};
  return s;
}
const saveStore = (s) => writeJsonAtomic(STORE, s, { backup: false });

function getProvider(store, name) {
  const p = store.providers[name];
  if (!p) fail(`没有这个供应商：${name}（可选：${Object.keys(store.providers).join(', ') || '空'}）`);
  return p;
}

// ---------------------------------------------------------------- 核心：落地一个供应商

const isAnthropicKey = (k) => k.startsWith('ANTHROPIC_');

/**
 * 把 provider 落到一份 settings 对象上（纯函数，不碰磁盘）。
 * 这就是核心不变量的全部实现：先删净，再写入，最后对齐顶层 model。
 */
function applyProvider(settings, provider) {
  const s = { ...settings };
  const env = { ...(s.env || {}) };

  for (const k of Object.keys(env)) if (isAnthropicKey(k)) delete env[k];   // ① 删净，绝不保留残影
  for (const [k, v] of Object.entries(provider.env || {})) {               // ② 只写本供应商声明的键
    if (v !== null && v !== undefined && v !== '') env[k] = String(v);
  }

  if (Object.keys(env).length) s.env = env; else delete s.env;

  // ③ 顶层 model 与 ANTHROPIC_MODEL 对齐。第三方以 ANTHROPIC_MODEL 为准（实测它优先）；
  //    官方端没有 ANTHROPIC_MODEL，就用 provider 自己声明的 model（如 opus[1m]）。
  const model = env.ANTHROPIC_MODEL || provider.model || null;
  if (model) s.model = model; else delete s.model;

  return s;
}

/**
 * 桥接首次播种用的净化器：从全局配置派生一份**不含任何供应商信息**的基线。
 *
 * 桥接的 settings.json 首次需要从全局播种一份(为的是继承 hooks / plugins / effort 这些行为设置)，
 * 但**绝不能连供应商一起继承**。整份复制的后果很具体：换新机或桥接 home 被删时，若全局当时正配着
 * 某个第三方端点，桥接就把那份 Base URL + Key 静默捡了过来；此时若还没有 providers.json，
 * syncBridge 不做任何事，于是桥接跑在一个"档案里根本没有"的供应商上，而使用者毫不知情——
 * 正是本模块要根除的那类事故的另一个入口。
 *
 * 所以：env 里的 ANTHROPIC_* 全剥、顶层 model 也剥。桥接用哪个供应商、哪个模型，
 * 只有 tools/switch 的档案说了算。没有档案时回落到 Claude Code 默认(官方订阅)，安全且可预测。
 */
function sanitizeForBridgeSeed(globalSettings) {
  const s = { ...globalSettings };
  if (s.env) {
    const env = { ...s.env };
    for (const k of Object.keys(env)) if (isAnthropicKey(k)) delete env[k];
    if (Object.keys(env).length) s.env = env; else delete s.env;
  }
  delete s.model;
  return s;
}

/** 落地到某个 scope 的磁盘文件。返回变更摘要，供调用方如实汇报。 */
function applyToScope(scopeName, provider, { dryRun = false } = {}) {
  const scope = SCOPES[scopeName] || fail(`未知 scope：${scopeName}`);
  const before = readJson(scope.settings, null);
  if (!before) {
    // 桥接那份可能还没被播种过（首次启动前）。全局那份不存在则说明环境异常，不擅自造。
    if (scopeName === 'bridge') return { scope: scopeName, skipped: '桥接 settings 尚未生成（桥接未首次启动）' };
    fail(`找不到 ${scope.settings}`);
  }
  const after = applyProvider(before, provider);
  const diff = diffEnv(before, after);
  if (!dryRun && diff.changed) writeJsonAtomic(scope.settings, after);
  return { scope: scopeName, label: scope.label, file: scope.settings, dryRun, ...diff };
}

function diffEnv(before, after) {
  const be = before.env || {}, ae = after.env || {};
  const keys = new Set([...Object.keys(be), ...Object.keys(ae)].filter(isAnthropicKey));
  const removed = [], added = [], updated = [];
  for (const k of keys) {
    if (be[k] !== undefined && ae[k] === undefined) removed.push(k);
    else if (be[k] === undefined && ae[k] !== undefined) added.push(k);
    else if (be[k] !== ae[k]) updated.push(k);
  }
  const d = {
    removed, added, updated,
    modelBefore: before.model || null,
    modelAfter: after.model || null,
  };
  d.changed = hasChange(d);   // 普通字段，经得起 {...d} 展开（getter 会在展开时丢失）
  return d;
}

const hasChange = (d) =>
  Boolean(d.removed.length || d.added.length || d.updated.length || d.modelBefore !== d.modelAfter);

// ---------------------------------------------------------------- 实证：真实在跑的模型

/**
 * 从会话存档反查"实际在跑的模型"，而不是相信配置文件写了什么。
 * 那次事故正是靠这招才查出来：桥接配置写着上一家的模型名，实跑的却是另一家，已经数周。
 * 只读最近一个 jsonl 的尾部，不做全量扫描（history 可达数 MB）。
 */
function detectLive(scopeName) {
  const dir = SCOPES[scopeName].projects;
  let files = [];
  try {
    for (const proj of fs.readdirSync(dir)) {
      const pd = path.join(dir, proj);
      let st; try { st = fs.statSync(pd); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(pd)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pd, f);
        try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch (_) {}
      }
    }
  } catch (_) { return null; }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { fp, mtime } of files.slice(0, 3)) {       // 最近 3 份足够，再旧的没有参考价值
    const hit = lastModelInFile(fp);
    if (!hit) continue;
    // 时间取那条记录自己的 timestamp，不能用文件 mtime：`-c` 续接会在新会话起来后立刻往同一个
    // jsonl 追加内容，mtime 因此比进程还新，据它判断"重启过没有"必然失效。
    const atMs = hit.ts || mtime;
    return { model: hit.model, at: new Date(atMs).toISOString(), atMs, file: fp };
  }
  return null;
}

/** 从文件尾部往前找最后一条带 model 的记录，返回 { model, ts }。只读尾部 512KB。 */
function lastModelInFile(file) {
  const TAIL = 512 * 1024;
  let buf;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - TAIL);
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
  } catch (_) { return null; }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"model"')) continue;
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    const m = (o.message && o.message.model) || o.model;
    if (m && m !== '<synthetic>') {
      const t = Date.parse(o.timestamp || '');
      return { model: m, ts: Number.isFinite(t) ? t : null };
    }
  }
  return null;
}

// ---------------------------------------------------------------- 体检

/**
 * 该端当前会话进程的启动时刻（毫秒）。用来区分两种看起来一样、后果完全不同的状态：
 *   "改了配置但没重启"(真故障) vs "已重启、只是还没人说过话所以没有新记录"(正常)。
 * 拿不到就返回 null，此时按保守口径当作未重启。
 */
function sessionStartedAt(scopeName) {
  try {
    const s = procs.scan();
    const list = scopeName === 'bridge' ? s.bridgeClaude : s.terminalClaude;
    const times = list.map((p) => p.startedAt).filter((t) => typeof t === 'number');
    return times.length ? Math.max(...times) : null;
  } catch (_) { return null; }
}

function readScopeState(scopeName) {
  const scope = SCOPES[scopeName];
  const s = readJson(scope.settings, null);
  if (!s) return { scope: scopeName, label: scope.label, exists: false };
  const env = s.env || {};
  const anth = Object.fromEntries(Object.entries(env).filter(([k]) => isAnthropicKey(k)));
  const configured = env.ANTHROPIC_MODEL || s.model || null;
  return {
    scope: scopeName,
    label: scope.label,
    exists: true,
    file: scope.settings,
    baseUrl: env.ANTHROPIC_BASE_URL || null,     // null = 官方直连
    official: !env.ANTHROPIC_BASE_URL,
    configuredModel: configured,
    settingsModel: s.model || null,
    envModel: env.ANTHROPIC_MODEL || null,
    anthropicKeys: Object.keys(anth).sort(),
    live: detectLive(scopeName),
    sessionStartedAt: sessionStartedAt(scopeName),
  };
}

/** 匹配 scope 现状到某个已知供应商档；认不出就返回 null（比如用户手工改过）。 */
function matchProvider(store, state) {
  for (const [name, p] of Object.entries(store.providers)) {
    const url = (p.env || {}).ANTHROPIC_BASE_URL || null;
    if ((url || null) === (state.baseUrl || null)) return name;
  }
  return null;
}

/**
 * 配置值与实跑模型是否算一致。不能直接字符串比——配置里写的常常是**别名**，
 * 由 Claude Code 在启动时解析成具体模型 ID：`opus[1m]` 实跑就是 `claude-opus-5`，
 * 两者并不矛盾。直接比会把正常状态报成故障（假警报比不报警更糟：真出事时没人信它了）。
 */
function modelMatches(configured, live) {
  if (!configured || !live) return true;
  if (configured === live) return true;
  const stripCtx = (s) => s.replace(/\[[^\]]*\]$/, '');          // 剥掉 [1m] / [1M] 这类上下文后缀
  if (stripCtx(configured) === stripCtx(live)) return true;
  const alias = /^(opus|sonnet|haiku)(\[[^\]]*\])?$/i.exec(configured);   // 官方家族别名
  return Boolean(alias && new RegExp(`^claude-${alias[1]}-`, 'i').test(live));
}

function buildStatus() {
  const store = readJson(STORE, { current: null, providers: {} });
  const scopes = Object.keys(SCOPES).map((n) => {
    const st = readScopeState(n);
    st.provider = st.exists ? matchProvider(store, st) : null;
    return st;
  });

  const warnings = [];
  const [g, b] = scopes;

  if (g.exists && b.exists) {
    if ((g.baseUrl || null) !== (b.baseUrl || null)) {
      warnings.push(`两端供应商不一致：${g.label}=${g.baseUrl || '官方直连'}，${b.label}=${b.baseUrl || '官方直连'}`);
    } else if (g.configuredModel !== b.configuredModel) {
      warnings.push(`两端模型不一致：${g.label}=${g.configuredModel}，${b.label}=${b.configuredModel}`);
    }
  }
  for (const s of scopes) {
    if (!s.exists) continue;
    // 顶层 model 与 ANTHROPIC_MODEL 打架 —— 正是让人"看着配置猜错模型"的那个坑
    if (s.envModel && s.settingsModel && s.envModel !== s.settingsModel) {
      warnings.push(`${s.label} 配置自相矛盾：顶层 model=${s.settingsModel}，但 ANTHROPIC_MODEL=${s.envModel}（实际以后者为准）`);
    }
    // 配置说一套、实跑另一套。但"实跑"读的是最后一条会话记录，重启后若还没人说过话，
    // 它仍是上个会话留下的旧值——此时报"尚未重启"会把已经生效的状态说成故障。
    // 故先看会话进程是不是在那条记录之后才起来的：是 => 已重启、只是还没新记录，不算故障。
    // 结论存进 s.liveState，CLI 与 Web 都只读它，避免各写一套比较逻辑、各犯各的误报。
    if (s.live && s.configuredModel && !modelMatches(s.configuredModel, s.live.model)) {
      const startedAfter = s.sessionStartedAt && s.live.atMs && s.sessionStartedAt > s.live.atMs;
      s.liveState = startedAfter ? 'restarted' : 'stale';
      if (!startedAfter) {
        warnings.push(`${s.label} 配置=${s.configuredModel}，但最近一次实跑=${s.live.model}（该端尚未重启，配置还没生效）`);
      }
    } else {
      s.liveState = 'ok';
    }
    if (s.official && s.anthropicKeys.length) {
      warnings.push(`${s.label} 声称官方直连，却残留 ${s.anthropicKeys.length} 个 ANTHROPIC_* 键：${s.anthropicKeys.join(', ')}`);
    }
  }
  return { current: store.current || null, scopes, warnings };
}

// ---------------------------------------------------------------- 连通性探活

async function checkProvider(name, provider) {
  const env = provider.env || {};
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return { name, skipped: '官方直连走 OAuth(Max 订阅)凭据，无 Key 可探，跳过' };
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!token) return { name, ok: false, reason: '该档没有 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY' };
  const model = env.ANTHROPIC_MODEL || provider.model;
  if (!model) return { name, ok: false, reason: '该档没有指定模型' };

  const url = baseUrl.replace(/\/+$/, '') + '/v1/messages';
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(env.ANTHROPIC_API_KEY ? { 'x-api-key': env.ANTHROPIC_API_KEY } : {}),
    ...(env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } : {}),
  };
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });

  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const text = await res.text().catch(() => '');
    // 200 = 通；400 多为"max_tokens 太小"之类的参数挑剔，鉴权与路由其实已经通了。
    if (res.status === 200 || res.status === 400) return { name, ok: true, status: res.status, ms, model, baseUrl };
    return { name, ok: false, status: res.status, ms, model, baseUrl, reason: httpHint(res.status), detail: text.slice(0, 200) };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, model, baseUrl, reason: e.name === 'AbortError' ? '超时(20s)' : e.message };
  }
}

const httpHint = (s) => ({
  401: 'Key 无效或已过期', 403: 'Key 无权限/被拒', 404: '端点路径不对（是否少了 /anthropic 后缀？）',
  429: '限流', 500: '上游错误', 502: '网关错误', 503: '上游不可用',
}[s] || `HTTP ${s}`);

// ---------------------------------------------------------------- init：从现有配置播种

function seedFromExisting() {
  const providers = {};
  let current = null;

  const glb = readJson(SCOPES.global.settings, null);
  const brg = readJson(SCOPES.bridge.settings, null);

  // 官方档永远存在：它的定义就是"一个 ANTHROPIC_* 都不写"。
  providers.official = {
    label: 'Anthropic 官方（Max 订阅 / OAuth）',
    official: true,
    model: (glb && !((glb.env || {}).ANTHROPIC_BASE_URL) && glb.model) || 'opus[1m]',
    env: {},
    catalog: ['opus[1m]', 'opus', 'sonnet', 'haiku'],
  };

  for (const [src, s] of [['global', glb], ['bridge', brg]]) {
    if (!s || !s.env || !s.env.ANTHROPIC_BASE_URL) continue;
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => isAnthropicKey(k)));
    const name = guessName(env.ANTHROPIC_BASE_URL);
    providers[name] = providers[name] || {
      label: `${name}（从${SCOPES[src].label}现有配置导入）`,
      model: env.ANTHROPIC_MODEL || s.model || null,
      env,
      catalog: [env.ANTHROPIC_MODEL].filter(Boolean),
    };
    if (src === 'global') current = name;
  }
  if (!current) current = (glb && !((glb.env || {}).ANTHROPIC_BASE_URL)) ? 'official' : Object.keys(providers)[0];
  return { current, providers };
}

function guessName(url) {
  const u = String(url);
  if (/deepseek/i.test(u)) return 'deepseek';
  if (/bigmodel|zhipu/i.test(u)) return 'glm';
  if (/moonshot|kimi/i.test(u)) return 'kimi';
  if (/openrouter/i.test(u)) return 'openrouter';
  try { return new URL(u).hostname.split('.').slice(-2)[0] || 'custom'; } catch (_) { return 'custom'; }
}

// ---------------------------------------------------------------- 脱敏

const mask = (v) => {
  const s = String(v || '');
  if (s.length <= 10) return s ? s.slice(0, 2) + '***' : '';
  return s.slice(0, 6) + '***' + s.slice(-4);
};
const SECRET_KEY = /(TOKEN|KEY|SECRET)$/i;

function maskProvider(p) {
  const env = {};
  for (const [k, v] of Object.entries(p.env || {})) env[k] = SECRET_KEY.test(k) ? mask(v) : v;
  return { ...p, env };
}

/** 生成脱敏模板：结构与真实档案一致，所有密钥换成占位符。供开源版使用。 */
function buildExample(store) {
  const providers = {};
  for (const [name, p] of Object.entries(store.providers)) {
    const env = {};
    for (const [k, v] of Object.entries(p.env || {})) env[k] = SECRET_KEY.test(k) ? `<你的 ${k}>` : v;
    providers[name] = { ...p, env };
  }
  return { current: store.current, providers };
}

// ---------------------------------------------------------------- 供 bridge 调用的 API

/**
 * 桥接启动时调用：把"当前选定的供应商"完整落到桥接端。
 * 取代 main.js 里那段"只覆盖不删除"的同步。落不了（没档案/没配置）就返回原因，
 * 由调用方记日志，绝不抛异常打断桥接启动——切换器坏了不该让整个系统起不来。
 */
function syncBridge({ dryRun = false } = {}) {
  try {
    const store = readJson(STORE, null);
    if (!store || !store.current) return { ok: false, reason: '尚无供应商档案（未 init），本次不同步' };
    const provider = store.providers[store.current];
    if (!provider) return { ok: false, reason: `档案里没有 current=${store.current}` };
    const r = applyToScope('bridge', provider, { dryRun });
    if (r.skipped) return { ok: false, reason: r.skipped };
    return { ok: true, provider: store.current, model: r.modelAfter, changed: r.changed, removed: r.removed, added: r.added, dryRun };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------- 让切换真正生效

/**
 * 切换落盘之后的重启编排。两端的性质完全不同，所以默认策略也不同：
 *   桥接端——有主进程守着，杀掉 claude 子进程它会自己重新拉起（并重新落地配置），
 *            用户在飞书那头几乎无感，故默认自动重启。
 *   终端端——没有守护进程替你重开窗口，杀了就真没了，且调用者自己往往就在其中一个里面，
 *            故默认只报告"这些还在用旧配置"，要真杀必须显式 --kill-terminals。
 */
function restartAfterSwitch(a, results) {
  const out = {};
  const bridgeTouched = results.some((r) => r.scope === 'bridge' && !r.skipped && r.changed);
  if (bridgeTouched) out.bridge = procs.restartBridgeSession();
  else out.bridge = { ok: true, killed: [], note: '桥接端配置未变，无需重启' };

  const globalTouched = results.some((r) => r.scope === 'global' && !r.skipped && r.changed);
  if (!globalTouched) {
    out.terminal = { killed: [], pending: [], note: '全局配置未变，终端会话无需处理' };
  } else if (a.flags['kill-terminals']) {
    out.terminal = procs.killTerminalSessions({ includeSelf: Boolean(a.flags['include-self']) });
  } else {
    const s = procs.scan();
    const others = s.terminalClaude.filter((p) => p.pid !== s.self);
    out.terminal = {
      killed: [], pending: others.map((p) => p.pid),
      note: others.length
        ? '这些终端会话仍在用旧配置（Claude Code 只在启动时读 settings）。加 --kill-terminals 结束它们，或自行重开窗口'
        : '没有其它终端会话',
    };
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.flags[k] = v === undefined ? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true) : v;
    } else out._.push(a);
  }
  return out;
}

const scopesOf = (flag) => {
  const v = flag || 'both';
  if (v === 'both') return ['global', 'bridge'];
  if (SCOPES[v]) return [v];
  fail(`--scope 只能是 global | bridge | both，收到：${v}`);
};

const CMDS = {
  async init(a) {
    const exists = fs.existsSync(STORE);
    if (exists && !a.flags.force) fail(`档案已存在：${STORE}（要重新播种请加 --force）`);
    const store = seedFromExisting();
    saveStore(store);
    writeJsonAtomic(EXAMPLE, buildExample(store), { backup: false });
    return { created: STORE, example: EXAMPLE, current: store.current, providers: Object.keys(store.providers) };
  },

  async list() {
    const store = loadStore();
    return {
      current: store.current,
      providers: Object.entries(store.providers).map(([name, p]) => ({
        name, current: name === store.current, label: p.label,
        baseUrl: (p.env || {}).ANTHROPIC_BASE_URL || '官方直连',
        model: (p.env || {}).ANTHROPIC_MODEL || p.model || null,
        catalog: p.catalog || [],
      })),
    };
  },

  async status() { return buildStatus(); },

  /**
   * 切换供应商。三步有严格先后，缺一步或反了顺序都会出问题：
   *   ① 探活——切过去才发现不通 = 整套系统当场瘫痪（飞书端尤其：人在外面只看到机器人不吭声）
   *   ② 落盘——必须在杀进程之前，反过来会留窗口期让重启的进程抢读到旧配置
   *   ③ 重启——Claude Code 只在启动时读一次 settings，不重启等于没切
   */
  async use(a) {
    const name = a._[0] || fail('用法：use <供应商名> [--scope global|bridge|both] [--kill-terminals] [--no-restart] [--force]');
    const store = loadStore();
    const provider = getProvider(store, name);
    const dryRun = Boolean(a.flags['dry-run']);

    let check = null;
    if (!dryRun && !a.flags['skip-check']) {
      check = await checkProvider(name, provider);
      if (check.ok === false && !a.flags.force) {
        fail(`${name} 探活失败：${check.reason}${check.detail ? ' — ' + check.detail : ''}\n` +
             `拒绝切换（切过去会让整套系统不可用）。确认无误仍要切加 --force，只想跳过探活加 --skip-check。`);
      }
    }

    const results = scopesOf(a.flags.scope).map((s) => applyToScope(s, provider, { dryRun }));
    if (!dryRun) { store.current = name; saveStore(store); }

    const restart = (!dryRun && !a.flags['no-restart']) ? restartAfterSwitch(a, results) : null;
    return { switched: name, label: provider.label, check, results, restart };
  },

  /** 单独重启，不改配置。配置已对但会话还在跑旧的时用。 */
  async restart(a) {
    const scopes = scopesOf(a.flags.scope);
    const out = {};
    if (scopes.includes('bridge')) out.bridge = procs.restartBridgeSession();
    if (scopes.includes('global')) out.terminal = procs.killTerminalSessions({ includeSelf: Boolean(a.flags['include-self']) });
    return out;
  },

  /** 看当前在跑的会话进程，以及哪个是调用者自己（自己那个永远不会被误杀）。 */
  async ps() {
    const s = procs.scan();
    const fmt = (p) => ({ pid: p.pid, ppid: p.ppid, self: p.pid === s.self, startedAt: p.startedAt });
    return {
      self: s.self,
      bridgeNode: s.bridgeNode.map(fmt),
      bridgeClaude: s.bridgeClaude.map(fmt),
      terminalClaude: s.terminalClaude.map(fmt),
    };
  },

  async model(a) {
    const model = a._[0] || fail('用法：model <模型名> [--alias opus|sonnet|haiku|reasoning] [--provider <名>]');
    const store = loadStore();
    const name = a.flags.provider || store.current || fail('没有 current，指定 --provider');
    const provider = getProvider(store, name);
    provider.env = provider.env || {};

    if (a.flags.alias) {
      const keys = ALIAS_ENV[a.flags.alias] || fail(`--alias 只能是 ${Object.keys(ALIAS_ENV).join(' | ')}`);
      for (const k of keys) provider.env[k] = model;
    } else if (provider.official) {
      provider.model = model;                       // 官方端没有 ANTHROPIC_MODEL，改顶层 model
    } else {
      provider.env.ANTHROPIC_MODEL = model;         // 第三方以它为准
      provider.model = model;                       // 顶层同步对齐，杜绝"配置说 A 实跑 B"
    }
    if (!provider.catalog) provider.catalog = [];
    if (!provider.catalog.includes(model)) provider.catalog.push(model);
    saveStore(store);

    // 只有改的是当前档才顺带落盘；改别的档只动档案、不碰运行中的配置。
    if (name !== store.current) return { provider: name, model, alias: a.flags.alias || null, applied: [], restart: null };
    const results = scopesOf(a.flags.scope).map((s) => applyToScope(s, provider));
    const restart = a.flags['no-restart'] ? null : restartAfterSwitch(a, results);
    return { provider: name, model, alias: a.flags.alias || null, applied: results, restart };
  },

  async check(a) {
    const store = loadStore();
    const names = a._.length ? a._ : [store.current];
    const out = [];
    for (const n of names) out.push(await checkProvider(n, getProvider(store, n)));
    return { checks: out };
  },

  async add(a) {
    const name = a._[0] || fail('用法：add <名称> --url <baseUrl> --token <key> --model <模型> [--label <说明>]');
    const store = loadStore();
    if (store.providers[name] && !a.flags.force) fail(`${name} 已存在（覆盖请加 --force）`);
    const url = a.flags.url || fail('缺 --url');
    const token = a.flags.token || fail('缺 --token');
    const model = a.flags.model || fail('缺 --model');
    store.providers[name] = {
      label: a.flags.label || name,
      model,
      env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model },
      catalog: [model],
    };
    saveStore(store);
    return { added: name, provider: maskProvider(store.providers[name]) };
  },

  async rm(a) {
    const name = a._[0] || fail('用法：rm <名称>');
    const store = loadStore();
    getProvider(store, name);
    if (name === 'official') fail('official 是"删净所有 ANTHROPIC_*"的语义锚点，不可删除');
    if (name === store.current) fail(`${name} 正在使用中，先 use 别的再删`);
    delete store.providers[name];
    saveStore(store);
    return { removed: name };
  },

  /**
   * 把"本机全局此刻正在用的那一档"复制成一个供应商档。
   *
   * 这是**显式**动作，不是自动继承——桥接首次播种一律剥掉供应商信息(见 sanitizeForBridgeSeed)，
   * 免得静默跑在一个档案里没有的供应商上。但人确实常需要"我全局已经配好了，照搬一份过来"，
   * 所以给一个手动入口。
   *
   * 官方订阅这一档**不需要重新登录**：它的定义就是"一个 ANTHROPIC_* 都不写"，
   * 鉴权走 ~/.claude/.credentials.json 的 OAuth 凭据，而那份凭据桥接每次启动都会从全局刷新。
   */
  async import(a) {
    const glb = readJson(SCOPES.global.settings, null) || fail(`读不到 ${SCOPES.global.settings}`);
    const env = Object.fromEntries(Object.entries(glb.env || {}).filter(([k]) => isAnthropicKey(k)));
    const official = !env.ANTHROPIC_BASE_URL;
    const name = a.flags.name || a._[0] || (official ? 'official' : guessName(env.ANTHROPIC_BASE_URL));
    const store = readJson(STORE, { current: null, providers: {} });
    const prev = store.providers[name] || {};

    store.providers[name] = official
      ? { label: a.flags.label || prev.label || 'Anthropic 官方（订阅 / OAuth，无需重新登录）',
          official: true, model: glb.model || 'opus[1m]', env: {},
          catalog: Array.from(new Set([...(prev.catalog || []), glb.model || 'opus[1m]', 'opus', 'sonnet', 'haiku'])) }
      : { label: a.flags.label || prev.label || `${name}（从本机全局配置复制）`,
          model: env.ANTHROPIC_MODEL || glb.model || null, env,
          catalog: Array.from(new Set([...(prev.catalog || []), env.ANTHROPIC_MODEL].filter(Boolean))) };

    if (!store.current) store.current = name;
    saveStore(store);
    return {
      imported: name, official,
      model: store.providers[name].model,
      baseUrl: env.ANTHROPIC_BASE_URL || null,
      note: official
        ? '官方订阅档：鉴权走已登录的 OAuth 凭据，无需重新登录，也不需要填 Key'
        : '已连同 Base URL 与 Key 一起复制',
    };
  },

  /** 把真实档案重新导出成脱敏模板（开源版用）。 */
  async example() {
    const store = loadStore();
    writeJsonAtomic(EXAMPLE, buildExample(store), { backup: false });
    return { written: EXAMPLE, providers: Object.keys(store.providers) };
  },
};

// ---------------------------------------------------------------- 人类可读输出

function renderRestart(rs) {
  const L = ['', '生效处理：'];
  if (rs.bridge) {
    if (rs.bridge.ok === false) L.push(`  桥接：未处理 — ${rs.bridge.reason}`);
    else L.push(`  桥接：${rs.bridge.killed && rs.bridge.killed.length ? `已结束会话 ${rs.bridge.killed.join(', ')}，` : ''}${rs.bridge.note}`);
  }
  if (rs.terminal) {
    const t = rs.terminal;
    if (t.killed && t.killed.length) L.push(`  终端：已结束 ${t.killed.join(', ')}（需自行重开窗口）`);
    if (t.failed && t.failed.length) L.push(`  终端：结束失败 ${t.failed.join(', ')}`);
    if (t.skippedSelf) L.push(`  终端：跳过 pid ${t.skippedSelf}（调用者自己，不自杀）`);
    if (t.note) L.push(`  终端：${t.note}`);
  }
  return L;
}

function render(cmd, r) {
  const L = [];
  if (cmd === 'status') {
    L.push('供应商 / 模型体检');
    L.push(`当前档案选定：${r.current || '(未设置)'}`);
    for (const s of r.scopes) {
      L.push('');
      L.push(`【${s.label}】`);
      if (!s.exists) { L.push('  配置文件不存在'); continue; }
      L.push(`  端点     ${s.baseUrl || '官方直连 (Max 订阅)'}`);
      L.push(`  配置模型 ${s.configuredModel || '(未指定)'}${s.provider ? `   [档案: ${s.provider}]` : ''}`);
      L.push(`  实跑模型 ${s.live ? `${s.live.model}   (最近活动 ${s.live.at})` : '(无会话记录)'}` +
        (s.liveState === 'restarted' ? '   ← 会话已按新配置重启，下次对话即按新配置运行' : ''));
      if (s.anthropicKeys.length) L.push(`  ANTHROPIC_* ${s.anthropicKeys.length} 个：${s.anthropicKeys.join(', ')}`);
    }
    if (r.warnings.length) { L.push(''); L.push('⚠ 告警'); for (const w of r.warnings) L.push(`  - ${w}`); }
    else { L.push(''); L.push('✓ 两端一致，无漂移'); }
  } else if (cmd === 'list') {
    L.push(`当前：${r.current || '(未设置)'}`);
    for (const p of r.providers) {
      L.push(`${p.current ? '▶' : ' '} ${p.name.padEnd(12)} ${String(p.model || '-').padEnd(24)} ${p.baseUrl}`);
      if (p.catalog.length > 1) L.push(`  ${''.padEnd(13)}可选模型：${p.catalog.join(', ')}`);
    }
  } else if (cmd === 'use' || cmd === 'model') {
    if (cmd === 'use') {
      const dry = (r.results || []).some((x) => x.dryRun);
      L.push(dry ? `[预演，未落盘] 若切到：${r.switched}（${r.label}）` : `已切到：${r.switched}（${r.label}）`);
      if (r.check) L.push(r.check.skipped ? `  探活：跳过 — ${r.check.skipped}` : `  探活：${r.check.ok ? `通 (${r.check.ms}ms)` : '失败 — ' + r.check.reason}`);
    } else {
      L.push(`已设模型：${r.provider} → ${r.model}${r.alias ? `（别名 ${r.alias}）` : ''}`);
    }
    for (const x of (r.results || r.applied || [])) {
      if (x.skipped) { L.push(`  ${x.scope}: 跳过 — ${x.skipped}`); continue; }
      L.push(`  ${x.label}: ${x.changed ? '已更新' : '无变化'}  模型 ${x.modelBefore || '-'} → ${x.modelAfter || '-'}`);
      if (x.removed.length) L.push(`    删除 ${x.removed.length} 个残留键：${x.removed.join(', ')}`);
      if (x.added.length) L.push(`    写入 ${x.added.length} 个键：${x.added.join(', ')}`);
    }
    if (r.restart) L.push(...renderRestart(r.restart));
  } else if (cmd === 'restart') {
    L.push(...renderRestart(r));
  } else if (cmd === 'ps') {
    L.push(`调用者自身 claude pid：${r.self || '(未知)'}`);
    const sec = (t, arr) => { L.push(`${t}：${arr.length ? '' : '无'}`); for (const p of arr) L.push(`  pid ${p.pid}${p.self ? '  ← 就是我，永不杀' : ''}`); };
    sec('桥接主进程 (node bridge/main.js)', r.bridgeNode);
    sec('桥接 claude 会话', r.bridgeClaude);
    sec('终端 claude 会话', r.terminalClaude);
  } else if (cmd === 'check') {
    for (const c of r.checks) {
      if (c.skipped) L.push(`- ${c.name}: 跳过 — ${c.skipped}`);
      else if (c.ok) L.push(`✓ ${c.name}: 通 (HTTP ${c.status}, ${c.ms}ms) ${c.model} @ ${c.baseUrl}`);
      else L.push(`✗ ${c.name}: ${c.reason}${c.detail ? ' — ' + c.detail : ''}`);
    }
  } else {
    return JSON.stringify(r, null, 2);
  }
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const isHelp = !cmd || cmd === '-h' || cmd === '--help' || cmd === 'help';
  if (isHelp || !CMDS[cmd]) {
    const help = [
      '供应商 / 模型切换底座',
      '',
      '  init [--force]                                从现有配置播种档案',
      '  import [名称] [--label <说明>]                把本机全局当前那一档复制成供应商档',
      '  list                                          列出所有供应商',
      '  status                                        双端体检：配置 vs 实跑 vs 漂移告警',
      '  use <名称>                                    切换（先探活→再落盘→再重启，顺序不可调）',
      '  model <模型> [--alias opus|sonnet|haiku|reasoning] [--provider <名>]',
      '  check [名称...]                               连通性探活',
      '  restart [--scope ...]                         不改配置，只让在跑的会话重读配置',
      '  ps                                            看在跑的会话进程（标出调用者自己）',
      '  add <名称> --url <u> --token <t> --model <m>  新增供应商',
      '  rm <名称>                                     删除供应商',
      '  example                                       重新导出脱敏模板',
      '',
      '  --scope global|bridge|both   作用端，默认 both',
      '  --kill-terminals             切换后结束终端会话（默认只结束桥接会话；调用者自己永不被杀）',
      '  --no-restart                 只改配置不动进程（改完不生效，需自行重启）',
      '  --force / --skip-check       探活失败仍切 / 直接跳过探活',
      '  --json                       输出机器可读 JSON',
    ].join('\n');
    if (!isHelp) { process.stderr.write(`未知命令：${cmd}\n\n${help}\n`); process.exit(2); }
    process.stdout.write(help + '\n');
    return;
  }
  const a = parseArgs(argv.slice(1));
  const r = await CMDS[cmd](a);
  process.stdout.write((a.flags.json ? JSON.stringify(r, null, 2) : render(cmd, r)) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write((e instanceof SwitchError ? e.message : (e && e.stack) || String(e)) + '\n');
    process.exit(1);
  });
}

// CMDS / parseArgs 一并导出：Web UI 直接复用同一套命令实现，绝不另写一份——
// 两个入口走不同代码路径，迟早会出现"CLI 切了、页面显示没切"这类对不上的行为。
module.exports = {
  syncBridge, applyProvider, sanitizeForBridgeSeed, modelMatches, buildStatus, detectLive,
  loadStore, saveStore, checkProvider, CMDS, parseArgs, SCOPES, STORE,
};
