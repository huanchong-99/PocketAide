// 逐场景自动化测试，对照 01-用户功能规格书.md。
// 每个测试 = 通过 PtyClaude(等价"用户从飞书发消息") 发消息 + 断言副作用。
// 用法: node tools/test/scenarios.js [场景号...]   例: node tools/test/scenarios.js 1a 3e
//
// 设计要点(吸收审计结论)：
//  - 探测/清理用 before/after 文件集差分，不靠内容标记 —— knowledge-write 产出的是干净原子笔记，
//    会把口语标记(如 ZZTEST)洗掉，标记法既探测不到也清理不掉。
//  - 副作用断言一律用 H.waitFor 轮询 —— 屏幕静默 ≠ 文件已落盘+autocommit跑完+kg索引完。
//  - 查询类测试自带 fixture(写一篇确定性知识 + kg index)，可单跑、不与写入测试顺序耦合。
//  - 收尾按"本 run 新建文件路径"删 + git 持久化 + kg 重新索引；测试提醒据基线移除(绝不到点发飞书)。
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const H = require('./harness');

const want = process.argv.slice(2);
const pick = (id) => want.length === 0 || want.includes(id);
function anyContains(text, arr) { return arr.some((s) => text.includes(s)); }
const CONFIRM_WORDS = ['确认', '是这个', '要改', '要不要改', '存入', '对吗', '可以吗', '存吗', '是这样吗'];

const CREATED = new Set();        // 本 run 新建的产物文件(相对路径)，收尾按路径删
let reminderBaseline = new Set(); // 测试前已存在的合法提醒(不能误删)
// 测试前基线(空库快照)：cleanup 据此"重新扫描差分"回滚, 比 CREATED 路径集更稳——
// 不受抓取时机(claude 在 waitFor 阈值后又多写一篇)和中文路径串匹配失败的影响。
let baseKnowledge = new Set(), baseTasksActive = new Set(), baseWorkspace = new Set(), baseReminders = new Set();

function snap(dirs) { const s = new Set(); for (const d of dirs) for (const f of H.findFiles(d, '')) s.add(f); return s; }
function newSince(before, dirs) { const out = []; for (const d of dirs) for (const f of H.findFiles(d, '')) if (!before.has(f)) out.push(f); return out; }
function safeRead(f) { try { return H.readFile(f); } catch (_) { return ''; } }
function unregister(t) { try { execFileSync('powershell', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${t}' -Confirm:$false`], { encoding: 'utf8' }); } catch (_) {} }
function chromeUp() { try { return execFileSync('curl', ['-s', '-m', '2', 'http://127.0.0.1:9222/json/version'], { encoding: 'utf8' }).includes('webSocketDebuggerUrl'); } catch (_) { return false; } }

// 写一篇确定性知识 fixture 并增量索引，纳入清理。供查询类测试自包含。
function seedKnowledge(rel, content) {
  const abs = path.join(H.REPO, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  CREATED.add(rel);
  try { execFileSync('python', [path.join(H.REPO, 'tools', 'kg', 'kg.py'), 'index', '--file', rel.replace(/^knowledge[\\/]/, '')], { cwd: H.REPO, encoding: 'utf8' }); } catch (_) {}
}
const CONPTY_FIXTURE = '---\ntype: knowledge\ntags: [ConPTY, 终端, Max]\nsource: 测试fixture\ncreated: 2026-06-16\n---\n\n# ConPTY 复用 Max\n\n## 摘要\n- ConPTY 让子进程以为自己连着真终端，从而复用 Max 订阅、零额外 API 费用。\n- 本系统给这条经验编了个内部代号便于检索：QILIN-5530。\n';

function rmOne(rel) {
  // 全程用 git 删除, 绝不用 fs.rmSync —— 实测 node 在本机(沙箱保护仓库路径)对"中文名仓库文件"
  // 做 fs.rmSync 会硬崩溃(exit 0xC0000409), 之前每次 cleanup 都是这样半途崩掉、残留测试产物。
  // git 走索引、execFileSync 直传参数, 对中文名稳妥。fs.existsSync 只读 stat, 安全。
  const fwd = rel.replace(/\\/g, '/');
  const abs = path.join(H.REPO, rel);
  try { execFileSync('git', ['-C', H.REPO, 'rm', '-f', '--ignore-unmatch', '--quiet', '--', fwd], { encoding: 'utf8' }); } catch (_) {}
  if (fs.existsSync(abs)) {
    // 仍在 => 是未跟踪文件, 用 git clean 精确删这一个未跟踪路径(同样中文安全)。
    try { execFileSync('git', ['-C', H.REPO, 'clean', '-fq', '--', fwd], { encoding: 'utf8' }); } catch (_) {}
  }
  return !fs.existsSync(abs);
}

// 递归删目录(用于 batchDir 等 gitignored 临时目录): 本机 fs.rmSync(recursive) 会硬崩溃(0xC0000409),
// git 又管不了 ignored 目录, 故用 PowerShell Remove-Item(中文/递归稳妥)。
function rmrfDir(dir) {
  if (!fs.existsSync(dir)) return;
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Remove-Item -LiteralPath '" + dir + "' -Recurse -Force -ErrorAction SilentlyContinue"], { encoding: 'utf8' }); } catch (_) {}
}

function cleanup() {
  // 重新扫描"测试期间相对基线新增"的文件, 而非依赖 CREATED 路径集——后者会漏掉 claude 在
  // waitFor 阈值满足后又补写的文件(曾因此把 5 篇测试笔记残留进知识库)。workspace 跳过 .outbox/tmp 噪声。
  const news = new Set([
    ...newSince(baseKnowledge, ['knowledge']),
    ...newSince(baseTasksActive, ['tasks/active']),
    ...newSince(baseWorkspace, ['workspace']).filter((f) => { const p = f.replace(/\\/g, '/'); return !p.includes('workspace/.outbox') && !p.includes('workspace/tmp'); }),
    ...newSince(baseReminders, ['tasks/reminders']),
    ...CREATED,   // 并入显式跟踪集, 双保险
  ]);
  CREATED.clear();
  let removed = 0;
  for (const rel of news) if (rmOne(rel)) removed++;
  for (const t of H.schedTasks('PocketAide-Remind-')) if (!reminderBaseline.has(t)) unregister(t);
  if (removed) {
    // 持久化删除保持仓库干净, 再把 kg 索引同步回当前(删掉测试节点)。
    try { execFileSync('git', ['-C', H.REPO, 'add', '-A'], { encoding: 'utf8' }); } catch (_) {}
    try { execFileSync('git', ['-C', H.REPO, 'commit', '-m', 'test: cleanup scenario artifacts'], { encoding: 'utf8' }); } catch (_) {}
    try { execFileSync('python', [path.join(H.REPO, 'tools', 'kg', 'kg.py'), 'index', '--all'], { cwd: H.REPO, encoding: 'utf8' }); } catch (_) {}
  }
  console.log(`(cleanup: 移除 ${removed} 个测试产物)`);
  return removed;
}

async function main() {
  const r = new H.Runner();
  if (fs.existsSync(path.join(H.REPO, 'bridge', '.bridge.lock'))) {
    console.log('⚠ 检测到桥接在线(.bridge.lock)：测试与桥接共用工作树。请确保测试期间无飞书消息进来，否则差分可能混入桥接产物。');
  }
  for (const t of H.schedTasks('PocketAide-Remind-zztest')) unregister(t);
  reminderBaseline = new Set(H.schedTasks('PocketAide-Remind-'));
  baseKnowledge = snap(['knowledge']);
  baseTasksActive = snap(['tasks/active']);
  baseWorkspace = snap(['workspace']);
  baseReminders = snap(['tasks/reminders']);

  const s = new H.Session();
  console.log('启动 claude 会话(伪终端=飞书通道)...');
  await s.start();

  try {
    // ===== 场景一 知识摄入 =====
    if (pick('1a')) await r.test('1a 对话式摄入(整理→二次确认→存入→可检索)', async () => {
      const before = snap(['knowledge']);
      const reply1 = await s.say('我今天学到一个点：ConPTY 可以让子进程以为自己连着真终端，从而复用 Max 零额外费用。帮我记进知识库。');
      H.assert(anyContains(reply1, CONFIRM_WORDS), '整理后应先发二次确认: ' + reply1.slice(0, 140));
      H.assert(newSince(before, ['knowledge']).length === 0, '二次确认前不应写入知识库');
      await s.say('确认无误，存吧。');
      const added = await H.waitFor(() => newSince(before, ['knowledge']), (a) => a.length >= 1, 20000);
      added.forEach((f) => CREATED.add(f));
      H.assert(added.length >= 1, '确认后应在 knowledge/ 新增文件');
      H.assert(added.some((f) => safeRead(f).includes('ConPTY')), '写入内容应含主题 ConPTY');
      // 跨场景规则：写入后 kg 索引应更新 → 能检索到新主题
      const hits = await H.waitFor(
        () => { try { return H.kg(['search', 'ConPTY 复用 Max', '--k', '5']); } catch (_) { return []; } },
        (a) => Array.isArray(a) && a.some((h) => ((h.title || '') + (h.snippet || '')).includes('ConPTY')), 20000);
      H.assert(Array.isArray(hits) && hits.some((h) => ((h.title || '') + (h.snippet || '')).includes('ConPTY')), '写入后 kg 应能检索到新主题(索引已更新)');
    });

    if (pick('1b')) await r.test('1b 网页摄入(web-scrape 真实驱动浏览器)', async () => {
      if (!chromeUp()) {
        try { execFileSync('wscript', [path.join(H.REPO, 'scripts', 'launch-scrape-chrome.vbs')], { encoding: 'utf8' }); } catch (_) {}
        await H.waitFor(() => chromeUp(), (v) => v === true, 15000, 1000);
      }
      if (!chromeUp()) H.skip('调试 Chrome 未就绪(9222)且无法拉起，跳过网页采集端到端(环境问题, 非功能缺陷)');
      let reply = '';
      try { reply = await s.say('帮我打开 http://example.com 这个网页，把页面正文读出来给我看看。'); }
      finally { try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(H.REPO, 'scripts', 'close-scrape-chrome.ps1')], { encoding: 'utf8' }); } catch (_) {} }
      H.assert(/Example Domain|illustrative|example|示例|文档/i.test(reply), '应读到 example.com 正文: ' + reply.slice(0, 200));
    });

    // 场景 1c 视频内容提取 无自动化端到端测试：video-transcribe 已落地并更名 douyin-transcribe(抖音→豆包办公任务+剪贴板取回)。
    // 全程需真实调试浏览器/豆包账号/剪贴板, 无法在此自动跑；验证靠实跑(抖音转写已端到端验证通过)。

    if (pick('1d')) await r.test('1d 批量摄入(先确认范围→入库→汇报)', async () => {
      const batchDir = path.join(H.REPO, 'workspace', 'tmp', 'batch-test');
      fs.mkdirSync(batchDir, { recursive: true });
      fs.writeFileSync(path.join(batchDir, 'note1.md'), '# Rust 所有权\nRust 用所有权+借用检查在编译期保证内存安全，无需 GC。\n', 'utf8');
      fs.writeFileSync(path.join(batchDir, 'note2.md'), '# HTTP 缓存\nCache-Control 与 ETag 决定浏览器与 CDN 的缓存与再验证策略。\n', 'utf8');
      fs.writeFileSync(path.join(batchDir, 'note3.md'), '# 向量检索\n用 embedding 把文本映射到向量空间，近邻搜索实现语义检索。\n', 'utf8');
      const before = snap(['knowledge']);
      const reply1 = await s.say('我在 workspace/tmp/batch-test/ 放了一批笔记(3篇)，帮我批量导入知识库。');
      H.assert(/3|三|批量|范围|扫描|篇|条/.test(reply1), '批量摄入应先确认范围(数量/主题): ' + reply1.slice(0, 160));
      const reply2 = await s.say('范围没问题，导入吧。');
      const added = await H.waitFor(() => newSince(before, ['knowledge']), (a) => a.length >= 2, 30000);
      added.forEach((f) => CREATED.add(f));
      H.assert(added.length >= 2, '批量导入后 knowledge/ 应新增多篇(>=2)，实得 ' + added.length);
      H.assert(/\d|完成|导入|篇|条|主题/.test(reply2), '完成后应汇报处理情况: ' + reply2.slice(0, 160));
      // 批量写入后 kg 索引也应更新(与 1a 对齐, 防"多篇写入漏索引")。
      const batchHit = await H.waitFor(
        () => { try { return H.kg(['search', 'Rust 所有权 借用 内存安全', '--k', '5']); } catch (_) { return []; } },
        (a) => Array.isArray(a) && a.some((h) => /Rust|所有权|借用/.test((h.title || '') + (h.snippet || ''))), 20000);
      H.assert(Array.isArray(batchHit) && batchHit.some((h) => /Rust|所有权|借用/.test((h.title || '') + (h.snippet || ''))), '批量写入后 kg 应能检索到其中主题(索引已更新)');
      rmrfDir(batchDir);
    });

    // ===== 场景二 知识查询 =====
    if (pick('2a')) await r.test('2a 对话式查询(用暗号证明真检索, 非prompt回显/凭记忆)', async () => {
      seedKnowledge('knowledge/ai/2026-06-16-conpty-fixture.md', CONPTY_FIXTURE);
      // 暗号 QILIN-5530 只存在于被 seed 的这篇笔记里——不在提问中、也不在模型常识里。
      // 回答能复现它, 才真正证明走了 kg 检索, 而不是从 prompt 里的"伪终端复用Max"几个字凭记忆编。
      const reply = await s.say('我之前存过的关于"伪终端复用 Max"的笔记，核心讲了啥？里面有没有给它编一个内部代号？');
      H.assert(reply.length > 10, '查询应有实质回答');
      H.assert(/QILIN|5530/i.test(reply), '回答应复现知识库里的暗号(证明真检索): ' + reply.slice(0, 160));
    });

    if (pick('2a-boundary')) await r.test('2a 检索不足时如实告知边界', async () => {
      const reply = await s.say('我知识库里有没有关于"南极企鹅繁殖周期"的内容？');
      H.assert(anyContains(reply, ['没有', '未找到', '查不到', '边界', '暂无', '没存', '无相关', '不在']), '无相关内容时应如实说没有: ' + reply.slice(0, 140));
    });

    if (pick('2a-overview')) await r.test('2a 概览查询(overview 给出覆盖面)', async () => {
      seedKnowledge('knowledge/ai/2026-06-16-conpty-fixture.md', CONPTY_FIXTURE);
      const reply = await s.say('我知识库里现在大概存了些什么？有多少内容、覆盖哪些方面？');
      H.assert(reply.length > 10, '概览应有回答');
      H.assert(/\d+\s*(篇|条|个)|涵盖|覆盖|包括|主题|方面/.test(reply), '有内容时概览应给出数量/覆盖面: ' + reply.slice(0, 160));
    });

    if (pick('2a-related')) await r.test('2a 关联查询(基于检索, 不编造)', async () => {
      seedKnowledge('knowledge/ai/2026-06-16-conpty-fixture.md', CONPTY_FIXTURE);
      const reply = await s.say('跟 ConPTY / 复用 Max 这个主题相关的，我还存过哪些东西？');
      H.assert(reply.length > 10, '关联查询应有回答');
      H.assert(/ConPTY|终端|Max|复用/.test(reply) || anyContains(reply, ['没有', '暂无', '没存过', '没找到', '就这一篇', '只有这', '不多']), '关联查询应基于检索结果或如实告知边界: ' + reply.slice(0, 160));
    });

    // ===== 场景三 任务追踪 =====
    if (pick('3a')) await r.test('3a 任务登记', async () => {
      const before = snap(['tasks/active']);
      const reply = await s.say('我现在开始做一个任务：ProjectX 质量门模块测试。');
      H.assert(reply.length > 0, '应确认登记');
      const added = await H.waitFor(() => newSince(before, ['tasks/active']).filter((f) => safeRead(f).includes('ProjectX')), (a) => a.length >= 1, 15000);
      added.forEach((f) => CREATED.add(f));
      H.assert(added.length >= 1, 'tasks/active 应出现该任务 md');
      H.assert(/status:\s*running/.test(safeRead(added[0])), '新任务状态应为 running');
    });

    if (pick('3b')) await r.test('3b 进度更新(追加而非覆盖)', async () => {
      const exist = H.findFiles('tasks/active', '').filter((f) => safeRead(f).includes('ProjectX'));
      if (!exist.length) H.skip('需先跑 3a 登记任务(生命周期测试应顺序跑)');
      const lenBefore = safeRead(exist[0]).length;
      await s.say('ProjectX 那个任务跑到第三步了，调了个参数，下一步打算跑压力测试。');
      const file = await H.waitFor(
        () => H.findFiles('tasks/active', '').filter((f) => safeRead(f).includes('ProjectX')),
        (a) => a.length >= 1 && (safeRead(a[0]).includes('第三步') || safeRead(a[0]).includes('压力测试')), 15000);
      H.assert(file.length >= 1, '任务文件应存在');
      const body = safeRead(file[0]);
      H.assert(body.includes('第三步') || body.includes('压力测试'), '新进度应写入');
      H.assert(body.length > lenBefore, '应"追加"(正文应变长, 而非覆盖); 旧=' + lenBefore + ' 新=' + body.length);
    });

    if (pick('3c')) await r.test('3c 状态查询', async () => {
      const exist = H.findFiles('tasks/active', '').filter((f) => safeRead(f).includes('ProjectX'));
      if (!exist.length) H.skip('需先跑 3a 登记任务');
      const reply = await s.say('ProjectX 那个任务做到哪了？');
      // 必须返回真实进度内容(压力测试/第三步, 来自 3b), 而非仅复述任务名——后者凭记忆也能答, 证明不了读了任务文件。
      H.assert(reply.includes('压力测试') || reply.includes('第三步'), '应返回当前进度内容(压力测试/第三步), 而非仅复述任务名: ' + reply.slice(0, 140));
    });

    if (pick('3d')) await r.test('3d 任务完成(done + completed 时间戳)', async () => {
      const exist = H.findFiles('tasks/active', '').filter((f) => safeRead(f).includes('ProjectX'));
      if (!exist.length) H.skip('需先跑 3a 登记任务');
      await s.say('ProjectX 那个测试做完了。');
      const file = await H.waitFor(
        () => H.findFiles('tasks/active', '').filter((f) => safeRead(f).includes('ProjectX')),
        (a) => a.length >= 1 && /status:\s*done/.test(safeRead(a[0])), 15000);
      H.assert(file.length >= 1 && /status:\s*done/.test(safeRead(file[0])), '状态应变 done');
      H.assert(/completed:\s*\d{4}-\d{2}-\d{2}/.test(safeRead(file[0])), '完成应写 completed 时间戳(归档脚本据此判断): ' + safeRead(file[0]).slice(0, 220));
    });

    if (pick('3e')) await r.test('3e 定时提醒(创建计划任务)', async () => {
      const before = H.schedTasks('PocketAide-Remind-').length;
      const reply = await s.say('30分钟后提醒我检查测试结果。');
      H.assert(reply.length > 0, '应确认设定提醒');
      const tasks = await H.waitFor(() => H.schedTasks('PocketAide-Remind-'), (a) => a.length >= before + 1, 15000);
      H.assert(tasks.length >= before + 1, '应新建一个 PocketAide-Remind-* 计划任务, 现有: ' + tasks.join(','));
      // 该提醒由 cleanup() 据基线移除, 不会真的到点发飞书。
    });

    // ===== 场景五 通用助理 =====
    if (pick('5')) await r.test('5 通用助理(产物落 workspace 且不污染 knowledge)', async () => {
      const wsBefore = snap(['workspace']);
      const kBefore = snap(['knowledge']);
      // 明确要求"保存成 workspace 下的文件"——否则这么小的计算 claude 可能直接口算回答、不留产物。
      const reply = await s.say('帮我写一个 Python 脚本文件、保存到 workspace 目录下（别放 workspace/tmp 里），用它计算 1 到 100 的和，运行它并把结果告诉我。');
      H.assert(reply.includes('5050'), '应实际算出 1..100=5050: ' + reply.slice(0, 120));
      const isArtifact = (f) => !f.includes('.outbox') && !f.replace(/\\/g, '/').includes('workspace/tmp');
      const ws = await H.waitFor(() => newSince(wsBefore, ['workspace']).filter(isArtifact), (a) => a.length >= 1, 12000);
      ws.forEach((f) => CREATED.add(f));
      H.assert(ws.length >= 1, '产物应落在 workspace/, 新增=' + ws.length);
      const kNew = newSince(kBefore, ['knowledge']);
      H.assert(kNew.length === 0, '杂活绝不应污染 knowledge/, 却新增了: ' + kNew.join(','));
    });
  } finally {
    s.dispose();
  }

  const sum = r.summary();
  cleanup();
  process.exit(sum.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试运行器异常:', e); try { cleanup(); } catch (_) {} process.exit(2); });
