'use strict';
/**
 * 变更事件投递 —— 把"电脑上发生的改动"送进飞书对话。
 *
 * 【这是我们和纯本地任务应用的根本区别】Kairos 那类工具只有一端：你在电脑上改，改完就完了。
 * 我们是两端——电脑面板 + 飞书。你在面板上拖了张卡片，手机那头应该知道。
 *
 * 【为什么不是直接发飞书卡片】直接发（bridge/send-reminder.js 那条路）只是个通知，
 * claude 自己并不知道发生过什么；你回头在飞书问"我刚改了啥"它答不上来。
 * 所以走的是**注入提示词**：把变更写成一段话喂给会话，让 claude 自己回复，
 * 回复经由桥接原路发到飞书。这样"改动"既到了你手机上，也进了对话上下文。
 * 桥接侧已有现成范式——重启后的 runWakeup() 就是这么干的。
 *
 * 【为什么用文件投递而不是 HTTP】面板和桥接是两个进程。文件投递零依赖、不占端口、
 * 桥接没在跑时事件也不会丢（文件躺在那儿，下次启动照样能处理），比起开端口互相发现简单得多。
 *
 * 【为什么要攒一攒再发】连拖三张卡片不该炸出三轮对话——又吵又费 token。
 * 同一批操作在静默期内合并成一条，最后只打扰你一次。
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const INBOX = path.join(REPO, 'workspace', '.inbox');

// 静默期：最后一次操作之后再等这么久，期间的新操作并进同一批。
// 15 秒是"改完一组任务"的自然停顿，短了会把一次整理拆成几条，长了你会觉得没反应。
const QUIET_MS = 15000;
// 单批上限，防止一次批量操作刷出一篇长文
const MAX_ITEMS = 40;

function ensureDir() {
  try { fs.mkdirSync(INBOX, { recursive: true }); } catch (_) {}
}

/**
 * 记一条变更。面板每次写任务后调用。
 * 落成一个独立小文件（文件名带时间戳+pid+随机），避免并发写同一个文件互相盖掉。
 */
function record(event) {
  ensureDir();
  const e = { at: new Date().toISOString(), ...event };
  const f = path.join(INBOX, `evt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(e), 'utf8');
    fs.renameSync(tmp, f);      // 原子出现，桥接不会读到写了一半的文件
    return f;
  } catch (_) { return null; }
}

/** 读出当前所有待处理事件（按时间排序）。 */
function pending() {
  let files = [];
  try { files = fs.readdirSync(INBOX).filter((f) => /^evt-.*\.json$/.test(f)); } catch (_) { return []; }
  const out = [];
  for (const f of files.sort()) {
    const fp = path.join(INBOX, f);
    try { out.push({ file: fp, ...JSON.parse(fs.readFileSync(fp, 'utf8')) }); }
    catch (_) { try { fs.unlinkSync(fp); } catch (_) {} }   // 坏文件直接丢，不能卡住整条流水线
  }
  return out;
}

/** 这批事件是否已经静默够久、可以发了。 */
function isReady(evts, now = Date.now(), quietMs = QUIET_MS) {
  if (!evts.length) return false;
  const last = Math.max(...evts.map((e) => Date.parse(e.at) || 0));
  return now - last >= quietMs;
}

function clear(evts) {
  for (const e of evts) { try { fs.unlinkSync(e.file); } catch (_) {} }
}

/**
 * 把一批事件渲染成喂给 claude 的提示词。
 *
 * 措辞上刻意收得很紧：**只播报、不准动手**。否则 claude 看到"某任务被标成 done"
 * 很可能顺手就去归档、去改别的文件——用户在面板上点一下，不该触发一串它没要求的动作。
 * 这跟 runWakeup 的约束是同一个道理。
 */
function buildPrompt(evts) {
  const items = evts.slice(0, MAX_ITEMS);
  const more = evts.length > items.length ? `\n（另有 ${evts.length - items.length} 条同类改动未列出）` : '';
  const lines = items.map((e) => '- ' + describe(e)).join('\n');
  return [
    '【系统事件·非用户提问】主人刚刚在电脑上的任务面板里做了这些改动：',
    '',
    lines + more,
    '',
    '请你用一两句话向主人确认这些改动即可（就像"收到，已记下：X 标为完成"这样）。',
    '【硬性约束】只播报确认，不要执行任何后续动作：不要调用工具、不要改任何文件、',
    '不要归档、不要顺手把相关任务也改了、不要提议下一步。改动本身已经落盘了，你只负责让主人知道。',
  ].join('\n');
}

function describe(e) {
  const t = e.title || e.name || '(未知任务)';
  switch (e.kind) {
    case 'create': return `新建任务「${t}」`;
    case 'status': return `「${t}」状态 ${e.from || '—'} → ${e.to}`;
    case 'progress': return `给「${t}」补了一条进度：${truncate(e.text, 60)}`;
    case 'fields': return `改了「${t}」的${(e.changes || []).map((c) => `${fieldName(c.field)}（${c.from || '空'}→${c.to || '空'}）`).join('、')}`;
    case 'next': return `改了「${t}」的下一步计划：${truncate(e.to, 60) || '（清空）'}`;
    case 'archive': return `把「${t}」归档了`;
    case 'delete': return `删除任务「${t}」`;
    default: return `改动了「${t}」`;
  }
}

const FIELD_CN = { status: '状态', horizon: '周期', priority: '优先级', project: '项目', deadline: '截止日', completed: '完成时间' };
const fieldName = (f) => FIELD_CN[f] || f;
const truncate = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };

// ---------------------------------------------------------------- 联动健康度
//
// 【为什么需要这个】写完集成代码、单测全绿，可飞书那头一条都没收到——因为跑着的桥接
// 进程是代码改动之前启动的，Node 只在 require 时读一次文件。这种"文件是新的、进程是旧的"
// 断层，测试照不出来（测试读的是磁盘上的源码），只能靠运行时自己发现。
//
// 判据两条，任一不满足就说明面板→飞书这条线现在是断的：
//   1. 桥接进程还活着（.bridge.lock 里的 pid）
//   2. 桥接的启动时间晚于集成代码的最后修改时间（否则它加载的是旧版本）
// 再加一条软信号：有事件在 inbox 里躺过了静默期还没被取走，说明没人在消费。

const LOCK_FILE = path.join(REPO, 'bridge', '.bridge.lock');
// 桥接侧参与这条链路的文件。任何一个比桥接进程新，就说明跑着的那份是旧代码。
const LINK_SOURCES = [path.join(REPO, 'bridge', 'main.js'), __filename];

function linkHealth(now = Date.now()) {
  let pid = 0, startedAt = 0;
  try {
    pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) || 0;
    startedAt = fs.statSync(LOCK_FILE).mtimeMs;       // lock 是启动时写的，mtime 即启动时刻
  } catch (_) {}

  let alive = false;
  if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; } }

  let newestSrc = 0, staleFile = '';
  for (const f of LINK_SOURCES) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > newestSrc) { newestSrc = m; staleFile = path.relative(REPO, f).replace(/\\/g, '/'); }
    } catch (_) {}
  }
  const codeStale = alive && startedAt > 0 && newestSrc > startedAt;

  const evts = pending();
  const oldest = evts.length ? Math.min(...evts.map((e) => Date.parse(e.at) || now)) : 0;
  // 静默期 + 一分钟宽限还没被取走 = 没人在消费这个队列
  const backedUp = !!oldest && now - oldest > QUIET_MS + 60000;

  const ok = alive && !codeStale && !backedUp;
  let reason = '';
  if (!pid) reason = '桥接没有在运行（找不到 .bridge.lock）——面板上的改动不会出现在飞书里。';
  else if (!alive) reason = `桥接进程已退出（pid ${pid}）——面板上的改动不会出现在飞书里。`;
  else if (codeStale) reason = `桥接进程比联动代码旧（进程起于 ${fmtTime(startedAt)}，${staleFile} 改于 ${fmtTime(newestSrc)}）` +
    '——它加载的是改动前的版本，联动不会生效。重启托盘即可。';
  else if (backedUp) reason = `有 ${evts.length} 条改动在队列里积压了 ${Math.round((now - oldest) / 60000)} 分钟没被取走——桥接可能卡住了。`;

  return { ok, reason, pid, alive, codeStale, backedUp, pending: evts.length, startedAt, newestSrc };
}

const fmtTime = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

module.exports = { record, pending, isReady, clear, buildPrompt, describe, linkHealth, INBOX, QUIET_MS, MAX_ITEMS };
