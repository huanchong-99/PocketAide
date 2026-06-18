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

// ---- 收尾 ----
rmrfDir(TMP);

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n==== 工具层单元测试: ${pass} 通过 / ${fail} 失败 / 共 ${results.length} ====`);
for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
process.exit(fail === 0 ? 0 : 1);
