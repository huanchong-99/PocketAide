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

test('U7 桥接播种不继承本机供应商: ANTHROPIC_* 与顶层 model 一律剥离', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  // 模拟"全局此刻正配着某第三方"的本机配置被拿去给桥接播种
  const global = {
    model: 'vendor-a-pro',
    hooks: { keep: 1 }, enabledPlugins: { p: true },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.vendor-a.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-should-never-be-inherited',
      ANTHROPIC_MODEL: 'vendor-a-pro',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
  };
  const seed = sw.sanitizeForBridgeSeed(global);
  const leaked = Object.keys(seed.env || {}).filter((k) => k.startsWith('ANTHROPIC_'));
  assert(leaked.length === 0, '播种把本机供应商继承过去了: ' + leaked.join(','));
  assert(!seed.model, '播种把本机模型继承过去了: ' + seed.model);
  assert(seed.env.CLAUDE_CODE_EFFORT_LEVEL === 'max', '不该动非供应商 env');
  assert(seed.hooks && seed.hooks.keep === 1 && seed.enabledPlugins, '应继承 hooks/plugins 等行为设置');
  assert(global.env.ANTHROPIC_BASE_URL && global.model, '纯函数不得就地修改调用方传入的对象');
  // 桥接侧必须真的走这条路径，而不是又退回整份复制
  const main = fs.readFileSync(path.join(REPO, 'bridge', 'main.js'), 'utf8');
  assert(/sanitizeForBridgeSeed/.test(main), 'bridge/main.js 播种未经过 sanitizeForBridgeSeed');
  assert(!/copyFileSync\(srcS, dstS\)/.test(main), 'bridge/main.js 仍在整份复制全局 settings(会继承供应商)');
});

test('U7 从本机复制一档: 官方档不带任何 Key(走已登录凭据, 不用重新登录)', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  assert(typeof sw.CMDS.import === 'function', '缺少 import 命令');
  // 官方档的定义就是"一个 ANTHROPIC_* 都不写"——落地后必须彻底干净，
  // 鉴权才会回落到 ~/.claude/.credentials.json 的 OAuth 凭据(桥接每次启动从全局刷新)。
  const out = sw.applyProvider(
    { model: 'x', env: { ANTHROPIC_BASE_URL: 'https://old.test', ANTHROPIC_AUTH_TOKEN: 'sk-old' } },
    { official: true, model: 'opus[1m]', env: {} });
  assert(Object.keys(out.env || {}).length === 0, '官方档不该留任何 env 键');
  assert(out.model === 'opus[1m]', '官方档模型未落地');
  // 页面的「从本机当前配置复制」必须复用同一条命令，不能另写一套导入逻辑
  const webui = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.js'), 'utf8');
  assert(/sw\.CMDS\.import\(/.test(webui), 'webui 的复制入口未复用 CMDS.import');
  const html = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.html'), 'utf8');
  assert(/btnImport/.test(html) && /importLocal/.test(html), '页面缺少「从本机当前配置复制」入口');
});

test('U8 webui 与 CLI 同源: 页面写操作复用 switch.js 的 CMDS', () => {
  const sw = require(path.join(REPO, 'tools', 'switch', 'switch.js'));
  for (const k of ['use', 'check', 'model', 'restart', 'rm']) {
    assert(typeof sw.CMDS[k] === 'function', 'CMDS 缺少 ' + k + '（webui 依赖它，缺了页面就会另走一套逻辑）');
  }
  const webui = fs.readFileSync(path.join(REPO, 'tools', 'switch', 'webui.js'), 'utf8');
  assert(/sw\.CMDS\.use\(/.test(webui), 'webui 的切换必须调 CMDS.use，否则会绕过"探活→落盘→重启"三步');
});

// ---- 收尾 ----
rmrfDir(TMP);

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n==== 工具层单元测试: ${pass} 通过 / ${fail} 失败 / 共 ${results.length} ====`);
for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
process.exit(fail === 0 ? 0 : 1);
