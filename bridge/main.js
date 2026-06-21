// PocketAide — 桥接进程入口
// 飞书长连接(收消息/发卡片) <-> 伪终端(ConPTY) 驱动的 claude(复用 Max)。
// 单实例、只响应 OWNER_OPEN_ID、按顺序串行处理每一轮。
//
// 启动前提：bridge/.env 已填好 FEISHU_APP_ID / FEISHU_APP_SECRET / OWNER_OPEN_ID。
// 缺凭据时本进程会打印需要填写的字段后安全退出（不会乱回复）。

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const single = require('./lib/single-instance');
const { loadEnv, validate } = require('./lib/config');
const { Feishu, extractText, extractImage } = require('./lib/feishu');
const { PtyClaude } = require('./lib/pty-claude');

const REPO = path.join(__dirname, '..');
const HEADER = 'AI参谋';
const IMG_DIR = path.join(REPO, 'workspace', 'tmp', 'feishu-img');  // 飞书图片临时落盘处(已 gitignore,不入库)
const IMG_WAIT_MS = Number(process.env.IMG_WAIT_MS || 10000);  // 图字双向聚合窗口(毫秒)：图等字/字等图都用；⚠️ 纯文字也会等满此窗口才发

// 删单个文件, 返回"路径是否已不存在"。为何不用 fs.rmSync: 本机 Node 对仓库内文件 fs.rmSync
// 不可靠——删文件会"静默失败"(既不删也不报错), 删目录曾"硬崩溃"(exit 0xC0000409);
// 见 tools/test/scenarios.js 实测记录。改用 unlinkSync(实测有效); 删不掉(被占用等)再 rename
// 让 existsSync 立即变 false 兜底; 最后一律以 existsSync 为准如实返回, 杜绝"假报已删"。
function rmFileSync(p) {
  try { fs.unlinkSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') return true;            // 本就不存在 = 已达目标态
    try { fs.renameSync(p, p + '.del-' + Date.now()); } catch (_) {}
  }
  try { return !fs.existsSync(p); } catch (_) { return false; }
}

// 出件文件：claude 每轮把回复原文(真 markdown)写到这里；屏幕抓取会丢失 markdown
// 符号（TUI 渲染后只剩纯文字），所以优先用这个文件的原文发飞书。
// 固定单文件、覆盖写、读完即删——平时不存在，绝不本地膨胀/累积。
const OUTBOX = path.join(REPO, 'workspace', '.outbox', 'reply.md');
let outboxClearedAt = 0;                  // 本轮 clearOutbox 的时刻, 用于新鲜度判定
function clearOutbox() { outboxClearedAt = Date.now(); rmFileSync(OUTBOX); }
function takeOutbox() {
  try {
    const st = fs.statSync(OUTBOX);
    // 新鲜度防串台：只认"本轮清理之后才写出"的文件。固定单文件会被其它 claude 会话(本地开发/测试)
    // 误写，曾把别人的内容当成本轮回复(读到陈旧"5050")。早于本轮清理(留 1s 时钟容差)的一律弃用。
    if (st.mtimeMs < outboxClearedAt - 1000) {
      log('outbox 文件陈旧(mtime 早于本轮清理), 忽略以防串台, 回退抓屏');
      rmFileSync(OUTBOX);
      return null;
    }
    const s = fs.readFileSync(OUTBOX, 'utf8');
    rmFileSync(OUTBOX); // 读完即删
    return s;
  } catch (_) { return null; }
}
// 只判断、不消费：outbox 是否"本轮清理之后才写出"(新鲜)。作为 ask() 串行收尾的权威信号——
// claude 本轮把最终回复写进 outbox = 这轮真答完, 而不是靠"屏幕静默"去猜(那会和写 outbox 抢跑、
// 让产出滞留到下一轮、造成回复错位)。与 takeOutbox 的陈旧阈值同口径(留 1s 时钟容差), 不删文件。
function isOutboxFresh() {
  try { return fs.statSync(OUTBOX).mtimeMs >= outboxClearedAt - 1000; }
  catch (_) { return false; }
}

// 日志直接写文件(同步 append) + 控制台。不再依赖 shell 的 `> bridge.log` 重定向：
// 那会让进程挂在一个 cmd 控制台上、被 Ctrl+C 误杀，且 node 缓冲导致日志看不到。
// 直接写文件可靠、即时、可观测——你能据此看到每条飞书发送是否成功。
const LOG_FILE = path.join(REPO, 'bridge', 'bridge.log');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch (_) {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// === 自动清理：防日志无限增大、临时文件/旧会话存档无限堆积 ===
// 范围严格限定在 gitignore 的纯临时区, 绝不碰 knowledge/ tasks/ 或 workspace 正式产物：
//   1) bridge/bridge.log —— 单次长跑持续 append, 超上限就截断只留尾部(每次启动本就清空, 这是长跑兜底);
//   2) workspace/tmp/    —— 诊断脚本/PTY dump/测试产物, 超龄(默认 7 天)的文件与空目录删除;
//   3) workspace/.outbox/—— 正常每轮读完即删; 这里清掉异常退出残留的过期 reply.md(默认 >6 小时);
//   4) bridge/.claude-home/projects/**/*.jsonl 与 shell-snapshots/ —— claude 会话存档/shell 快照。
//      「新对话」每触发一次就把旧会话变成孤儿存档, 长期会堆积; 超龄(默认 14 天)的清掉, 但永远保留
//      最新一份(= 当前活跃会话 = -c 续接源), 哪怕它超龄也留着, 死活不切断续接。
// 全部阈值可用环境变量覆盖；启动时跑一次, 之后每 CLEAN_INTERVAL_MS 跑一次。
const TMP_DIR = path.join(REPO, 'workspace', 'tmp');
const OUTBOX_DIR = path.join(REPO, 'workspace', '.outbox');
const SESSIONS_DIR = path.join(REPO, 'bridge', '.claude-home', 'projects');         // claude 会话存档(*.jsonl)所在
const SHELLSNAP_DIR = path.join(REPO, 'bridge', '.claude-home', 'shell-snapshots'); // claude shell 快照
const TMP_TTL_MS = Number(process.env.TMP_TTL_DAYS || 7) * 86400000;            // 临时文件留存(天)
const OUTBOX_TTL_MS = Number(process.env.OUTBOX_TTL_HOURS || 6) * 3600000;      // 出件残留留存(小时)
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 14) * 86400000;   // 孤儿会话存档/快照留存(天)
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024);     // 日志大小上限(默认 5MB)
const LOG_KEEP_BYTES = Number(process.env.LOG_KEEP_BYTES || 1024 * 1024);       // 截断后保留尾部(默认 1MB)
const CLEAN_INTERVAL_MS = Number(process.env.CLEAN_INTERVAL_MS || 6 * 3600000); // 清理周期(默认 6 小时)

// 删除 dir 下 mtime 超过 ttlMs 的文件; 递归进子目录, 子目录清空且自身过龄则一并删。只在 dir 内活动。
function cleanupDirByAge(dir, ttlMs) {
  let removed = 0;
  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        removed += cleanupDirByAge(full, ttlMs);
        const st = fs.statSync(full);
        if (fs.readdirSync(full).length === 0 && now - st.mtimeMs > ttlMs) { fs.rmdirSync(full); removed++; }
      } else {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > ttlMs && rmFileSync(full)) removed++;
      }
    } catch (_) {}
  }
  return removed;
}

// 清理"会被新会话取代、可累积"的旧存档: 收集 dir 下(递归)所有匹配文件, 永远保留最新一份
// (= 当前活跃会话的存档/快照, 哪怕超龄也留, 绝不切断 -c 续接源), 其余超过 ttlMs 的删掉。
// 「新对话」每触发一次就把旧会话变成孤儿存档, 长期会堆积——这里按龄回收, 同时死守"留最新一份"。
function cleanupOrphansByAge(dir, ttlMs, match) {
  const files = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (match && !match.test(e.name)) continue;
      try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch (_) {}
    }
  })(dir);
  if (files.length <= 1) return 0;                  // 0/1 份 => 无孤儿可清(留住唯一的活跃会话)
  files.sort((a, b) => b.mtime - a.mtime);          // 新→旧; [0] 为最新, 永久保留
  const now = Date.now();
  let removed = 0;
  for (let i = 1; i < files.length; i++) {
    if (now - files[i].mtime > ttlMs) {
      if (rmFileSync(files[i].full)) removed++;
    }
  }
  return removed;
}

// bridge.log 超上限 => 只保留尾部 LOG_KEEP_BYTES(从行边界起, 不截半行), 防单次长跑日志爆涨。
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(LOG_KEEP_BYTES);
    fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, st.size - LOG_KEEP_BYTES);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    const nl = s.indexOf('\n');
    if (nl >= 0) s = s.slice(nl + 1);                        // 丢掉可能被截断的首个半行
    fs.writeFileSync(LOG_FILE, '[日志已轮转：超过上限, 仅保留近期尾部]\n' + s);
  } catch (_) {}
}

// 一次清理：日志轮转 + tmp 按龄清 + outbox 残留清。best-effort, 绝不影响主流程。
function runCleanup(reason) {
  try {
    rotateLog();
    const tmp = cleanupDirByAge(TMP_DIR, TMP_TTL_MS);
    const ob = cleanupDirByAge(OUTBOX_DIR, OUTBOX_TTL_MS);
    const sess = cleanupOrphansByAge(SESSIONS_DIR, SESSION_TTL_MS, /\.jsonl$/);  // 孤儿会话存档(留最新一份)
    const snap = cleanupOrphansByAge(SHELLSNAP_DIR, SESSION_TTL_MS, null);       // 旧 shell 快照(留最新一份)
    if (tmp || ob || sess || snap) {
      log('自动清理(' + (reason || '') + '): tmp', tmp, '/ outbox残留', ob, '/ 孤儿会话存档', sess, '/ 旧shell快照', snap);
    }
  } catch (e) { log('自动清理异常(忽略):', e.message); }
}

// 预热 kg 向量模型：后台拉起常驻嵌入守护进程(embed_daemon)，把 bge-m3 一次性装进内存。
// 首个知识查询若赶上冷启动(约14s 静默)，会被伪终端 idle 判定误判成"答完了"而截断，
// 所以桥接一启动就在无人等待时先把模型焐热——之后查询都是亚秒级，稳在 idle 窗口内。
// best-effort：失败也不影响主流程(embedder 仍会在首次调用时惰性自起，只是慢一拍)。
function prewarmKg() {
  try {
    const py = process.env.KG_PYTHON || 'python';
    const child = spawn(py, ['tools/kg/embed_daemon.py'], {
      cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (e) => log('kg 预热启动失败(忽略):', e.message));
    child.unref();
    log('kg 向量模型预热中（后台，约 10–15s 焐热）…');
  } catch (e) { log('kg 预热异常(忽略):', e.message); }
}

// 按行边界把长文本切成 <=max 的若干段；单行超长则硬切。保证不丢内容。
// fence 感知：若某段在 ``` 代码块中间被切断, 给本段补 ``` 收口、下段补 ``` 复开,
// 否则飞书卡片会把后半段当普通文本渲染(代码块破相)。语言提示在续段丢失可接受。
function chunkText(text, max) {
  const lines = String(text).split('\n');
  const raw = [];
  let cur = '';
  const push = () => { if (cur.length) { raw.push(cur); cur = ''; } };
  for (let line of lines) {
    while (line.length > max) { push(); raw.push(line.slice(0, max)); line = line.slice(max); }
    if (cur.length + line.length + 1 > max) push();
    cur += (cur.length ? '\n' : '') + line;
  }
  push();
  if (!raw.length) return [''];
  // fence 平衡：每段内行首 ``` 个数为奇 → 该段以未闭合代码块结尾, 补一行 ``` 收口,
  // 并标记下一段开头复开。复开行会令下一段 ``` 计数 +1, 逻辑自然链式传递到代码块真正结束。
  let carry = false;
  const out = [];
  for (let chunk of raw) {
    if (carry) { chunk = '```\n' + chunk; carry = false; }
    const fences = (chunk.match(/^```/gm) || []).length;
    if (fences % 2 === 1) { chunk = chunk + '\n```'; carry = true; }
    out.push(chunk);
  }
  return out;
}

// 每轮收尾：commit 兜底(覆盖 Bash 写入等 PostToolUse 钩子没匹配到的改动) + push 到 GitHub 私有仓。
// CLAUDE.md 约定 push 由桥接层每轮统一做(模型自己被 safety-guard 禁 push)。全程 best-effort:
// 失败只记日志、绝不影响已发出的回复。push 无新提交时是秒级 no-op。
function gitRun(args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '').trim(), errOut: (stderr || '').trim() });
    });
  });
}
let pushBusy = false;
async function commitAndPushRound(reason) {
  if (pushBusy) return;                       // 每轮 push 与定时兜底 push 共用此锁, 避免 git index.lock 争用
  pushBusy = true;
  try {
    await gitRun(['add', '-A']);
    await gitRun(['commit', '-m', 'auto-commit: ' + (reason || 'round end')]); // 无改动时非零退出, 忽略
    const r = await gitRun(['push']);
    if (r.code === 0) log('push 完成(' + (reason || 'round') + ')');
    else log('push 失败(忽略):', (r.errOut || r.out || '').slice(0, 200));
  } catch (e) { log('commit/push 异常(忽略):', e.message); }
  finally { pushBusy = false; }
}

// === 会话连续性(B)：重启时用 `-c` 续上"本目录最近那段对话"，并唤醒它继续 ===
// 实测本机 claude 2.1.178：`--session-id <uuid>` 不会把会话写进可 --resume 的存储(给定 id 永远
// 恢复不回来)，而普通会话(claude 自动生成 id)会正常落盘、`--resume`/`-c` 可恢复。故不固定 id，
// 改用用户最初方案 `-c`：首启(无 marker)开全新会话并落 marker；重启(有 marker)用 `claude -c` 续最近一段。
// `-c` 续的是"本 cwd 最近一段对话"——生产环境本 cwd 只有桥接这一个 claude，续到的必是桥接自己那段，
// 不读 ~/.claude、不越出本仓库。marker 在 bridge/ 下、已 gitignore；写用 writeFileSync, 删用 rmFileSync(本机 fs.rmSync 删文件不可靠)。
const RAN_MARKER = path.join(REPO, 'bridge', '.bridge-ran');
function hasRunBefore() { try { return fs.existsSync(RAN_MARKER); } catch (_) { return false; } }
function markRan() {
  try { fs.writeFileSync(RAN_MARKER, new Date().toISOString()); }
  catch (e) { log('写 .bridge-ran 失败(忽略):', e.message); }
}

// 桥接专属的 CLAUDE_CONFIG_DIR：让伪终端里的 claude 拥有独立的 projects/会话存储，从而 -c "续最近一段"
// 只命中桥接自己的会话，永不与同 cwd 的开发会话串台(曾出现飞书消息漏进开发会话的真实 bug)。
// 关键事实(均已实测)：Claude Code 按"规范化后的绝对 cwd"给会话分桶——junction 会被解析回真身, 故
// junction 无法隔离；而独立 CLAUDE_CONFIG_DIR 能真正把会话分到别处, 且把 ~/.claude 的 Max 凭据复制过来后
// 鉴权照常(零额外计费, 守住 C1)。cwd 仍钉死仓库, 故 CLAUDE.md 自动加载、相对路径/kg/outbox 全不受影响。
// 此目录在 bridge/ 下、已 gitignore；只读取(复制)~/.claude, 从不修改主配置, 不越出本仓库。
const BRIDGE_HOME = path.join(REPO, 'bridge', '.claude-home');
function prepareConfigHome() {
  try {
    fs.mkdirSync(path.join(BRIDGE_HOME, 'projects'), { recursive: true });
    const src = path.join(os.homedir(), '.claude');
    // 凭据每次都从全局刷新：Max token 会轮换, 不取最新会掉登录, 故凭据始终以全局为准。
    try { fs.copyFileSync(path.join(src, '.credentials.json'), path.join(BRIDGE_HOME, '.credentials.json')); } catch (_) {}
    // settings.json / config.json：本地优先、全局兜底。本地已存在就保留(桥接自己决定 effort 等行为,
    // 不再被全局覆盖)；本地不存在才从全局播种一次。
    // 但 settings.json 里的 ANTHROPIC_* 供应商相关 env 必须每次从全局同步——否则用户切换全局供应商
    // (改 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL 等)后，桥接这份永不更新、
    // 切不过去(实测坑:旧值留着 + .credentials.json 每次刷新的 OAuth 凭据，合力把请求推回旧供应商/官方订阅)。
    // 其它字段(hooks/plugins/effort 等)仍本地优先；config.json 也仍本地优先、播种一次。
    {
      const dstS = path.join(BRIDGE_HOME, 'settings.json');
      const srcS = path.join(src, 'settings.json');
      if (fs.existsSync(dstS) && fs.existsSync(srcS)) {
        try {
          const cur = JSON.parse(fs.readFileSync(dstS, 'utf8'));
          const glb = JSON.parse(fs.readFileSync(srcS, 'utf8'));
          if (glb.env) {
            cur.env = cur.env || {};
            for (const k of Object.keys(glb.env)) if (k.startsWith('ANTHROPIC_')) cur.env[k] = glb.env[k];
          }
          fs.writeFileSync(dstS, JSON.stringify(cur, null, 2));
        } catch (_) {}
      } else if (!fs.existsSync(dstS)) {
        try { fs.copyFileSync(srcS, dstS); } catch (_) {}
      }
      const dstC = path.join(BRIDGE_HOME, 'config.json');
      if (!fs.existsSync(dstC)) { try { fs.copyFileSync(path.join(src, 'config.json'), dstC); } catch (_) {} }
    }
    // CLAUDE_CONFIG_DIR/.claude.json 保存信任/项目元数据。首次从主配置复制(带上对本仓库的信任),
    // 之后保留桥接自己累积的会话元数据(不覆盖)，每次仅确保本仓库的信任键存在(免去信任弹窗卡住)。
    const dstJson = path.join(BRIDGE_HOME, '.claude.json');
    let j = {};
    const seed = fs.existsSync(dstJson) ? dstJson : path.join(os.homedir(), '.claude.json');
    try { j = JSON.parse(fs.readFileSync(seed, 'utf8')); } catch (_) { j = {}; }
    j.projects = j.projects || {};
    const key = REPO.replace(/\\/g, '/');                 // 信任键用正斜杠绝对路径
    const t = j.projects[key] || {};
    t.hasTrustDialogAccepted = true;
    t.hasCompletedProjectOnboarding = true;
    if (t.projectOnboardingSeenCount == null) t.projectOnboardingSeenCount = 5;
    j.projects[key] = t;
    fs.writeFileSync(dstJson, JSON.stringify(j, null, 2));
    log('已准备桥接专属 CLAUDE_CONFIG_DIR:', BRIDGE_HOME);
    return BRIDGE_HOME;
  } catch (e) {
    log('准备 CLAUDE_CONFIG_DIR 失败(回退默认 home, 可能与开发会话共桶):', e.message);
    return null;
  }
}

// 重启后唤醒提示词。设计：只让 claude "汇报"上轮状态, 绝不自动续作/写文件/落库——旧版"没完成就继续"
// 会让它埋头大干(实测一次续作 11min)、霸占桥接、甚至违规写 knowledge/。现降级为只读汇报: 完成则回"完成"
// (不打扰飞书); 没完成则一句话说清停在哪、转发给主人, 等主人回"继续"再做。
const WAKEUP_PROMPT = '系统刚刚重启。请你只用一两句话简要汇报：上一轮我们在做的是什么、做完了没。【硬性约束，必须遵守】只汇报，绝对不要继续执行、不要调用任何工具、不要写入或修改任何文件（尤其严禁写 knowledge/ 或改代码、改 skill）、不要做任何需要我二次确认的落库动作。若上一轮已彻底完成或没有未竟任务，只回"完成"两个字；若还有没做完的，用一句话说清是什么、停在哪，然后停下、等我回复"继续"再做。';

(async () => {
  rotateLog();  // 启动时按需轮转(仅超上限才截断留尾), 不再每次清空——保住上一个实例的现场, 便于排查跨重启问题
  log('=== 桥接启动 ===', 'pid=' + process.pid);
  if (!single.acquire()) {
    log('已有一个桥接实例在运行（锁文件被占用）。本次退出。');
    process.exit(0);
  }

  const cfg = loadEnv();
  const missing = validate(cfg);
  if (missing.length) {
    console.error('========================================================');
    console.error(' 飞书应用凭据未配置，桥接暂不启动。');
    console.error(' 请编辑：', cfg._path);
    console.error(' 缺少字段：', missing.join(', '));
    console.error(' 在飞书开放平台后台获取（建应用→开机器人→配权限→');
    console.error('  开长连接订阅 im.message.receive_v1→发布）。');
    console.error(' OWNER_OPEN_ID 可留空：先填这两项启动，给机器人发条消息，');
    console.error('  它会把你的 open_id 回给你，再填入 .env 重启即可。');
    console.error('========================================================');
    process.exit(0);
  }

  log('启动桥接：cwd(claude) =', REPO);
  prewarmKg();                               // 后台预热向量模型，避免首个知识查询冷启动被 idle 判定截断

  // 会话连续性：本 repo 之前跑过(有 marker) => 重启，用 `-c` 续最近一段对话；否则 => 首启，开全新会话。
  const isRestart = hasRunBefore();
  log(isRestart ? '检测到本目录曾运行过，将用 -c 续最近一段对话。' : '首次启动，将开全新会话。');

  const feishu = new Feishu({ appId: cfg.appId, appSecret: cfg.appSecret });
  // 准备桥接专属 CLAUDE_CONFIG_DIR(会话隔离 + 复制 Max 凭据)。失败则返回 null, 退回默认 home。
  const configDir = prepareConfigHome();
  // 启动方式由 startClaude() 决定(-c 续最近 / 失败则全新)，构造时不预设。
  const claude = new PtyClaude({
    cwd: REPO,                     // cwd 仍钉死仓库：CLAUDE.md 自动加载、相对路径/kg/outbox 照常
    configDir,                     // 但会话分桶到桥接专属 home，-c 只命中桥接自己的会话
    idleMs: Number(process.env.PTY_IDLE_MS || 8000),
    bootMs: Number(process.env.PTY_BOOT_MS || 9000),   // resume 需载入历史对话，给足启动窗口
    hardMs: Number(process.env.PTY_HARD_MS || 900000), // 单轮兜底安全网(15min)：长任务靠"空闲+无spinner"收尾, 不再 2min 误杀
    graceMs: Number(process.env.PTY_GRACE_MS || 30000), // 屏幕停后再等本轮 outbox 写出的宽限, 把收尾对齐到产出、消除错位
  });

  // 串行队列：同一时刻只跑一轮，保证顺序与 PtyClaude 单轮约束一致。
  const queue = [];
  let processing = false;
  // 未完成消息数(已收到、还没发出最终答案)。秒回执用它同步算出"前面还有几条"——同步 ++/--
  // 保证并发回调互相看得到, 极快连发也能给出准确排队位置。每条在 pump 收尾时回落(见 finally)。
  let pendingCount = 0;
  let pendingImage = null;   // 聚合：图先到、等字配对。{ path, openId, mid, timer }
  let pendingText = null;    // 聚合：字先到、等图配对。{ text, openId, mid, timer }
  let starting = false;            // claude.start() 进行中：抑制 exit-handler 重启(由启动流程自行兜底)
  let restarting = false;          // 恢复/唤醒期间：闸住 pump，积压的消息等恢复后再 drain
  let recoverInFlight = false;     // 防止重叠的恢复周期
  let shuttingDown = false;        // 「新对话」全量重启进行中：闸住 claude exit→恢复, 整进程退出交 tray-host 拉起
  const crashTimes = [];           // 崩溃时刻滑窗(60s)：频繁崩则放弃 resume、改开全新会话
  const seen = new Set();

  // 构造喂给 claude 的图片 prompt：绝对路径 + 可选附言。
  // 理解方式(重要)：优先用图片理解 MCP(analyze_image, 返回文本描述、不依赖模型多模态注入,
  //   从而绕过 PTY 环境下 Read 视觉不生效的命门)；仅当该 MCP 不可用时才回退到 Read 的模型视觉。
  function buildImagePrompt(imagePath, text) {
    const t = (text || '').trim();
    const base =
      '用户发来一张图片，本地路径：\n' + imagePath +
      '\n\n【如何理解这张图（按顺序，重要）】' +
      '1) 优先调用图片理解 MCP 工具 analyze_image（把上面的本地路径作为 image_source 传入），用它的返回结果理解图片；' +
      '2) 仅当该 MCP 不可用时，才改用 Read 工具的模型自带视觉查看。';
    if (t) return base + '\n\n用户附言：' + t;
    return base + '\n\n（这是单发的图片，没有附加文字。请理解后简要描述并回应。）';
  }
  // 提取错误摘要：飞书 SDK 错误常带 code/msg，普通 Error 只有 message。
  function errDetail(e) {
    return (e && e.code ? 'code=' + e.code + ' ' : '') + (e && (e.msg || e.message) ? (e.msg || e.message) : String(e || ''));
  }
  function enqueue(item) { queue.push(item); pump(); }

  async function pump() {
    if (processing || restarting) return;    // 重启/唤醒进行中，先不处理
    processing = true;
    while (queue.length) {
      if (restarting) break;                 // 处理途中进入重启 => 停下，待恢复后继续 drain
      const { openId, text, mid, imagePath } = queue.shift();   // mid: 收到消息那刻就已发出的这条专属卡片; imagePath: 图片临时路径(可选)
      try {
        clearOutbox();                       // 清掉上一轮残留，保证新鲜
        // 卡片在"收到消息"那刻就发了(排队回执或思考卡)。开始处理 => 就地更新成"思考中", 同一张卡。
        if (mid) { try { await feishu.updateCard(mid, '🤔 正在思考…', HEADER); } catch (_) {} }
        log('提问 claude:', text, 'mid=', mid);
        const scraped = await claude.ask(text, { readySignal: isOutboxFresh });
        const filed = takeOutbox();          // 优先用 claude 写出的原始 markdown
        const useFile = !!(filed && filed.trim().length);
        const reply = useFile ? filed.trim() : scraped;
        const out = reply && reply.length ? reply : '（本轮没有可提取的文本回复）';
        log('回复来源:', useFile ? 'outbox文件(原始md)' : '屏幕抓取(回退)', '长度:', out.length);
        const chunks = chunkText(out, 3500);
        // 首段就地更新这条消息的专属卡片(绝不另发新卡)；仅当答案超长时, 才把同一条答案的后续段续发。
        if (mid) await feishu.updateCard(mid, chunks[0], chunks.length > 1 ? HEADER + ` (1/${chunks.length})` : HEADER);
        else await feishu.sendCard(openId, chunks[0], HEADER);
        for (let i = 1; i < chunks.length; i++) {
          await feishu.sendCard(openId, chunks[i], HEADER + ` (${i + 1}/${chunks.length})`);
        }
        log('已发送到飞书：', chunks.length, '段, 首段 mid=', mid);
        // 答案已就绪: 发一条纯文本"任务完成提醒"触发一次新消息提醒(卡片 patch 不触发)。
        // 延迟 40s 再撤回 —— 同步撤回太快, 手机端推送来不及响应; 撤回时限 24h, 40s 远在窗内。
        // 用 setTimeout 非阻塞(不卡 pump 串行队列); .unref() 不阻止进程优雅退出。
        // 取舍: 若 40s 内进程重启, timer 会丢失、该消息残留飞书(概率低、后果轻)。
        try {
          const pingMid = await feishu.sendText(openId, '任务完成提醒');
          if (pingMid) {
            setTimeout(() => {
              feishu.recallMessage(pingMid).catch((e) => log('完成提醒延迟撤回失败(忽略):', e.message));
            }, 40000).unref();
          }
        } catch (e) { log('完成提醒发送失败(忽略):', e.message); }
        await commitAndPushRound('round');   // 本轮数据落 GitHub 私有仓(回复已发出, 不阻塞用户)
      } catch (e) {
        log('处理出错:', e.message);
        // 若正因 claude 中途崩溃而进入重启：错误卡略过，交由 5s 后的唤醒自检恢复续作，免双重打扰。
        if (restarting) {
          log('(重启中，错误卡略过，交由唤醒自检恢复)');
        } else {
          try {
            const errMsg = '处理出错：' + e.message;
            if (mid) await feishu.updateCard(mid, errMsg, HEADER);
            else await feishu.sendCard(openId, errMsg, HEADER);
          } catch (_) {}
        }
      } finally {
        pendingCount = Math.max(0, pendingCount - 1);  // 本条收尾(成功/失败/中断都减), 排队计数回落
        if (imagePath) {                                 // 图片临时文件：本轮答完(claude 已 Read)即删, 不残留; workspace/tmp TTL 兜底
          if (rmFileSync(imagePath)) log('临时图片已删:', imagePath);
          else log('⚠️ 临时图片删除失败(将由 TTL 清理):', imagePath);
        }
      }
    }
    processing = false;
  }

  // 重启后唤醒自检：注入提示词让 claude 只"汇报"上轮状态(不执行/不写文件)。回"完成"/空 => 仅记日志(不打扰飞书)；否则 => 把汇报转发给主人, 等"继续"指令。
  async function runWakeup(reason) {
    try {
      log('唤醒自检(' + reason + ')…');
      clearOutbox();
      const scraped = await claude.ask(WAKEUP_PROMPT, { readySignal: isOutboxFresh });
      const filed = takeOutbox();
      const useFile = !!(filed && filed.trim().length);
      const reply = ((useFile ? filed : scraped) || '').trim();
      const isDone = !reply || /^完成[。.!！\s]*$/.test(reply);
      if (isDone) {
        log('唤醒自检：已完成(' + JSON.stringify(reply.slice(0, 40)) + ')，不发飞书。');
        await commitAndPushRound('wakeup-done');
        return;
      }
      log('唤醒自检：上轮未完成，发汇报给主人（等"继续"指令），长度=', reply.length);
      if (cfg.ownerOpenId) {
        const notice = reply + '\n\n---\n📌 上一轮似乎没做完（以上是 claude 的汇报）。**要我继续就回复「继续」**；想换话题直接说，或发「新对话」开全新会话。';
        const chunks = chunkText(notice, 3500);
        for (let i = 0; i < chunks.length; i++) {
          const tag = chunks.length > 1 ? HEADER + ` (重启提醒 ${i + 1}/${chunks.length})` : HEADER + ' (重启提醒)';
          await feishu.sendCard(cfg.ownerOpenId, chunks[i], tag);
        }
      }
      await commitAndPushRound('wakeup-report');
    } catch (e) {
      log('唤醒自检异常(忽略):', e.message);
    }
  }

  // 上线通知：每次桥接进程成功启动并连上飞书后，主动给主人发一张"已上线"卡片(开机自启/重启后尤其有用，
  // 让你确认系统还活着、运行良好)。只发主人；发现模式(未配 open_id)不发。best-effort，失败只记日志。
  async function sendStartupNotice(resumed) {
    if (!cfg.ownerOpenId) return;
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
        ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
      const mode = resumed ? '已接续上次对话' : '全新对话';
      const body = '🟢 **AI参谋已上线**，系统运行良好。\n\n- 时间：' + ts + '\n- 状态：' + mode + '\n\n随时发消息就能用。';
      await feishu.sendCard(cfg.ownerOpenId, body, HEADER);
      log('已发送上线通知到飞书（' + mode + '）。');
    } catch (e) {
      log('发送上线通知失败(忽略):', e.message);
    }
  }

  // 「新对话」全量重启：用户发来"新对话"三字 => 不进队列、不发给 claude, 而是整桥接重启到全新会话。
  // 机制：删掉 -c 续接标记(.bridge-ran) => 本进程退出 => tray-host(3s 自愈)把 node 重新拉起 =>
  //   重启后 hasRunBefore()=false 走"首启路径": 开全新会话 + 跳过唤醒自检 + 上线卡显示"全新对话"。
  // 队列里在途的消息随进程退出一并丢弃——这正是"全部都重启"的应有之义(用户已确认)。
  // 注: 生产环境恒由 tray-host 监管, exit 后必被拉起; 脱离监管的手动直跑则只停不起(可接受的降级)。
  async function triggerNewConversation(openId) {
    if (shuttingDown) return;                  // 防连点重复触发
    shuttingDown = true;                        // 闸住 claude exit→恢复: 我们要整进程重启, 不在进程内恢复
    log('收到「新对话」指令，执行全量重启到全新会话…');
    try {
      await feishu.sendCard(openId, '🔄 收到，正在重启为**全新对话**…十几秒后回来，会给你发一张「已上线」卡片。', HEADER);
    } catch (e) { log('新对话回执卡发送失败(忽略):', e.message); }
    if (rmFileSync(RAN_MARKER)) log('.bridge-ran 已删除：重启后将开全新会话。');
    else log('⚠️ .bridge-ran 删除失败且仍存在(重启后可能仍续接旧对话)! path=' + RAN_MARKER);
    try { claude.dispose(); } catch (_) {}      // 收掉旧 claude(ConPTY), 避免重启后残留孤儿进程
    // 留 1.5s 给 dispose 的 kill(500ms) 落地 + 飞书请求收尾, 再退整进程, 交 tray-host 自愈拉起。
    setTimeout(() => { log('=== 桥接为「新对话」退出, 等待 tray-host 拉起全新会话 ==='); process.exit(0); }, 1500);
  }

  // 启动 claude：优先 `-c` 续最近一段对话；若 -c 失败(没有可续的会话 => 启动即退出)，立刻回退到
  // 全新会话。返回 { ok, resumed }。首次成功开全新会话时落 marker，此后重启一律走 -c。
  async function startClaude(preferResume) {
    starting = true;
    try {
      if (preferResume) {
        claude.continueLast = true; claude.resumeId = null; claude.sessionId = null;
        try {
          await claude.start();
          log('claude 已用 -c 续上最近一段对话。');
          return { ok: true, resumed: true };
        } catch (e) {
          log('-c 续接失败：' + e.message + ' —— 回退到全新会话。');
        }
      }
      claude.continueLast = false; claude.resumeId = null; claude.sessionId = null;
      await claude.start();
      markRan();                                   // 记录"已跑过"，之后重启都用 -c 续
      log('claude 全新会话就绪。');
      return { ok: true, resumed: false };
    } catch (e) {
      log('claude 启动失败（全新会话也起不来）：' + e.message);
      return { ok: false, resumed: false };
    } finally {
      claude.continueLast = true; claude.resumeId = null; claude.sessionId = null; // 此后一律 -c
      starting = false;
    }
  }

  // 稳态崩溃恢复(由 exit 事件触发)。startClaude 已自带 -c→全新 的单次回退；这里再加一道
  // 滑窗保护：60s 内崩≥3次则直接开全新会话(连 -c 都不试)，避免反复续一段会让它崩的对话。
  function scheduleRecover(reason) {
    if (recoverInFlight || starting) return;
    recoverInFlight = true;
    restarting = true;                       // 立刻闸住 pump，避免向已死会话发问
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && now - crashTimes[0] > 60000) crashTimes.shift();
    const tooMany = crashTimes.length >= 3;
    if (tooMany) log('claude 60s 内崩溃', crashTimes.length, '次，放弃恢复旧会话，改开全新会话。');
    setTimeout(async () => {
      let r = { ok: false, resumed: false };
      try { r = await startClaude(!tooMany); if (tooMany) crashTimes.length = 0; } catch (_) {}
      recoverInFlight = false;               // 先放开恢复锁：唤醒途中若再崩，可触发新一轮恢复
      try { if (r.ok && r.resumed) await runWakeup('claude-restart:' + reason); } catch (_) {}
      restarting = false;
      pump();                                // 恢复期间积压的消息现在可处理
    }, 5000);
  }

  // 启动期退出由 startClaude 的 start() 失败分支处理(快速回退)，不在此再触发重启，避免重复启动竞态。
  claude.on('exit', (code) => {
    if (shuttingDown) { log('claude 退出 code=', code, '（新对话全量重启中，预期内，不在进程内恢复）'); return; }
    if (starting) { log('claude 启动期退出 code=', code, '（交由启动流程处理）'); return; }
    log('claude 会话退出 code=', code, '，5s 后重启…');
    scheduleRecover('exit:' + code);
  });

  const firstUp = await startClaude(isRestart);
  if (!firstUp.ok) { log('claude 无法启动，桥接退出。'); process.exit(1); }
  log('claude 会话就绪（复用 Max，跳过权限，不卡）。');

  feishu.start(async (data) => {
    const msg = data && data.message;
    if (!msg) return;
    const sender = data.sender && data.sender.sender_id && data.sender.sender_id.open_id;

    // 去重（飞书可能重投）
    if (seen.has(msg.message_id)) return;
    seen.add(msg.message_id);
    if (seen.size > 500) seen.clear();

    // 发现模式：OWNER_OPEN_ID 未配置时，把发信人的 open_id 回给他，便于填入 .env
    if (!cfg.ownerOpenId) {
      log('【发现模式】收到消息，sender open_id =', sender);
      try {
        await feishu.sendCard(sender,
          '你的 **open_id** 是：\n`' + sender + '`\n\n把它填入 `bridge/.env` 的 `OWNER_OPEN_ID`，重启桥接后即可正常对话。',
          HEADER);
      } catch (e) { log('发现模式回复失败:', e.message); }
      return;
    }

    // 只响应你本人
    if (sender !== cfg.ownerOpenId) {
      log('忽略非主人消息，sender=', sender);
      return;
    }

    // === 图片消息：下载 + 聚合配对 ===（图字到达顺序不保证；图来时若有字在等图就合并，否则图等字）
    const imageKey = extractImage(msg);
    if (imageKey) {
      try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (_) {}
      const dest = path.join(IMG_DIR, msg.message_id + '.png');
      log('收到图片，开始下载:', msg.message_id);
      try {
        await feishu.downloadImage(msg.message_id, imageKey, dest);
      } catch (e) {
        log('图片下载失败:', errDetail(e));
        try {
          await feishu.sendCard(sender, '❌ 图片下载失败：' + errDetail(e) +
            '\n\n—— 若是权限问题，去飞书开放平台后台 → 权限管理，开「获取/读取消息中的资源文件」并发布版本，再发一次图。', HEADER);
        } catch (_) {}
        return;
      }
      log('图片下载成功:', dest);
      // 配对：有文字在等图(字先到) → 合并成一条
      if (pendingText) {
        const pt = pendingText; pendingText = null;
        if (pt.timer) clearTimeout(pt.timer);
        log('图片配对到等待中的文字，合并发送。');
        enqueue({ openId: pt.openId, text: buildImagePrompt(dest, pt.text), mid: pt.mid, imagePath: dest });
        return;
      }
      // 连发多图：前一张未等到文字的图先单发(清窗口)，再处理新图
      if (pendingImage) {
        const old = pendingImage; pendingImage = null;
        if (old.timer) clearTimeout(old.timer);
        log('连发图片：前一张未等到文字，先单发。');
        enqueue({ openId: old.openId, text: buildImagePrompt(old.path, null), mid: old.mid, imagePath: old.path });
      }
      // 新图等字
      const ahead = pendingCount;
      pendingCount += 1;
      let imid = null;
      try {
        const hint = ahead > 0 ? `📥 收到图片，前面还有 ${ahead} 条在处理…` : '🤔 收到图片，等你的文字…（' + Math.round(IMG_WAIT_MS / 1000) + ' 秒内发字会一起处理，否则单独看图）';
        imid = await feishu.sendCard(sender, hint, HEADER);
      } catch (e) { log('图片回执卡失败(忽略):', e.message); }
      const pi = { path: dest, openId: sender, mid: imid };
      pi.timer = setTimeout(() => {
        if (pendingImage !== pi) return;          // 已被文字配走，跳过
        pendingImage = null;
        log('图片未等到文字，单发。');
        enqueue({ openId: pi.openId, text: buildImagePrompt(pi.path, null), mid: pi.mid, imagePath: pi.path });
      }, IMG_WAIT_MS);
      pendingImage = pi;
      return;
    }

    const text = extractText(msg);
    if (!text) { log('忽略非文本/空消息'); return; }
    log('收到主人消息:', text);
    // 「新对话」控制指令：正文 trim 后恰好等于"新对话"三字 => 不入队、不发 claude, 直接全量重启到全新会话。
    // 严格等值匹配(避免"开个新对话""新对话。"等误触)；默认行为仍是 -c 续接, 仅此关键词触发重置。
    // 注：控制指令不进聚合窗口，立即执行(否则要干等窗口才重启)。
    if (text.trim() === '新对话') {
      log('识别到「新对话」控制指令 => 触发全量重启。');
      await triggerNewConversation(sender);
      return;
    }
    // 配对：有图片在等字(图先到) → 合并成一条(图路径 + 文字)
    if (pendingImage) {
      const pi = pendingImage; pendingImage = null;
      if (pi.timer) clearTimeout(pi.timer);
      log('文字配对到等待中的图片，合并发送。');
      enqueue({ openId: pi.openId, text: buildImagePrompt(pi.path, text), mid: pi.mid, imagePath: pi.path });
      return;
    }
    // 连发多字：前一条未等到图片的文字先单发(清窗口)，再处理新字
    if (pendingText) {
      const old = pendingText; pendingText = null;
      if (old.timer) clearTimeout(old.timer);
      log('连发文字：前一条未等到图片，先单发。');
      enqueue({ openId: old.openId, text: old.text, mid: old.mid });
    }
    // 新字等图（聚合窗口）：图字到达顺序不保证，故字也要等图。⚠️ 代价：纯文字也会等满此窗口才发。
    // 秒回执：消息一到就立刻发一张专属卡片(不等前一轮)，并把它的 id 跟这条消息绑死——之后从
    // 「收到/排队」→「思考中」→「最终答案」全程更新这同一张卡, 一条对一条, 不另发新卡、不串台。
    const ahead = pendingCount;            // 同步快照: 我之前还有几条未完成 = "前面还有 N 条"
    pendingCount += 1;
    let mid = null;
    try {
      const hint = ahead > 0
        ? `📥 收到了，前面还有 ${ahead} 条在处理，轮到就回你…`
        : '🤔 正在思考…';
      mid = await feishu.sendCard(sender, hint, HEADER);
      log(ahead > 0 ? `飞书排队回执 message_id= ${mid} (前面 ${ahead} 条)` : `飞书思考卡 message_id= ${mid}`);
    } catch (e) {
      log('发送回执卡失败(忽略):', e.message);  // 发卡失败也照常入队; pump 里 mid 为空会退回直接发答案
    }
    const pt = { text, openId: sender, mid };
    pt.timer = setTimeout(() => {
      if (pendingText !== pt) return;            // 已被图片配走，跳过
      pendingText = null;
      log('文字未等到图片，单发。');
      enqueue({ openId: pt.openId, text: pt.text, mid: pt.mid });
    }, IMG_WAIT_MS);
    pendingText = pt;
  });

  if (cfg.ownerOpenId) {
    log('飞书长连接已启动，等待你的消息（只认 open_id=' + cfg.ownerOpenId + '）。');
  } else {
    log('飞书长连接已启动【发现模式】：给机器人发任意消息，它会回你的 open_id。');
  }

  // 上线通知：主动告诉主人"已上线、运行良好"(开机/重启后确认系统活着)。放在唤醒自检之前发。
  await sendStartupNotice(firstUp.resumed);

  // 定时兜底 push：把"非飞书轮次"产生的提交(定时提醒写记录、计划任务、用户直接改文件等)也推到
  // GitHub 私有仓, 不依赖恰好有飞书消息触发每轮 push。与每轮 push 共用 pushBusy 锁, 不会重叠。
  // 前置(放在唤醒自检之前)：唤醒自检不再阻塞它们启动——旧版 await runWakeup 曾把这俩卡到 11min 后才开。
  const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS || 300000);
  setInterval(() => { commitAndPushRound('periodic'); }, PUSH_INTERVAL_MS);
  log('定时兜底 push 已开启, 间隔(ms)=', PUSH_INTERVAL_MS);

  // 自动清理：启动先跑一次(清掉积压的过期临时文件/日志), 之后每 CLEAN_INTERVAL_MS 跑一次。
  runCleanup('startup');
  setInterval(() => runCleanup('periodic'), CLEAN_INTERVAL_MS);
  log('自动清理已开启, 周期(ms)=', CLEAN_INTERVAL_MS, '临时文件留存(天)=', Math.round(TMP_TTL_MS / 86400000));

  // 进程级重启且恢复了上次对话 => 唤醒自检(只汇报、不执行)。后台跑、不 await：不阻塞启动、不霸占消息处理,
  // 于是「新对话」等指令能在唤醒期间照常进回调被处理。期间 restarting=true 闸住 pump, 完事自动 drain。
  if (firstUp.resumed) {
    restarting = true;
    runWakeup('bridge-restart').finally(() => { restarting = false; pump(); });
  }
})().catch((e) => {
  console.error('桥接启动失败:', e);
  process.exit(1);
});
