'use strict';
/**
 * 任务数据层 —— 把 tasks/*.md 与 JS 对象互相转换。
 *
 * 【最硬的约束：读写往返必须无损】serialize(parse(x)) === x，对仓库里每一个任务文件都成立。
 * 面板要能改任务（拖卡片、补进度、改字段），而任务文件是用户的真资产：里面有优先级链、
 * 引用块、[[wikilink]]、手写的段落。任何"解析成结构化对象再吐回去"的实现，只要没做无损，
 * 第一次写入就会把这些东西吃掉——而且是静默吃掉，等发现时已经覆盖了。
 * 所以本模块的原则是：**认识的部分结构化，不认识的部分原样留着**（intro / tail / 每条的 raw）。
 * 单测 U9 拿全部真实任务文件跑往返校验，改坏了会立刻红。
 *
 * 【为什么不用 YAML / markdown 库】frontmatter 只有 5 个标量字段，正文结构固定成三段；
 * 引第三方库反而会重排键序、规范化引号、吃掉空行——正是要避免的那类"好心的破坏"。
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ACTIVE = path.join(REPO, 'tasks', 'active');
const ARCHIVE = path.join(REPO, 'tasks', 'archive');

const H_PROGRESS = '## 当前进度';
const H_NEXT = '## 下一步计划';

// frontmatter 里我们理解的字段。写回时按这个顺序排，未知字段原样附在后面（不丢）。
const FM_ORDER = ['type', 'status', 'horizon', 'priority', 'project', 'deadline', 'created', 'completed'];

const STATUSES = ['running', 'blocked', 'done', 'cancelled'];
const HORIZONS = ['短期', '中期', '长期', '未来'];
const PRIORITIES = ['高', '中', '低'];

// ---------------------------------------------------------------- 解析

/**
 * 解析一个任务 md。任何一段没认出来的内容都会落进 intro / tail / raw，不会丢。
 * 换行风格（CRLF/LF）与结尾有没有换行也一并记住，否则写回时整文件会显示成"全变了"。
 */
function parse(md, name) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = /\r?\n$/.test(md);
  const text = md.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  let i = 0;
  const fm = {};
  const fmKeys = [];        // 原始键序。写回时照它排——重排键序会让 git diff 显示成整块改动
  const fmUnknown = [];
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') {
      const line = lines[i];
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (m) { fm[m[1]] = m[2].trim(); fmKeys.push(m[1]); }
      else if (line.trim()) fmUnknown.push(line);   // 不认识的行原样留着
      i++;
    }
    i++;                                            // 跳过收尾的 ---
  }

  // 标题：frontmatter 之后第一个 # 开头的行
  let title = '';
  let titleIdx = -1;
  for (let j = i; j < lines.length; j++) {
    if (/^#\s+/.test(lines[j])) { title = lines[j].replace(/^#\s+/, '').trim(); titleIdx = j; break; }
    if (lines[j].startsWith('## ')) break;          // 没有标题就直接进小节了
  }

  const pIdx = lines.findIndex((l) => l.trim() === H_PROGRESS);
  const nIdx = lines.findIndex((l) => l.trim() === H_NEXT);

  // intro = 标题之后、第一个小节之前的自由内容（优先级链、引用块、wikilink 说明……）
  const firstSection = [pIdx, nIdx].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  const introStart = titleIdx >= 0 ? titleIdx + 1 : i;
  const introEnd = firstSection !== undefined ? firstSection : lines.length;
  // 存成行数组而不是字符串：空行本身就是有意义的一行，用字符串存会被 falsy 判断吃掉，
  // 往返就少一个换行——34 个文件当场全挂。这类"看不见的字符"正是无损最容易翻车的地方。
  const intro = introStart < introEnd ? lines.slice(introStart, introEnd) : [];

  const progEnd = nIdx > pIdx ? nIdx : lines.length;
  const progress = pIdx >= 0 ? parseProgress(lines.slice(pIdx + 1, progEnd)) : { items: [], lead: [], trail: [] };

  // 下一步计划之后如果还有别的小节，整段算 tail 原样保留
  let nextEnd = lines.length;
  if (nIdx >= 0) {
    for (let j = nIdx + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) { nextEnd = j; break; }
    }
  }
  const next = nIdx >= 0 ? parseList(lines.slice(nIdx + 1, nextEnd)) : { items: [], lead: [], trail: [] };
  const tail = nIdx >= 0 && nextEnd < lines.length ? lines.slice(nextEnd) : [];

  return {
    name: name || '',
    eol, endsWithEol,
    fm, fmKeys, fmUnknown,
    title, hasTitle: titleIdx >= 0,
    intro,
    hasProgress: pIdx >= 0, progress,
    hasNext: nIdx >= 0, next,
    tail,
    // 便捷视图（只读，不参与序列化）
    get status() { return fm.status || ''; },
    get horizon() { return fm.horizon || ''; },
  };
}

/** 进度条目：`- [YYYY-MM-DD HH:MM] 正文`。认不出时间戳的行原样留着，仍算一条。 */
function parseProgress(lines) {
  const l = parseList(lines);
  l.items = l.items.map((it) => {
    const m = /^-\s*\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\]\s*([\s\S]*)$/.exec(it.raw);
    return m
      ? { ...it, date: m[1], time: m[2] || '', text: m[3].trim() }
      : { ...it, date: '', time: '', text: it.raw.replace(/^-\s*/, '') };
  });
  return l;
}

/**
 * 小节里的列表。**续行归属上一条**（条目可能写成多行），这样往返才不会把多行条目拆散。
 * lead/trail 分别是小节标题后、列表结束后的空白，原样记住。
 */
function parseList(lines) {
  const items = [];
  let lead = [], trail = [], started = false;
  const flushTrail = () => {
    // 条目之间的空行归属**上一条**——直接丢掉的话，写回时那些空行就没了。
    if (trail.length && items.length) items[items.length - 1].raw += '\n' + trail.join('\n');
    trail = [];
  };
  for (const line of lines) {
    // 只有顶格的 `- ` 才算新条目。缩进的 `  - 子项` 属于上一条，
    // 否则既会把一条拆成好几条（进度条数虚高），语义上也不对。
    if (/^-\s/.test(line)) { flushTrail(); items.push({ raw: line }); started = true; continue; }
    if (!started) { lead.push(line); continue; }
    if (line.trim() === '') { trail.push(line); continue; }
    if (trail.length) { items[items.length - 1].raw += '\n' + trail.join('\n') + '\n' + line; trail = []; }
    else items[items.length - 1].raw += '\n' + line;   // 续行 / 缩进子项
  }
  return { items, lead, trail };
}

// ---------------------------------------------------------------- 序列化

/** 写回 md。必须满足 serialize(parse(x)) === x。 */
function serialize(t) {
  const out = [];
  // 键序 = 原文件的顺序（还存在的），后面才追加本次新增的。
  // 不能按 FM_ORDER 强排：那会把 `created` 挪到 `horizon` 后面，明明没改内容，
  // git diff 却显示整个 frontmatter 都变了，往返校验也当场失败。
  const old = (t.fmKeys || []).filter((k) => t.fm[k] !== undefined);
  const keys = [...old, ...FM_ORDER.filter((k) => t.fm[k] !== undefined && !old.includes(k)),
                ...Object.keys(t.fm).filter((k) => !old.includes(k) && !FM_ORDER.includes(k))];
  if (keys.length || t.fmUnknown.length) {
    out.push('---');
    for (const k of keys) out.push(`${k}: ${t.fm[k]}`);
    for (const l of t.fmUnknown) out.push(l);
    out.push('---');
    out.push('');
  }
  if (t.hasTitle) out.push(`# ${t.title}`);
  out.push(...t.intro);
  if (t.hasProgress) { out.push(H_PROGRESS); pushList(out, t.progress); }
  if (t.hasNext) { out.push(H_NEXT); pushList(out, t.next); }
  out.push(...t.tail);

  let s = out.join('\n');
  if (t.endsWithEol && !s.endsWith('\n')) s += '\n';
  return t.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
}

function pushList(out, l) {
  out.push(...l.lead);
  for (const it of l.items) out.push(it.raw);
  out.push(...l.trail);
}

// ---------------------------------------------------------------- 读写

const isTaskFile = (f) => f.endsWith('.md');

function listDir(dir, bucket) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(isTaskFile); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const md = fs.readFileSync(path.join(dir, f), 'utf8');
      const t = parse(md, f.replace(/\.md$/, ''));
      t.bucket = bucket;
      t.file = path.join(dir, f);
      out.push(t);
    } catch (_) {}
  }
  return out;
}

const loadAll = () => [...listDir(ACTIVE, 'active'), ...listDir(ARCHIVE, 'archive')];

function loadOne(name, bucket) {
  const dir = bucket === 'archive' ? ARCHIVE : ACTIVE;
  const file = path.join(dir, name + '.md');
  const md = fs.readFileSync(file, 'utf8');
  const t = parse(md, name);
  t.bucket = bucket || 'active';
  t.file = file;
  return t;
}

/** 原子写：同盘 rename，写到一半断电也不会留下半个任务文件。 */
function save(t) {
  const md = serialize(t);
  const tmp = `${t.file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, md, 'utf8');
  fs.renameSync(tmp, t.file);
  return md;
}

// ---------------------------------------------------------------- 派生视图

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 末次活动时刻：取进度里最新的时间戳，没有就退回 created。 */
function lastActivity(t) {
  const ds = t.progress.items.map((x) => x.date).filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : (t.fm.created || '').slice(0, 10);
}

/** 停滞天数。面板最核心的一个数——平铺列表里看不出来的东西，就靠它变红。 */
function staleDays(t, now = new Date()) {
  const last = lastActivity(t);
  if (!last) return null;
  const d = Math.floor((startOfDay(now) - startOfDay(new Date(last))) / 864e5);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** 距截止还剩几天；负数=已过期；无 deadline 返回 null。 */
function daysLeft(t, now = new Date()) {
  const dl = (t.fm.deadline || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dl)) return null;
  return Math.round((startOfDay(new Date(dl)) - startOfDay(now)) / 864e5);
}

/** 交给前端的扁平视图。绝不把 raw 全文塞进去——列表页只要摘要。 */
function toView(t, now = new Date()) {
  return {
    name: t.name,
    bucket: t.bucket,
    title: t.title || t.name,
    status: t.fm.status || '',
    horizon: t.fm.horizon || '',
    priority: t.fm.priority || '',
    project: t.fm.project || '',
    deadline: t.fm.deadline || '',
    created: t.fm.created || '',
    completed: t.fm.completed || '',
    lastActivity: lastActivity(t),
    staleDays: staleDays(t, now),
    daysLeft: daysLeft(t, now),
    progressCount: t.progress.items.length,
    nextFirst: t.next.items.length ? t.next.items[0].raw.replace(/^\s*-\s*/, '').split('\n')[0] : '',
    links: [...new Set((JSON.stringify(t.intro) + JSON.stringify(t.next.items) + JSON.stringify(t.progress.items))
      .match(/\[\[([^\]]+)\]\]/g) || [])].map((s) => s.slice(2, -2)),
  };
}

/** 详情视图：多给 intro / 进度全条目 / 下一步全条目。 */
function toDetail(t, now = new Date()) {
  return {
    ...toView(t, now),
    intro: t.intro.join('\n').trim(),
    progress: t.progress.items.map((x) => ({ date: x.date, time: x.time, text: x.text })),
    next: t.next.items.map((x) => x.raw.replace(/^\s*-\s*/, '')),
  };
}

// ---------------------------------------------------------------- 变更

/** 往「当前进度」追加一条带时间戳的记录。小节不存在就建出来。 */
function appendProgress(t, text, when = new Date()) {
  const line = `- [${stamp(when)}] ${String(text).trim()}`;
  if (!t.hasProgress) { t.hasProgress = true; t.progress = { items: [], lead: [], trail: [] }; }
  t.progress.items.push({ raw: line, date: stamp(when).slice(0, 10), time: stamp(when).slice(11), text: String(text).trim() });
  return line;
}

/**
 * 改字段。改 status 时**自动补一条进度**——否则任务会"状态变了但没人知道为什么变"，
 * 而进度流正是这个任务库最有价值的东西，不能因为多了个网页入口就被绕过去。
 */
function setFields(t, patch, when = new Date()) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!FM_ORDER.includes(k) || k === 'type' || k === 'created') continue;
    const old = t.fm[k] || '';
    const nv = v === null || v === undefined ? '' : String(v).trim();
    if (old === nv) continue;
    if (nv) t.fm[k] = nv; else delete t.fm[k];
    changed.push({ field: k, from: old, to: nv });
  }
  if (patch.status && patch.status !== undefined) {
    const hit = changed.find((c) => c.field === 'status');
    if (hit) {
      if (patch.status === 'done' && !t.fm.completed) t.fm.completed = stamp(when);
      if (patch.status !== 'done') delete t.fm.completed;
      appendProgress(t, `状态 ${hit.from || '—'} → ${hit.to}（面板操作）`, when);
    }
  }
  return changed;
}

/** 新建任务。文件名即标识，冲突直接拒绝——绝不覆盖已有任务。 */
function create({ name, title, status = 'running', horizon = '短期', project, priority, deadline, plan }, when = new Date()) {
  const clean = String(name || title || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!clean) throw new Error('任务名不能为空');
  const file = path.join(ACTIVE, clean + '.md');
  if (fs.existsSync(file)) throw new Error(`任务已存在：${clean}`);
  const fm = { type: 'task', status, horizon, created: stamp(when) };
  if (priority) fm.priority = priority;
  if (project) fm.project = project;
  if (deadline) fm.deadline = deadline;
  const t = {
    name: clean, eol: '\n', endsWithEol: true, fm, fmKeys: Object.keys(fm), fmUnknown: [],
    title: (title || clean).trim(), hasTitle: true, intro: [''],
    hasProgress: true, progress: { items: [], lead: [], trail: [''] },
    hasNext: true, next: { items: [], lead: [], trail: [] },
    tail: [], bucket: 'active', file,
  };
  appendProgress(t, '登记。（面板创建）', when);
  if (plan) for (const p of String(plan).split('\n').map((x) => x.trim()).filter(Boolean)) t.next.items.push({ raw: `- ${p}` });
  save(t);
  return t;
}

// ---------------------------------------------------------------- 体检

const STALE_DAYS = 30;

/**
 * 任务库体检。这几条正是纯文本列表看不出来、而面板与每周推送都要用的东西。
 */
function healthCheck(all, now = new Date()) {
  const act = all.filter((t) => t.bucket === 'active');
  const running = act.filter((t) => (t.fm.status || '') === 'running');
  const stale = running
    .map((t) => ({ name: t.name, title: t.title || t.name, days: staleDays(t, now) }))
    .filter((x) => x.days !== null && x.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);
  const overdue = act
    .map((t) => ({ name: t.name, title: t.title || t.name, left: daysLeft(t, now), status: t.fm.status }))
    .filter((x) => x.left !== null && x.status !== 'done' && x.status !== 'cancelled' && x.left < 0)
    .sort((a, b) => a.left - b.left);
  const dueSoon = act
    .map((t) => ({ name: t.name, title: t.title || t.name, left: daysLeft(t, now), status: t.fm.status }))
    .filter((x) => x.left !== null && x.status !== 'done' && x.status !== 'cancelled' && x.left >= 0 && x.left <= 7)
    .sort((a, b) => a.left - b.left);
  return {
    counts: countBy(act),
    stale, overdue, dueSoon,
    duplicates: findDuplicates(act),
    staleThreshold: STALE_DAYS,
  };
}

function countBy(act) {
  const c = { total: act.length };
  for (const s of STATUSES) c[s] = act.filter((t) => (t.fm.status || '') === s).length;
  return c;
}

/**
 * 疑似重复任务。做法刻意保守：只按标题里的**词**重合度判，宁可漏报也不要乱报——
 * 误报会让人立刻不信任这个提示，然后连真的重复也一起忽略。
 */
function findDuplicates(act) {
  const live = act.filter((t) => ['running', 'blocked'].includes(t.fm.status || ''));
  const toks = (s) => new Set(
    String(s).toLowerCase()
      .replace(/[【】\[\]（）()：:，,。.、\/\-_]/g, ' ')
      .split(/\s+/).flatMap((w) => (/^[a-z0-9]+$/.test(w) ? [w] : splitCjk(w)))
      .filter((w) => w.length >= 2)
  );
  const sets = live.map((t) => toks(t.title || t.name));

  // 连通分量（并查集），不是"贪心配对后标记已用"。实测那样会漏：三个 GitHub 任务里
  // A~B 先配上并被标记，轮到 C 时 A、B 已不参与比较，C 就落单了——可 C~A 明明成立。
  const parent = live.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent[a] = b; };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) if (similar(sets[i], sets[j])) union(i, j);
  }
  const byRoot = new Map();
  live.forEach((t, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push({ name: t.name, title: t.title || t.name });
  });
  return [...byRoot.values()].filter((g) => g.length > 1);
}

/**
 * 判定两个标题是否疑似重复。
 *
 * 不用"交集 / 较短集合"那种比例：标题长短一差，比例就被稀释。实测
 * 「整理电脑上的 GitHub 项目」vs「给自己弄一个合适的 GitHub 项目管理」共享 {github, 项目}，
 * 比例只有 2/7，按 0.5 的门槛会被判成不相关——可它俩明明是同一件事。
 *
 * 改成看**绝对共享量 + 信号强度**：共享 ≥2 个词，且其中至少有一个英文/数字词
 * （GitHub 这类专有名词信号强），或者共享到 ≥3 个词。纯中文 2-gram 的偶然碰撞
 * （「优化个人简历」与「整理 GitHub 个人主页」只共享「个人」）够不到这个线，不会误报。
 */
function similar(a, b) {
  const inter = [...a].filter((x) => b.has(x));
  if (inter.length < 2) return false;
  const dice = (2 * inter.length) / (a.size + b.size);   // Dice：对两边长度都敏感，不像 min-overlap 那样偏袒短标题
  return dice >= 0.25;
}

// 中文功能字。含这些字的 2-gram 直接丢弃——它们全是跨词边界的噪音。
// 「给自己弄一个合适的 GitHub 项目管理」光这个口语前缀就能产出 8 个无意义 gram，
// 把真正的信号（github、项目）稀释到判不出重复。
const STOP_CJK = new Set('的了着过和与或及把被给让从到在上下里外个些这那哪就也都还很太最不没要会能可一二三之其此我你他它们为对所以又更再'.split(''));

/** 中文按 2-gram 切，避免"GitHub项目"整串比不上"GitHub个人主页"。 */
function splitCjk(w) {
  const cjk = w.replace(/[^一-龥]/g, '');
  const latin = w.match(/[a-z0-9]+/g) || [];
  const grams = [], raw = [];
  for (let i = 0; i + 1 < cjk.length; i++) {
    const g = cjk.slice(i, i + 2);
    raw.push(g);
    if (!STOP_CJK.has(g[0]) && !STOP_CJK.has(g[1])) grams.push(g);
  }
  // 全被过滤光时回退到不过滤，免得短标题变成空集合、永远判不出重复
  return [...latin, ...(grams.length ? grams : raw)];
}

module.exports = {
  parse, serialize, loadAll, loadOne, save, create,
  toView, toDetail, appendProgress, setFields,
  lastActivity, staleDays, daysLeft, healthCheck, findDuplicates,
  stamp, ACTIVE, ARCHIVE, STATUSES, HORIZONS, PRIORITIES, FM_ORDER, STALE_DAYS,
};
