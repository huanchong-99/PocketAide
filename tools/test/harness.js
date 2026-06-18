// 自动化测试夹具：用 PtyClaude 驱动一个独立的交互式 claude 会话，等价于"用户从飞书发消息"
// （项目用伪终端把飞书与本地 claude 打通，往 PTY 喂文本 === 飞书发送）。
// 发完消息后断言副作用（知识文件/kg/计划任务/任务md 等），实现全流程全自动测试，无需人类参与。
//
// 用法见 tools/test/run-all.js。
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { PtyClaude } = require('../../bridge/lib/pty-claude');

const REPO = path.join(__dirname, '..', '..');

// 一个会话：可连续 say() 多轮，模拟一段飞书对话（含二次确认这类多轮）。
class Session {
  constructor(opts = {}) {
    // 技能里会跑 kg 索引(首次加载嵌入模型可能数秒静默)、注册计划任务等，给足空闲/硬超时。
    this.opts = {
      cwd: REPO,
      idleMs: opts.idleMs || 12000,
      hardMs: opts.hardMs || 300000,
      bootMs: opts.bootMs || 8000,
    };
    this.c = new PtyClaude(this.opts);
  }
  async start() { await this.c.start(); }
  // 会话级致命错误(硬超时卡死 / 会话中途退出 / 未就绪)后, dispose 旧会话并重建一个全新的。
  // 让"一次卡死"只拖累当前这条用例, 而不是其后每条 say() 都各自硬超时、级联拖垮整套
  // (曾经 1d 卡死 → 后面 8 条全 5min 硬超时, 整套白跑 40min)。
  async restart() {
    try { this.c.dispose(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800)); // 给旧进程 Ctrl+C/kill 收尾
    this.c = new PtyClaude(this.opts);
    await this.c.start();
  }
  // 发一句话，返回本会话自己 PTY 屏幕抓取的回复。
  // **绝不读共享出件文件 workspace/.outbox/reply.md**：那是全局单文件，桥接/其他终端的 claude
  // 也会往里写，会串台（曾把别的会话的"5050"读成本测试的回复，导致假失败）。抓屏是本 PTY 独有、
  // 天然隔离；测试断言只看文本内容(关键词/副作用)，markdown 符号丢失不影响断言。
  async say(text) {
    try {
      return await this.c.ask(text);
    } catch (e) {
      // 会话已废(卡死/退出)→ 重建, 让下一条用例用新会话继续; 当前这条仍判失败。
      if (/hard-timeout|会话中途退出|session not ready|busy/.test((e && e.message) || '')) {
        try { await this.restart(); } catch (_) {}
      }
      throw e;
    }
  }
  dispose() { try { this.c.dispose(); } catch (_) {} }
}

// ---- 断言与辅助 ----
function assert(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }

// 环境不可用(如无网/无 Chrome)时跳过而非失败 —— 不把环境问题算作功能缺陷。
class SkipError extends Error { constructor(m) { super(m); this.isSkip = true; } }
function skip(reason) { throw new SkipError(reason); }

function fileExists(rel) { return fs.existsSync(path.join(REPO, rel)); }
function readFile(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

// 找匹配 glob 片段的文件（简单子串匹配相对路径），返回相对路径数组。
function findFiles(dirRel, substr) {
  const base = path.join(REPO, dirRel);
  const out = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (!substr || full.includes(substr)) out.push(path.relative(REPO, full));
    }
  })(base);
  return out;
}

// 跑 kg 命令，返回解析后的 JSON。
function kg(args) {
  const out = execFileSync('python', [path.join(REPO, 'tools', 'kg', 'kg.py'), ...args], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// 列出某前缀的计划任务名。
function schedTasks(prefix) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-ScheduledTask | Where-Object { $_.TaskName -like '${prefix}*' } | Select-Object -ExpandProperty TaskName`],
      { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// 轮询等待副作用落盘：claude 回复文字渲染完(屏幕静默)与"文件真正写盘+autocommit钩子跑完+kg索引完"
// 之间没有 happens-before 保证，turn 后立即读盘会 flaky。produce() 反复取值，ok() 判定满足即返回。
async function waitFor(produce, ok, timeoutMs = 15000, stepMs = 400) {
  const t0 = Date.now();
  let last = produce();
  while (!ok(last)) {
    if (Date.now() - t0 > timeoutMs) return last; // 超时返回当前值, 让断言给出有意义的失败信息
    await new Promise((r) => setTimeout(r, stepMs));
    last = produce();
  }
  return last;
}

// 简单测试聚合器。
class Runner {
  constructor() { this.results = []; }
  async test(name, fn) {
    const t0 = Date.now();
    try { await fn(); this.results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  PASS  ${name}`); }
    catch (e) {
      if (e && e.isSkip) { this.results.push({ name, skip: true, ms: Date.now() - t0, reason: e.message }); console.log(`  SKIP  ${name}\n        (${e.message})`); }
      else { this.results.push({ name, ok: false, ms: Date.now() - t0, err: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
    }
  }
  summary() {
    const pass = this.results.filter((r) => r.ok).length;
    const skip = this.results.filter((r) => r.skip).length;
    const fail = this.results.filter((r) => !r.ok && !r.skip).length;
    console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过 / 共 ${this.results.length} ====`);
    for (const r of this.results.filter((x) => !x.ok && !x.skip)) console.log(`  ✗ ${r.name}: ${r.err}`);
    for (const r of this.results.filter((x) => x.skip)) console.log(`  ⊘ ${r.name}: ${r.reason}`);
    return { pass, fail, skip, total: this.results.length, results: this.results };
  }
}

module.exports = { Session, Runner, assert, skip, SkipError, waitFor, fileExists, readFile, findFiles, kg, schedTasks, REPO };
