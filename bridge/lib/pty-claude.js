// PtyClaude — a long-lived interactive `claude` session driven over a ConPTY,
// rendered through a headless terminal emulator so redraws resolve to real screen text.
// Reuses the Max login (no -p / SDK / API key). One prompt at a time (serialized).
//
// Public API:
//   const c = new PtyClaude({ cwd, onReady, onError });
//   await c.start();
//   const reply = await c.ask('你的问题');   // resolves with the assistant's reply text
//   c.dispose();

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const SEP = /^[─-]{20,}$/;                       // full-width input-box separators
const SPINNER = /^[✻✽✶✢✳✻·*]/;                  // spinner frame leads
// Claude Code 偶发的会话反馈调查浮层。它会盖住/截断回复, 抓屏会误把它当成回复
// (实测把 "How is Claude doing this session? 1: Bad 2: Fine..." 当成了算 5050 的答案)。
// 既要在抓屏时过滤掉它(NOISE), 也要在抓屏前主动消掉它(_dismissSurvey)。
const SURVEY = /How is Claude doing this session|Bad\s+\d:\s*Fine|\d:\s*Dismiss/i;
const NOISE = /(Cooked for|Baked for|running stop hook|esc to interrupt|\/effort|tokens\)|How is Claude doing|Bad\s+\d:\s*Fine|\d:\s*Dismiss|\(optional\)\s*$)/i;
const PROMPT_ECHO = /^[❯>]/;                     // echoed user input line
// "工作中"指示：底部活跃 spinner(进行时省略号)、活跃计时/token 流、或 "esc to interrupt"。
// 用来判断这一轮 claude 是否还在干活——还在转圈就别收尾。过去时完成提示("Cogitated for 1m 8s"、
// "Crunched for 37s")不含省略号/活跃计时/token 流, 故不会被误判为工作中。实测一例(联网抓帖被误杀):
// 屏底是 "✶ Manifesting… (1m 59s · ↓ 3.2k tokens · thinking)"——明明在思考, 却被 hardMs 砍断报超时。
const WORKING = /[✶✻✽✢✳]\s+\S+…|esc to interrupt|·\s*thinking\b|↓\s*[\d.]+\s*k?\s*tokens/i;

class PtyClaude extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cwd = opts.cwd || process.cwd();
    this.exe = opts.exe || process.env.CLAUDE_EXE || 'claude.exe';
    // 让桥接的 claude 用一个独立的 CLAUDE_CONFIG_DIR(自带 projects/会话、复制来的 Max 凭据)。
    // cwd 仍钉死仓库(CLAUDE.md 自动加载、相对路径/kg/outbox 全部照常)，但会话分桶到这个独立 home，
    // 于是 -c "续最近一段对话" 只会命中桥接自己的会话——开发用的另一个同 cwd claude 再也撞不进来。
    // 实测: Claude Code 按"规范化后的绝对 cwd"分桶(junction 会被解析回真身, 故 junction 无用);
    // 而 CLAUDE_CONFIG_DIR 能真正隔离会话且复制凭据后 Max 鉴权照常(零额外计费)。
    this.configDir = opts.configDir || null;
    // 会话恢复(连续性)三选一(优先级 resume > session-id > continueLast)，都未给 => 全新会话：
    //   continueLast(-c): 续"本 cwd 最近一段对话"。桥接重启走这条(本机 --session-id 实测不可 resume)。
    //   resumeId(--resume <id>) / sessionId(--session-id <id>): 按 id 恢复/固定，备用。
    this.resumeId = opts.resumeId || null;
    this.sessionId = opts.sessionId || null;
    this.continueLast = opts.continueLast || false;
    this.cols = opts.cols || 120;
    // Tall viewport: claude's TUI redraws in-place and does NOT push scrolled-off
    // lines to scrollback, so the viewport must be tall enough to hold the WHOLE reply.
    // Set very large so replies are never truncated (no arbitrary cap).
    this.rows = opts.rows || Number(process.env.PTY_ROWS || 3000);
    this.bootMs = opts.bootMs || 7000;
    this.idleMs = opts.idleMs || 5000;
    // 单轮硬上限只是"真卡死"的兜底安全网, 不该砍断仍在工作的长任务(联网研究/多工具调用可达数分钟)。
    // 旧值 2min 会误杀正常长任务(见 WORKING 注释里的实测), 放大到 15min；完成判定主要靠"空闲且无 spinner"。
    this.hardMs = opts.hardMs || Number(process.env.PTY_HARD_MS) || 900000;
    // 串行收尾的宽限窗口：屏幕已静默无 spinner、但本轮"权威产出"(outbox)还没写出时, 再等这么久。
    // 等到 => 正常收尾用产出; 超时仍无 => 判这轮没写产出, 收尾交调用方抓屏兜底。把"屏幕一停就走"
    // 和"产出写出"两件事强制对齐, 杜绝产出滞留到下一轮造成的回复错位。配置见 PTY_GRACE_MS。
    this.graceMs = opts.graceMs || Number(process.env.PTY_GRACE_MS) || 30000;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 20000, allowProposedApi: true });
    this.p = null;
    this.lastDataTs = 0;
    this.prevConvCount = 0;
    this.busy = false;
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      // 启动参数: resume > session-id > continue > 全新; 一律带 skip-permissions(复用 Max、不卡权限)。
      const args = [];
      if (this.resumeId) args.push('--resume', this.resumeId);
      else if (this.sessionId) args.push('--session-id', this.sessionId);
      else if (this.continueLast) args.push('-c');
      args.push('--dangerously-skip-permissions');
      const env = { ...process.env, LANG: 'zh_CN.UTF-8' };
      if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;   // 会话隔离到桥接专属 home
      this.p = pty.spawn(this.exe, args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        cwd: this.cwd, env,
      });
      let settled = false;                 // start() 只能 resolve/reject 一次
      let readyTimer = null;
      this.p.onData((d) => { this.term.write(d); this.lastDataTs = Date.now(); this.emit('data', d); });
      this.p.onExit(({ exitCode }) => {
        this.ready = false;
        if (!settled) {
          // 启动期就退出(最常见: --resume 一个不存在/损坏的会话)。让 start() 失败, 调用方据此
          // 快速回退到全新会话, 而不是误判"就绪"后向死 PTY 发问、白等 hardMs(还会触发重复启动竞态)。
          settled = true;
          if (readyTimer) clearTimeout(readyTimer);
          return reject(new Error('claude 启动即退出, code=' + exitCode));
        }
        // 稳态退出: 让在途 ask 立刻失败, 并广播 exit 供桥接重启(否则会挂到 hardMs)。
        if (this._activeDone) { const d = this._activeDone; this._activeDone = null; d(new Error('claude 会话中途退出, code=' + exitCode)); }
        this.emit('exit', exitCode);
      });
      // consider ready after boot settles（若此前已退出则不再 resolve）
      readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.term.write('', () => {
          this.ready = true;
          this.emit('ready');
          resolve();
        });
      }, this.bootMs);
    });
  }

  _screen() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const ln = b.getLine(i);
      if (ln) out.push(ln.translateToString(true).replace(/\s+$/, ''));
    }
    return out.filter((l) => l.length);
  }

  // Logical lines: join xterm soft-wrapped rows back into single lines.
  // Keeps blanks (as '') so paragraph breaks survive; caller decides.
  _logicalLines() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const ln = b.getLine(i);
      if (!ln) continue;
      const text = ln.translateToString(true).replace(/\s+$/, '');
      if (ln.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }

  // Grab the LATEST assistant reply: anchor on the last real "● " bullet, then take
  // it + following lines until the input box / next bullet / prompt echo. Robust to
  // scrolling and multi-turn (no dependence on cumulative line counts).
  _extractLatestReply() {
    const lines = this._logicalLines();
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (/^●\s+/.test(t) && !/^●\s+(high|medium|low)\b/.test(t)) { start = i; break; }
    }
    if (start === -1) return '';
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const t = lines[i].trim();
      if (i > start && (SEP.test(t) || PROMPT_ECHO.test(t) || /^●\s+/.test(t))) break;
      if (SPINNER.test(t) || NOISE.test(t)) continue;     // skip spinner/status frames
      if (/^●\s+(high|medium|low)\b/.test(t)) continue;   // skip effort indicator
      out.push(t.replace(/^●\s+/, ''));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ask(prompt, opts):
  //   opts.readySignal?: () => boolean —— 本轮"权威产出"是否已就绪(桥接传 outbox 新鲜判定)。
  // 这是本次修复的核心。旧逻辑只要"屏幕静默"就返回, 但"屏幕停下"和"claude 把最终回复写进 outbox"
  // 是先后两步、彼此异步：屏幕一停就走 → 本轮 outbox 还没落盘 → 它随后才写出、滞留 → 下一条消息那轮
  // 把上一轮的 outbox 当成新回复读走, 于是"新消息收到上一步内容"。把收尾对齐到产出写出, 异步缝焊死:
  //   · 屏幕静默(idle+无spinner) 且 readySignal() 为真 => 这轮真答完, 正常收尾(调用方用 outbox);
  //   · 屏幕持续静默超过 graceMs 仍等不到产出 => 判这轮没写 outbox, 收尾交调用方抓屏兜底;
  //   · 超过 hardMs => 卡死兜底。
  // 不传 readySignal 时退回老行为(纯屏幕静默判定), 保持向后兼容。
  ask(prompt, opts = {}) {
    if (!this.ready) return Promise.reject(new Error('session not ready'));
    if (this.busy) return Promise.reject(new Error('busy: a turn is already in progress'));
    this.busy = true;
    const readySignal = typeof opts.readySignal === 'function' ? opts.readySignal : null;
    return new Promise((resolve, reject) => {
      let sawData = false;
      let quietSince = 0;                 // 屏幕进入"静默且无 spinner"的起点(spinner/输出恢复则清零)
      const startTs = Date.now();
      this.p.write(prompt);
      setTimeout(() => this.p.write('\r'), 400);

      const onData = () => { sawData = true; };
      this.on('data', onData);

      const poll = setInterval(() => {
        const idle = Date.now() - this.lastDataTs;
        // 屏幕层面是否"停了"：见过输出 + 静默超 idleMs + 屏底已无"工作中"指示(spinner/计时/token/esc)。
        // 双条件缺一不可：长任务持续刷 spinner 不空闲 → 不误判超时；短暂思考停顿仍有 spinner → 不误判答完。
        const quiet = sawData && idle > this.idleMs && !this._isWorking();
        if (readySignal) {
          if (quiet && readySignal()) return done(null);          // 产出已就绪 + 屏幕停 => 真结束, 用 outbox
          if (quiet) { if (!quietSince) quietSince = Date.now(); else if (Date.now() - quietSince > this.graceMs) return done(null); }
          else quietSince = 0;                                     // 又开始干活了, 宽限重新计时
        } else if (quiet) {
          return done(null);                                      // 无 readySignal: 退回老行为(纯屏幕静默)
        }
        if (Date.now() - startTs > this.hardMs) { this._dumpHang(prompt); return done(new Error('ask hard-timeout')); }
      }, 600);

      const done = (err) => {
        clearInterval(poll);
        this.removeListener('data', onData);
        this.busy = false;
        this._activeDone = null;
        if (err) return reject(err);
        // 反馈调查浮层会盖住/截断回复, 先消掉(ESC)、等重绘, 再抓屏。
        this._dismissSurvey(() => {
          this.term.write('', () => resolve(this._extractLatestReply()));
        });
      };
      this._activeDone = done;   // so onExit can fail this ask if claude dies mid-turn
    });
  }

  // 屏幕底部是否仍有"工作中"指示(见 WORKING)。只看尾部 50 行, 避免历史里残留的旧 spinner 帧误判。
  _isWorking() {
    try { return WORKING.test(this._logicalLines().slice(-50).join('\n')); }
    catch (_) { return false; }
  }

  // 若屏上有反馈调查浮层, 按 ESC 消掉并等 TUI 重绘, 露出真正的回复后再抓屏。
  // 无浮层时只是对空闲输入框发个 ESC, 无副作用。
  _dismissSurvey(cb) {
    let screen = '';
    try { screen = this._logicalLines().join('\n'); } catch (_) {}
    if (SURVEY.test(screen)) {
      try { this.p.write('\x1b'); } catch (_) {}
      setTimeout(cb, 700);
    } else { cb(); }
  }

  // 硬超时(卡死)时把当时整屏 dump 到 workspace/tmp, 便于事后定位 claude 卡在哪一步
  // (否则只剩一句 "ask hard-timeout", 看不到现场)。best-effort, 绝不二次抛错。
  _dumpHang(prompt) {
    try {
      const dir = path.join(this.cwd, 'workspace', 'tmp');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, 'pty-hang-' + stamp + '.txt');
      const screen = this._logicalLines().join('\n');
      fs.writeFileSync(file, '# PTY 卡死现场 dump\n# prompt: ' + String(prompt || '').slice(0, 300) + '\n# hardMs=' + this.hardMs + '\n\n' + screen, 'utf8');
      this.emit('hang', file);
    } catch (_) {}
  }

  dispose() {
    try { this.p && this.p.write('\x03'); } catch (_) {}
    setTimeout(() => { try { this.p && this.p.kill(); } catch (_) {} }, 500);
  }
}

module.exports = { PtyClaude };
