// 工具层单元测试：直接验证各 skill 背后接的"真实代码"，不经过 claude —— 确定性强、跑得快。
// 与 scenarios.js(经伪终端=飞书 的端到端) 互补：这里钉死底层契约，那边验对话流程。
//
// 覆盖（对照 01-用户功能规格书.md）：
//   U1  kg 知识图谱：索引→检索→概览            (场景二 2a 底层 / 场景一写入后可查回)
//   U2  任务归档生命周期 + 安全底线"未完成绝不删" (场景三 生命周期)
//   U3  定时提醒：注册→存在→取消                (场景三 3e 底层)
//   U4  视频字幕提取：输出契约 + 真实尝试        (场景一 1c 底层)
//   U5  知识库 = 合法 Obsidian vault(markdown+git) (场景二 2b)
//   U6  数据安全：autocommit 钩子已接 + git 健康  (跨场景 数据安全)
//
// 用法: node tools/test/units.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const TMP = path.join(REPO, 'workspace', 'tmp', 'units-' + Date.now()); // gitignored, 仓库内, 跑完即删

// 递归删目录: 本机 fs.rmSync(recursive) 会硬崩溃(0xC0000409), 改用 PowerShell Remove-Item(中文/递归稳妥)。
function rmrfDir(dir) {
  if (!fs.existsSync(dir)) return;
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Remove-Item -LiteralPath '" + dir + "' -Recurse -Force -ErrorAction SilentlyContinue"], { encoding: 'utf8' }); } catch (_) {}
}

// ---- 迷你测试器 ----
const results = [];
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, err: e.message }); console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function py(args, opts = {}) {
  return execFileSync('python', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
}
function psFile(file, args) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' });
}
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

fs.mkdirSync(TMP, { recursive: true });

// ===== U1 kg 知识图谱：索引→检索→概览 =====
test('U1 kg 索引→检索→概览', () => {
  const kroot = path.join(TMP, 'kg-knowledge');
  const kdb = path.join(TMP, 'kg.db');
  fs.mkdirSync(path.join(kroot, 'ai'), { recursive: true });
  fs.writeFileSync(path.join(kroot, 'ai', '2026-06-16-conpty.md'),
    '---\ntype: knowledge\ntags: [ConPTY, 终端]\nsource: 单元测试\ncreated: 2026-06-16\n---\n\n' +
    '# ConPTY 伪终端复用 Max 零额外费用\n\n## 摘要\n- ConPTY 让子进程以为自己连着真终端，从而复用 Max 订阅、零额外 API 费用。\n', 'utf8');
  const env = { ...process.env, KG_KNOWLEDGE_ROOT: kroot, KG_DB: kdb };
  // 索引（不细抠输出形状，靠后续 search 证明确实索引成功）
  py([path.join(REPO, 'tools', 'kg', 'kg.py'), 'index', '--all'], { env });
  // 检索：能命中刚写入的主题
  const sr = JSON.parse(py([path.join(REPO, 'tools', 'kg', 'kg.py'), 'search', 'ConPTY 复用 Max 零费用', '--k', '5'], { env }));
  assert(Array.isArray(sr) && sr.length >= 1, 'search 应有命中, 实得: ' + JSON.stringify(sr).slice(0, 120));
  assert(sr.some((h) => ((h.title || '') + (h.snippet || '')).includes('ConPTY')), 'search 命中应含主题 ConPTY');
  // 概览：节点计数 >=1
  const ov = JSON.parse(py([path.join(REPO, 'tools', 'kg', 'kg.py'), 'overview'], { env }));
  assert((ov.total_nodes || 0) >= 1, 'overview total_nodes 应 >=1, 实得: ' + JSON.stringify(ov).slice(0, 120));
});

// ===== U2 任务归档生命周期 + 安全底线 =====
test('U2 任务归档：超期done归档 / 未完成绝不删 / 保留期内不动', () => {
  const active = path.join(TMP, 'tasks-active');
  const archive = path.join(TMP, 'tasks-archive');
  fs.mkdirSync(active, { recursive: true });
  // 超期已完成(10天前) -> 应归档。用 task-manage SKILL 的"真实"任务格式(## 当前进度 追加式 + ✅完成),
  // 而非 ## 目标/## 结果 —— 后者曾掩盖 archive.py 提取不到真实格式"做了什么"的 bug。
  fs.writeFileSync(path.join(active, 'old-done.md'),
    `---\ntype: task\nstatus: done\ncreated: 2026-05-01 09:00\ncompleted: ${fmt(new Date(Date.now() - 10 * 86400000))}\n---\n\n# 旧已完成任务\n\n## 当前进度\n- [2026-05-01 09:00] 开始：验证归档摘要提取\n- [2026-05-02 10:00] 跑通归档脚本回归\n- ✅ 完成 [2026-05-02 11:00]\n\n## 下一步计划\n- 无\n`, 'utf8');
  // 进行中 -> 绝不碰
  fs.writeFileSync(path.join(active, 'running.md'),
    '---\ntype: task\nstatus: running\ncreated: 2026-06-01 09:00\n---\n\n# 进行中任务\n\n## 当前进度\n- 还在做\n', 'utf8');
  // 近期完成(1天前) -> 保留期内, 跳过
  fs.writeFileSync(path.join(active, 'recent-done.md'),
    `---\ntype: task\nstatus: done\ncreated: 2026-06-14 09:00\ncompleted: ${fmt(new Date(Date.now() - 1 * 86400000))}\n---\n\n# 近期完成任务\n\n## 结果\n刚完成\n`, 'utf8');

  const out = JSON.parse(py([path.join(REPO, 'tools', 'tasks', 'archive.py'), '--days', '7', '--active-dir', active, '--archive-dir', archive]));
  const archived = (out.archived || []).map((e) => e.file);
  const skipped = (out.skipped || []).map((e) => e.file);

  assert(archived.includes('old-done.md'), '超期 done 应被归档, archived=' + JSON.stringify(archived));
  assert(!fs.existsSync(path.join(active, 'old-done.md')), '归档后应从 active 移除');
  assert(fs.existsSync(path.join(archive, 'old-done.md')), '归档摘要应落到 archive/');
  const archMd = fs.readFileSync(path.join(archive, 'old-done.md'), 'utf8');
  assert(archMd.includes('## 摘要'), '归档文件应保留摘要');
  // 关键：摘要必须从真实任务格式(## 当前进度)提取到"做了什么", 而不仅剩完成时间(此前的 bug)。
  assert(/验证归档摘要提取|归档脚本回归|完成/.test(archMd), '归档摘要应含进度内容(做了什么), 实得: ' + archMd.replace(/\n/g, ' '));
  // —— 安全底线 ——
  assert(skipped.includes('running.md'), 'running 必须出现在 skipped');
  assert(fs.existsSync(path.join(active, 'running.md')), '安全底线：running 绝不被删除/移动');
  assert(skipped.includes('recent-done.md'), '保留期内 done 应跳过');
  assert(fs.existsSync(path.join(active, 'recent-done.md')), '保留期内 done 不应被移动');
});

// ===== U3 定时提醒：注册→存在→取消 =====
test('U3 定时提醒 注册→存在→取消', () => {
  const slug = 'aiunit-' + String(Date.now()).slice(-7);
  const taskName = 'PocketAide-Remind-' + slug;
  const at = fmt(new Date(Date.now() + 3600 * 1000)); // 1小时后, 测试期间不会触发
  let registered = false;
  try {
    psFile(path.join(REPO, 'scripts', 'register-reminder.ps1'),
      ['-Name', slug, '-Text', 'unit test reminder (safe to delete)', '-Title', 'unittest', '-Mode', 'once', '-At', at]);
    registered = true;
    const exists = ps(`if (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`).trim();
    assert(exists === 'YES', '注册后计划任务应存在: ' + taskName);
  } finally {
    if (registered) { try { psFile(path.join(REPO, 'scripts', 'cancel-reminder.ps1'), ['-Name', slug]); } catch (_) {} }
  }
  const gone = ps(`if (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue) { 'STILL' } else { 'GONE' }`).trim();
  assert(gone === 'GONE', '取消后计划任务应消失: ' + taskName);
});

// U4 视频转写 无单元测试：video-transcribe 已落地并更名 douyin-transcribe(抖音→豆包办公任务+剪贴板取回),
// 全程依赖真实调试浏览器/豆包账号/系统剪贴板, 无法 headless 自动化, 故不在本单测套件覆盖。

// ===== U5 知识库 = 合法 Obsidian vault =====
test('U5 知识库 = 合法 Obsidian vault (markdown + git 同步)', () => {
  assert(fs.existsSync(path.join(REPO, '.git')), '应是 git 仓库(Obsidian 经 GitHub 私有仓多设备同步)');
  assert(fs.existsSync(path.join(REPO, 'knowledge')), 'knowledge/ 目录应存在(vault 主体)');
  const walk = (d) => {
    let o = []; let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return o; }
    for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) o = o.concat(walk(f)); else if (e.name.endsWith('.md')) o.push(f); }
    return o;
  };
  const isValidNote = (t) => /^---\s*\r?\n[\s\S]*?\r?\n---/.test(t) && /type:\s*knowledge/.test(t);
  const mds = walk(path.join(REPO, 'knowledge'));
  for (const f of mds) {
    assert(isValidNote(fs.readFileSync(f, 'utf8')), '知识文件应有 YAML frontmatter + type: knowledge(Obsidian 可渲染): ' + path.relative(REPO, f));
  }
  // 非空契约：真实 knowledge/ 可能暂为空(全新系统), 那样上面的循环会空过。这里用良构/坏构样例
  // 证明"我们产出的笔记格式"对 Obsidian 合法、且校验确实能识别坏格式(否则 U5 等于没测)。
  const good = '---\ntype: knowledge\ntags: [x]\ncreated: 2026-06-16\n---\n\n# 标题\n正文 [[关联笔记]]\n';
  const bad = '# 没有 frontmatter 的笔记\n正文\n';
  assert(isValidNote(good), '良构笔记应判为合法 vault 条目(正向契约)');
  assert(!isValidNote(bad), '缺 frontmatter 的笔记应判为不合法(校验须能识别坏格式)');
  assert(/\[\[[^\]]+\]\]/.test(good), '应能从笔记解析出 [[wikilink]](Obsidian Graph View 依赖)');
  console.log('        (校验 ' + mds.length + ' 篇真实知识文件 + 良构/坏构契约)');
});

// ===== U6 数据安全：autocommit 钩子已接 + git 健康 =====
test('U6 数据安全 autocommit 钩子已接 + git 健康', () => {
  const settings = path.join(REPO, '.claude', 'settings.json');
  assert(fs.existsSync(settings), '.claude/settings.json 应存在');
  const s = fs.readFileSync(settings, 'utf8');
  assert(s.includes('git-autocommit'), 'settings.json 应在 PostToolUse 配置 git-autocommit 钩子');
  assert(fs.existsSync(path.join(REPO, '.claude', 'hooks', 'git-autocommit.ps1')), 'autocommit 钩子脚本应存在');
  const inside = execFileSync('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim();
  assert(inside === 'true', '应在 git 工作树内');
  const count = parseInt(execFileSync('git', ['-C', REPO, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), 10);
  assert(count >= 1, '应至少有 1 个提交(每次写入都留痕)');

  // 行为级：在隔离临时 git 仓里跑"真实钩子脚本副本", 证明它确实能 add+commit(而非仅"配置存在")。
  // 钩子用 $PSScriptRoot/..\.. 定位仓库根, 所以放到 trepo/.claude/hooks/ 下即作用于 trepo, 不碰真仓。
  const trepo = path.join(TMP, 'hookrepo');
  fs.mkdirSync(path.join(trepo, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(REPO, '.claude', 'hooks', 'git-autocommit.ps1'), path.join(trepo, '.claude', 'hooks', 'git-autocommit.ps1'));
  const g = (a) => execFileSync('git', ['-C', trepo, ...a], { encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@t.local']); g(['config', 'user.name', 'unittest']);
  fs.writeFileSync(path.join(trepo, 'seed.txt'), 'seed');
  g(['add', '-A']); g(['commit', '-q', '-m', 'seed']);
  const head0 = g(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(trepo, 'note.md'), '# hook behavior test');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(trepo, '.claude', 'hooks', 'git-autocommit.ps1')], { input: '{}', encoding: 'utf8' });
  const head1 = g(['rev-parse', 'HEAD']).trim();
  assert(head1 !== head0, 'autocommit 钩子应真正产生新提交(行为级, 非仅配置存在)');
  assert(g(['show', '--name-only', '--pretty=format:', 'HEAD']).includes('note.md'), '新提交应含被改动文件 note.md');
  console.log('        (git 历史提交数=' + count + '; 钩子行为级验证: 改动→自动新提交 ✓)');
});

// ===== U7 供应商切换底座：两条不变量 + 两条进程安全底线 =====
// 这组测试钉死的是一次真实事故：bridge 旧同步逻辑"只覆盖不删除"，让终端跑官方模型、
// 飞书跑第三方模型连续数周无人察觉。详见 tools/switch/README.md。
// 全部用纯函数 + 假数据，不碰用户真实配置、不动任何进程。
test('U7 switch 不变量①: 落地前删净所有 ANTHROPIC_*(切回官方不留残影)', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  // 复刻当时的故障态: 卡在旧的第三方供应商, 还压着更早一家的残留
  const dirty = {
    model: 'vendor-b-old',
    hooks: { keep: 1 },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.vendor-a.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-fake-for-test',
      ANTHROPIC_MODEL: 'vendor-a-pro',
      ANTHROPIC_REASONING_MODEL: 'vendor-b-reasoning',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
  };
  const out = sw.applyProvider(dirty, { official: true, model: 'opus[1m]', env: {} });
  const left = Object.keys(out.env || {}).filter((k) => k.startsWith('ANTHROPIC_'));
  assert(left.length === 0, '切回官方后仍残留 ANTHROPIC_*: ' + left.join(','));
  assert(out.env.CLAUDE_CODE_EFFORT_LEVEL === 'max', '误删了非供应商 env');
  assert(out.hooks && out.hooks.keep === 1, '误伤了 env 以外的字段');
  assert(out.model === 'opus[1m]', '顶层 model 未对齐: ' + out.model);
});

test('U7 switch 不变量②: 顶层 model 与 ANTHROPIC_MODEL 永远一致', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  // 旧顶层 model 是过期的上一家模型名, 落地新供应商后必须被覆盖, 不能两者打架
  const out = sw.applyProvider({ model: 'vendor-b-old', env: {} }, {
    model: 'x-pro', env: { ANTHROPIC_BASE_URL: 'https://x.test/anthropic', ANTHROPIC_MODEL: 'x-pro' },
  });
  assert(out.model === out.env.ANTHROPIC_MODEL, `自相矛盾: 顶层=${out.model} env=${out.env.ANTHROPIC_MODEL}`);
});

test('U7 switch 体检不误报: 别名与实跑模型归一', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  assert(sw.modelMatches('opus[1m]', 'claude-opus-5'), '别名 opus[1m] 应认得 claude-opus-5');
  assert(sw.modelMatches('vendor-a-flash[1M]', 'vendor-a-flash'), '[1M] 上下文后缀应被剥离');
  assert(!sw.modelMatches('vendor-a-pro', 'vendor-b-old'), '真正的不一致必须报出来');
});

test('U7 procs 安全①: 绝不把 Claude 桌面应用当成 CLI', () => {
  const procs = require(path.join(REPO, 'tools', 'switch', 'procs.js'));
  const desktop = [
    '"C:\\Program Files\\WindowsApps\\Claude_1.52386.6.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe" ',
    '"C:\\Program Files\\WindowsApps\\Claude_1.5\\app\\Claude.exe" --type=renderer --user-data-dir="C:\\x"',
    '"C:\\Program Files\\WindowsApps\\Claude_1.5\\app\\Claude.exe" --type=crashpad-handler',
  ];
  for (const cmd of desktop) assert(!procs.isClaudeCodeCli({ cmd }), '桌面应用被误判为 CLI(会被杀): ' + cmd.slice(0, 60));
  assert(procs.isClaudeCodeCli({ cmd: '"C:\\Users\\X\\.local\\bin\\claude.exe" --dangerously-skip-permissions' }),
    '真正的 Claude Code CLI 被误排除');
});

test('U7 procs 安全②: 扫描结果标出调用者自身, 且不含桌面应用', () => {
  const procs = require(path.join(REPO, 'tools', 'switch', 'procs.js'));
  const s = procs.scan();     // 只读, 不杀任何进程
  for (const p of [...s.terminalClaude, ...s.bridgeClaude]) {
    assert(procs.isClaudeCodeCli(p), '扫描结果混入非 CLI 进程 pid=' + p.pid);
  }
  if (process.env.CLAUDE_PID) {
    assert(s.self === Number(process.env.CLAUDE_PID), 'self 应取自 CLAUDE_PID, 用于永不自杀');
  }
});

test('U7 switch status 可跑、只读、两端齐全', () => {
  const out = execFileSync('node', ['tools/switch/switch.js', 'status', '--json'], { cwd: REPO, encoding: 'utf8' });
  const j = JSON.parse(out);
  assert(Array.isArray(j.scopes) && j.scopes.length === 2, 'status 应覆盖全局+桥接两端');
  assert(j.scopes.some((s) => s.scope === 'global') && j.scopes.some((s) => s.scope === 'bridge'), '两端 scope 名不对');
  assert(Array.isArray(j.warnings), 'status 应给出告警数组');
  console.log('        (当前档=' + j.current + '; 告警 ' + j.warnings.length + ' 条)');
});

// ===== U8 切换器 Web 界面：安全契约 =====
// 这个页面能读写全部供应商的明文 Key，所以它的安全契约必须被测试钉死，而不是靠"我记得写了"：
//   1) 没有正确 token 的请求一律 403(页面和 API 都是)
//   2) 返回给页面的 Key 必须是打码的——页面永远拿不到完整 Key
//   3) 只监听 127.0.0.1
// 起真服务、发真请求、跑完杀掉，不留残留进程。
test('U8 webui 安全契约: 无 token 403 / Key 不出明文 / 只绑本地', () => {
  const probe = path.join(TMP, 'webui-probe.js');
  fs.writeFileSync(probe, `
    const { spawn } = require('child_process');
    const path = require('path');
    const REPO = ${JSON.stringify(REPO)};
    const p = spawn(process.execPath, [path.join(REPO, 'tools', 'switch', 'webui.js'), '--no-open'],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const done = (msg, code) => { try { p.kill(); } catch (_) {} console.log(msg); process.exit(code); };
    const timer = setTimeout(() => done('FAIL 启动超时', 1), 15000);
    p.stdout.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\\n')) return;
      clearTimeout(timer);
      let info; try { info = JSON.parse(buf.split('\\n')[0]); } catch (e) { return done('FAIL 首行不是 JSON: ' + buf.slice(0, 120), 1); }
      const base = 'http://127.0.0.1:' + info.port;
      try {
        const bad = await fetch(base + '/api/state', { headers: { 'x-switch-token': 'x'.repeat(info.token.length) } });
        if (bad.status !== 403) return done('FAIL 错误 token 未被拒绝, got ' + bad.status, 1);
        const noTok = await fetch(base + '/');
        if (noTok.status !== 403) return done('FAIL 页面无 token 未被拒绝, got ' + noTok.status, 1);
        const ok = await fetch(base + '/api/state', { headers: { 'x-switch-token': info.token } });
        if (ok.status !== 200) return done('FAIL 正确 token 被拒, got ' + ok.status, 1);
        const j = await ok.json();
        if (!j.ok || !Array.isArray(j.data.providers)) return done('FAIL state 结构不对', 1);
        const raw = JSON.stringify(j.data);
        if (/"ANTHROPIC_AUTH_TOKEN"/.test(raw)) return done('FAIL 响应里出现了原始 env Key 字段', 1);
        for (const pr of j.data.providers) {
          if (pr.hasToken && !/\\*\\*\\*/.test(pr.tokenMasked)) return done('FAIL Key 未打码: ' + pr.name, 1);
        }
        done('PASS ' + j.data.providers.length + ' 档, 端口 ' + info.port, 0);
      } catch (e) { done('FAIL 请求异常: ' + e.message, 1); }
    });
    p.on('error', (e) => done('FAIL 无法启动: ' + e.message, 1));
  `, 'utf8');
  const out = execFileSync('node', [probe], { cwd: REPO, encoding: 'utf8', timeout: 30000 }).trim();
  assert(out.startsWith('PASS'), out);
  console.log('        (' + out.replace(/^PASS /, '') + ')');
});

test('U7 桥接首次启动不从本机拷任何配置(只写自有基线)', () => {
  // 定死的规矩: 两端天生独立。桥接该有什么配置是桥接自己的事, 不该取决于"第一次启动那天本机长什么样"。
  // 曾两次栽在这上面: 先是整份复制(连第三方 Base URL + Key 一起继承), 后改成"剥掉 ANTHROPIC_* 再复制"
  // ——Key 是不带了, 但拷贝这个行为本身仍然错。现在: 一个字节都不拷, 只写自己的最小基线。
  const main = fs.readFileSync(path.join(REPO, 'bridge', 'main.js'), 'utf8');
  const m = /const BRIDGE_BASELINE_SETTINGS = (\{[\s\S]*?\n\};)/.exec(main);
  assert(m, 'bridge/main.js 缺少 BRIDGE_BASELINE_SETTINGS 自有基线');
  // eslint-disable-next-line no-new-func
  const baseline = new Function('return ' + m[1].replace(/;$/, ''))();
  const bad = Object.keys(baseline.env || {}).filter((k) => k.startsWith('ANTHROPIC_'));
  assert(bad.length === 0, '基线里不该有任何 ANTHROPIC_*: ' + bad.join(','));
  assert(!baseline.model, '基线不该钉死 model(那是 tools/switch 的职责): ' + baseline.model);
  assert(baseline.permissions && baseline.permissions.defaultMode === 'auto',
    '基线必须 defaultMode=auto: 伪终端后面没有人, 弹权限框就是死锁');

  // 播种块里不许再出现任何"从本机读配置"的动作
  const seedBlock = /const dstS = path\.join\(BRIDGE_HOME, 'settings\.json'\);[\s\S]*?const dstC[\s\S]*?\n    \}/.exec(main);
  assert(seedBlock, '找不到 settings/config 播种块');
  assert(!/readFileSync\(srcS|copyFileSync\(srcS|path\.join\(src,/.test(seedBlock[0]),
    '播种块仍在读本机全局配置: ' + seedBlock[0].slice(0, 200));
  assert(!/homedir\(\)/.test(seedBlock[0]), '播种块仍在读用户主目录');

  // .claude.json 也不许再从 ~/.claude.json 播种(那份带着本机所有项目的元数据)
  assert(!/existsSync\(dstJson\) \? dstJson : path\.join\(os\.homedir\(\)/.test(main),
    '.claude.json 仍在从本机主配置播种');

  // 唯一还允许从本机取的: 登录凭据(是登录态不是配置, 不取最新会掉登录)
  assert(/copyFileSync\(path\.join\(src, '\.credentials\.json'\)/.test(main),
    '凭据刷新被误删了: 桥接会掉登录、逼着重新登一次');
});

test('U7 复制入口: 全局→桥接整份覆盖, 第三方带 Key、官方不用重新登录', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  assert(typeof sw.CMDS['copy-global'] === 'function', '缺少 copy-global 命令');
  assert(typeof sw.CMDS.import !== 'function', '旧的 import(存成档案)语义已废弃, 不该还在');
  // 复制必须是覆盖式: 合并同步不了"删除"——本机把 ANTHROPIC_* 整组删掉切回官方订阅时,
  // 合并式传不过去, 桥接就卡在旧供应商上。那正是那次漂移事故的成因。
  const src = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'switch.js'), 'utf8');
  const body = /async 'copy-global'\(a\) \{[\s\S]*?\n  \},/.exec(src);
  assert(body, '找不到 copy-global 实现');
  assert(!/sanitize|isAnthropicKey|delete .*ANTHROPIC/.test(body[0]),
    'copy-global 不该剥离任何键: 它要能整份搬第三方(含 Key), 也要能搬官方');
  assert(/writeJsonAtomic\(dst, next\)/.test(body[0]), '覆盖必须走原子写+备份');
  assert(/restartBridgeSession/.test(body[0]), '复制完必须重启桥接会话, 否则又是只改文件的假生效');

  // 官方档的定义就是"一个 ANTHROPIC_* 都不写"——落地后必须彻底干净,
  // 鉴权才会回落到 .credentials.json 的 OAuth 凭据(桥接每次启动从本机刷新), 不用重新登录。
  const out = sw.applyProvider(
    { model: 'x', env: { ANTHROPIC_BASE_URL: 'https://old.test', ANTHROPIC_AUTH_TOKEN: 'sk-old' } },
    { official: true, model: 'opus[1m]', env: {} });
  assert(Object.keys(out.env || {}).length === 0, '官方档不该留任何 env 键');
  assert(out.model === 'opus[1m]', '官方档模型未落地');

  // 页面的复制入口必须复用同一条命令, 不能另写一套
  const webui = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.js'), 'utf8');
  assert(/sw\.CMDS\['copy-global'\]\(/.test(webui), 'webui 的复制入口未复用 CMDS[copy-global]');
  const html = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.html'), 'utf8');
  assert(/btnImport/.test(html) && /copyGlobal/.test(html), '页面缺少「复制到桥接」入口');
});

test('U8 webui 与 CLI 同源: 页面写操作复用 switch.js 的 CMDS', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  for (const k of ['use', 'check', 'model', 'restart', 'rm']) {
    assert(typeof sw.CMDS[k] === 'function', 'CMDS 缺少 ' + k + '（webui 依赖它，缺了页面就会另走一套逻辑）');
  }
  const webui = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.js'), 'utf8');
  assert(/sw\.CMDS\.use\(/.test(webui), 'webui 的切换必须调 CMDS.use，否则会绕过"探活→落盘→重启"三步');
});

// ===== U9 任务面板：数据层无损 + 写入语义 + 双端联动 =====
// 这组测试守的是同一件事：面板能改任务文件，而任务文件是用户的真资产。
// 解析→写回只要有一丁点损耗，第一次拖卡片就会静默吃掉他手写的优先级链、引用块、wikilink。
// 往返样本：每一条都对应一个真出过的丢失。固定样本 + 本机真实文件双跑——
// 只验真实文件的话，在 tasks/ 为空的仓库上这条测试会悄悄变成空跑、什么都没守住。
const PANEL_RT_SAMPLES = {
  '条目间空行': ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# A', '', '## 当前进度', '- [2026-01-02 03:04] 一。', '', '- [2026-01-03 03:04] 二。', '',
    '## 下一步计划', '- x', ''],
  '缩进子条目': ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# B', '', '## 当前进度', '- [2026-01-02 03:04] 一。', '  - 子条目', '    - 孙条目', '',
    '## 下一步计划', '- x', ''],
  'frontmatter 非规范键序': ['---', 'created: 2026-01-02 03:04', 'horizon: 短期', 'type: task',
    'status: blocked', '---', '', '# C', '', '## 当前进度', '- [2026-01-02 03:04] 一。', '',
    '## 下一步计划', '- x', ''],
  '正文引用块与 wikilink': ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# D', '', '> **优先级链：** A → [[别的任务]] → B', '', '## 当前进度',
    '- [2026-01-02 03:04] 一。', '', '## 下一步计划', '- x', ''],
  '无下一步计划段': ['---', 'type: task', 'status: done', 'created: 2026-01-02 03:04',
    'completed: 2026-01-09 10:11', '---', '', '# E', '', '## 当前进度', '- [2026-01-02 03:04] 一。', ''],
  '结尾无换行': ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# F', '', '## 当前进度', '- [2026-01-02 03:04] 一。', '', '## 下一步计划', '- x'],
};

test('U9 面板数据层: 读写往返无损(样本 + 本机全部真实任务文件)', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  for (const [label, lines] of Object.entries(PANEL_RT_SAMPLES)) {
    const src = lines.join('\n');
    assert(T.serialize(T.parse(src, 'x')) === src, `样本「${label}」往返有损`);
  }
  const bad = [];
  let n = 0;
  for (const dir of [T.ACTIVE, T.ARCHIVE]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (_) { continue; }
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      n++;
      if (T.serialize(T.parse(src, f.replace(/\.md$/, ''))) !== src) bad.push(f);
    }
  }
  assert(bad.length === 0, `${bad.length}/${n} 个真实文件往返有损: ` + bad.slice(0, 3).join(', '));
  console.log(`        (${Object.keys(PANEL_RT_SAMPLES).length} 个样本 + ${n} 个真实任务文件全部无损)`);
});

test('U9 面板数据层: 结构化编辑不碰无关内容, 且保持 frontmatter 原键序', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  // 刻意构造一份"有手写内容"的任务: 引用块 + wikilink + 缩进子条目 + 条目间空行
  const src = [
    '---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', 'horizon: 短期', '---', '',
    '# 某任务', '',
    '> **优先级链：** A → [[别的任务]] → B', '',
    '## 当前进度',
    '- [2026-01-02 03:04] 登记。',
    '  - 子条目要保住',
    '',
    '- [2026-01-03 05:06] 又做了点。', '',
    '## 下一步计划', '- 继续', '',
  ].join('\n');
  const t = T.parse(src, '某任务');
  assert(T.serialize(t) === src, '构造样本自身往返就有损');
  assert(t.progress.items.length === 2, '缩进子条目被误当成独立进度条目: ' + t.progress.items.length);

  T.setFields(t, { priority: '高' });
  const out = T.serialize(t);
  assert(out.includes('> **优先级链：** A → [[别的任务]] → B'), '手写引用块被吃掉了');
  assert(out.includes('  - 子条目要保住'), '缩进子条目被吃掉了');
  // 新字段必须追加在原有键之后, 不能重排 —— 重排会让 git diff 显示成整块改动
  const fmLines = out.split('\n').slice(1, 7);
  assert(fmLines[2].startsWith('created:'), 'frontmatter 原键序被打乱: ' + JSON.stringify(fmLines));
  assert(out.includes('priority: 高'), '新字段没写进去');
});

test('U9 面板写入: 改状态必须自动留痕(不能绕过进度流)', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  const src = ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# X', '', '## 当前进度', '- [2026-01-02 03:04] 登记。', '', '## 下一步计划', '- a', ''].join('\n');
  const t = T.parse(src, 'X');
  const before = t.progress.items.length;
  T.setFields(t, { status: 'done' }, new Date('2026-05-06T07:08:00'));
  assert(t.progress.items.length === before + 1,
    '改状态没有自动补进度: 任务会"状态变了但没人知道为什么变", 而进度流正是这个任务库最值钱的部分');
  assert(t.fm.completed, '标记 done 时没有写 completed 时间');
  T.setFields(t, { status: 'running' });
  assert(!t.fm.completed, '从 done 改回去时 completed 没有清掉, 会留下假的完成时间');
});

test('U9 面板体检: 停滞天数 / 重复检测 既不漏报也不误报', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  // 造一批任务喂给体检: 两条是真重复, 两条只是共享一个 2-gram、绝不能被凑成一组。
  // 重复检测宁可漏报不可误报——误报一次, 人就不信这个提示了, 之后连真的重复也一起忽略。
  const mk = (title, last) => {
    const t = T.parse(['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
      '# ' + title, '', '## 当前进度', `- [${last}] 一。`, '', '## 下一步计划', '- x', ''].join('\n'), title);
    t.bucket = 'active';
    return t;
  };
  const now = new Date('2026-04-01T12:00:00');
  const h = T.healthCheck([
    mk('整理电脑上的 GitHub 项目', '2026-01-02 03:04'),   // 停滞 89 天
    mk('整理 GitHub 项目', '2026-03-30 03:04'),           // 与上一条重复
    mk('优化个人简历', '2026-03-30 03:04'),               // 与下一条只共享「个人」
    mk('整理个人主页', '2026-03-30 03:04'),
  ], now);
  assert(h.counts.total === 4, '体检计数不对: ' + h.counts.total);
  assert(Array.isArray(h.stale) && Array.isArray(h.duplicates), '体检结构不对');
  assert(h.stale.length === 1 && h.stale[0].days === 89, '停滞识别不对: ' + JSON.stringify(h.stale));
  const grouped = (a, b) => h.duplicates.some((g) =>
    g.some((x) => x.title === a) && g.some((x) => x.title === b));
  assert(grouped('整理电脑上的 GitHub 项目', '整理 GitHub 项目'), '真重复没被认出来');
  assert(!grouped('优化个人简历', '整理个人主页'), '只共享「个人」这个 2-gram 的两条被误判成重复');

  // 本机有真实任务时顺带体检一遍: 结构不能崩, 组里不能出现同一个任务两次
  const real = T.healthCheck(T.loadAll());
  for (const g of real.duplicates) {
    assert(g.length > 1, '重复组里只有一个任务');
    const titles = g.map((x) => x.title);
    assert(new Set(titles).size === titles.length, '重复组里出现了同一个任务两次');
  }
});

test('U9 面板服务: 无 token 403 / 路径穿越被拒 / 静态资源免鉴权', () => {
  const srv = fs.readFileSync(path.join(REPO, 'tools', 'panel', 'server.js'), 'utf8');
  assert(/127\.0\.0\.1/.test(srv) && !/server\.listen\(\s*PORT\s*\)/.test(srv),
    '面板服务必须显式绑 127.0.0.1, 否则局域网可直接读到你的全部任务');
  assert(/timingSafeEqual/.test(srv), 'token 比较必须用时间安全比较');
  assert(/includes\('\.\.'\)/.test(srv), '任务名没有做路径穿越校验');
  assert(/authed\(req, url\)/.test(srv), 'API 未统一鉴权');
  // SW 与 manifest 必须免鉴权, 否则 PWA 根本装不上(浏览器发的是不带 cookie 的请求)
  const i = srv.indexOf('STATIC[url.pathname]'), j = srv.indexOf("url.pathname.startsWith('/api/')");
  assert(i > 0 && j > i, '静态资源放行必须在 API 鉴权之前');
});

test('U9 双端联动: 面板改动会投递事件, 提示词只许播报不许动手', () => {
  const EV = require(path.join(REPO, 'tools', 'panel', 'events.js'));
  const p = EV.buildPrompt([
    { kind: 'status', title: 'T1', from: 'running', to: 'done', at: new Date().toISOString() },
    { kind: 'progress', title: 'T2', text: '做了点事', at: new Date().toISOString() },
  ]);
  assert(/T1/.test(p) && /T2/.test(p), '提示词没带上改动内容');
  // 约束必须在: 否则 claude 看到"某任务 done"会顺手去归档、去改别的文件——
  // 用户在面板点一下, 不该触发一串他没要求的动作
  assert(/不要执行任何后续动作|只播报/.test(p), '提示词缺少"只播报不动手"的硬约束');
  assert(/不要调用工具/.test(p) && /不要改任何文件/.test(p), '提示词缺少禁止工具/写文件的约束');
  // 攒批: 连拖三张卡片不该炸出三轮对话
  const fresh = [{ at: new Date().toISOString() }];
  assert(EV.isReady(fresh) === false, '刚发生的改动就该等一等, 不能立刻打扰');
  assert(EV.isReady([{ at: new Date(Date.now() - 60000).toISOString() }]) === true, '静默够久后必须发出');
  // 桥接侧真的接了这条线
  const main = fs.readFileSync(path.join(REPO, 'bridge', 'main.js'), 'utf8');
  assert(/panel\/events/.test(main) && /drainPanelEvents/.test(main), 'bridge/main.js 没有接面板事件');
  assert(/panelEvents\.clear\(evts\)/.test(main), '事件没有在处理后清除, 会无限重播同一批');
});

test('U9 面板编辑: 重写下一步计划不破坏文件, 且能识别"没变化"', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  const src = ['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# X', '', '> 手写的引用块要活着', '', '## 当前进度', '- [2026-01-02 03:04] 一。', '',
    '## 下一步计划', '- 旧计划一', '- 旧计划二', ''].join('\n');
  const t = T.parse(src, 'X');
  // 前端会把原文回填进 textarea, 用户原样提交时不该产生一次"改动"(否则飞书会被空播报刷屏)
  assert(T.setNext(t, '旧计划一\n旧计划二') === null, '内容没变却报告成改动了');
  const ch = T.setNext(t, '新计划一\n- 新计划二\n\n   \n新计划三');
  assert(ch && ch.to === '新计划一\n新计划二\n新计划三',
    'textarea 里的 "- " 前缀和空行没被清干净: ' + JSON.stringify(ch && ch.to));
  const out = T.serialize(t);
  assert(out.includes('> 手写的引用块要活着'), '重写计划把正文其它部分弄丢了');
  assert(out.includes('- [2026-01-02 03:04] 一。'), '重写计划把进度弄丢了');
  assert(!out.includes('旧计划一'), '旧计划没被替换掉');
  assert(T.serialize(T.parse(out, 'X')) === out, '重写后的文件自身往返有损');
});

test('U9 面板归档: 未完成任务绝不允许归档', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  const mk = (status) => {
    const t = T.parse(['---', 'type: task', 'status: ' + status, 'created: 2026-01-02 03:04', '---', '',
      '# X', '', '## 当前进度', '- [2026-01-02 03:04] 一。', ''].join('\n'), 'X');
    t.bucket = 'active';
    t.file = path.join(TMP, 'never-written.md');   // 会在状态校验处就抛错, 碰不到文件
    return t;
  };
  // CLAUDE.md 的安全底线: 未完成任务绝不删除/归档。多了个网页按钮也不松动。
  for (const st of ['running', 'blocked']) {
    let threw = false;
    try { T.archive(mk(st)); } catch (_) { threw = true; }
    assert(threw, `status=${st} 的任务竟然被允许归档了`);
  }
  // 已在归档区的不该再归档一次
  const done = mk('done'); done.bucket = 'archive';
  let threw2 = false;
  try { T.archive(done); } catch (_) { threw2 = true; }
  assert(threw2, '已归档的任务又被归档了一次');
});

test('U9 面板搜索: 关键词只出现在进度正文里也要搜得到', () => {
  const T = require(path.join(REPO, 'tools', 'panel', 'tasks.js'));
  const t = T.parse(['---', 'type: task', 'status: running', 'created: 2026-01-02 03:04', '---', '',
    '# 某个标题完全无关的任务', '', '## 当前进度',
    '- [2026-01-02 03:04] 试了 DevHub，登录后默认建的列删不掉。', '',
    '## 下一步计划', '- 换个工具', ''].join('\n'), '某个标题完全无关的任务');
  const v = T.toView(t);
  // 只搜标题等于搜不到——想找"那个提到 DevHub 的任务"时关键词几乎总在进度里
  assert(!v.title.toLowerCase().includes('devhub'), '样本没构造对: 标题里不该有关键词');
  assert(v.haystack.includes('devhub'), '进度正文没进搜索索引');
  assert(v.haystack.includes('换个工具'), '下一步计划没进搜索索引');
  assert(v.haystack === v.haystack.toLowerCase(), 'haystack 必须是小写的, 否则前端小写匹配会漏');
});

test('U9 联动可观测: 桥接比集成代码旧必须被自己发现', () => {
  const EV = require(path.join(REPO, 'tools', 'panel', 'events.js'));
  const h = EV.linkHealth();
  // 这条守的是一次真事故: 集成代码写完、单测全绿, 可飞书一条都没收到——
  // 因为跑着的桥接是改动之前启动的, Node 只在 require 时读一次文件。
  // 测试读磁盘源码, 照不出这种断层, 只能让产品自己在运行时报出来。
  for (const k of ['ok', 'reason', 'alive', 'codeStale', 'backedUp', 'pending']) {
    assert(k in h, '联动体检缺字段: ' + k);
  }
  assert(typeof h.ok === 'boolean', 'ok 必须是布尔');
  assert(h.ok === (h.alive && !h.codeStale && !h.backedUp), 'ok 与三项判据不自洽: ' + JSON.stringify(h));
  assert(h.ok || h.reason, '不 ok 时必须给出人话原因, 否则用户不知道要干嘛');
  // 页面必须真的把它显示出来, 否则算出来也白算
  const html = fs.readFileSync(path.join(REPO, 'tools', 'panel', 'panel.html'), 'utf8');
  assert(/S\.link/.test(html) && /联动未生效/.test(html), '页面没有展示联动状态');
});

test('U9 离线: SW 缓存只读快照, 写操作绝不排队重放', () => {
  const sw = fs.readFileSync(path.join(REPO, 'tools', 'panel', 'sw.js'), 'utf8');
  assert(/api\/state/.test(sw) && /caches/.test(sw), 'SW 没有做数据快照');
  // 离线补写是危险的: 你在飞书那头可能已经改过同一个任务, 等服务回来再灌旧指令就是静默覆盖
  assert(!/background-?sync|SyncManager|replay/i.test(sw), 'SW 不许把写操作排队重放');
  assert(/offline\s*=\s*true/.test(sw), '回放快照时必须打 offline 标记, 页面才能转只读');
  // shell 不许缓存优先: 缓存优先会让改完页面刷新看不到变化(得记着改 VER), 而且带 ?t= 进来时
  // 直接返回缓存页, 服务端那个"种 cookie 再 302 到干净 /"的重定向根本不会发生, token 就留在
  // 浏览器历史里了。服务在 127.0.0.1, 网络优先的代价是亚毫秒一跳。
  assert(/shellNetworkFirst/.test(sw), 'shell 必须网络优先');
  assert(!/caches\.match\(req[^)]*\)\.then\(\(hit\)\s*=>\s*\n?\s*hit \|\|/.test(sw), 'shell 还在走缓存优先');
  const html = fs.readFileSync(path.join(REPO, 'tools', 'panel', 'panel.html'), 'utf8');
  assert(/S\.offline/.test(html) && /只读|改不了/.test(html), '页面没有根据 offline 标记转只读');
});

// ---- 收尾 ----
rmrfDir(TMP);

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n==== 工具层单元测试: ${pass} 通过 / ${fail} 失败 / 共 ${results.length} ====`);
for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
process.exit(fail === 0 ? 0 : 1);
