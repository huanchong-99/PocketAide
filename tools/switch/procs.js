'use strict';
/**
 * 进程层 —— 切换供应商的"让它真生效"那一半。
 *
 * 【为什么必须有这层】Claude Code **只在启动时读一次 settings.json**，跑着的会话不会热加载。
 * 所以"切换 = 改文件"是假生效：文件写完了，终端里那个 claude 还在用旧供应商，飞书那个也是。
 * 真正的切换必须是：先落盘新配置 → 杀掉在跑的会话 → 它重启时读到新配置。顺序不能反
 * （先杀再写会留出窗口期，重启进程可能抢在写入前读到旧值）。
 *
 * 【安全底线】绝不杀死调用者自己所在的那个会话。Claude Code 会把自己的 pid 放在环境变量
 * CLAUDE_PID 里，据此排除；否则"帮你切个供应商"会变成"把你正在说话的窗口干掉"。
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

/** 调 PowerShell 取 JSON。中文路径必须显式 UTF-8，否则 CommandLine 回来是乱码、匹配不上仓库路径。 */
function psJson(script) {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
  } catch (e) { return []; }
  const s = (out || '').trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch (_) { return []; }
}

/**
 * 找出与本系统相关的进程，并分好类。
 *   bridgeNode     —— node bridge/main.js，飞书桥接主进程
 *   bridgeClaude   —— 桥接用 ConPTY 拉起的 claude（父进程是 bridgeNode）
 *   terminalClaude —— 其余 claude 会话（用户自己在终端开的，含调用者本身）
 */
function scan() {
  const rows = psJson(
    `@(Get-CimInstance Win32_Process -Filter "Name='claude.exe' or Name='node.exe'" |` +
    ` Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate) | ConvertTo-Json -Depth 3 -Compress`
  );
  const repoRe = new RegExp(escapeRe(REPO).replace(/\\\\/g, '[\\\\/]'), 'i');

  const all = rows.filter(Boolean).map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: String(r.Name || '').toLowerCase(),
    cmd: String(r.CommandLine || ''),
    startedAt: parseCimDate(r.CreationDate),   // 毫秒时间戳；拿不到则 null
  }));

  const bridgeNode = all.filter((p) => p.name === 'node.exe' && /bridge[\\/]main\.js/i.test(p.cmd) && repoRe.test(p.cmd));
  const bridgePids = new Set(bridgeNode.map((p) => p.pid));
  const claudes = all.filter((p) => p.name === 'claude.exe' && isClaudeCodeCli(p));
  const bridgeClaude = claudes.filter((p) => bridgePids.has(p.ppid));
  const bridgeClaudePids = new Set(bridgeClaude.map((p) => p.pid));
  const terminalClaude = claudes.filter((p) => !bridgeClaudePids.has(p.pid));

  return { bridgeNode, bridgeClaude, terminalClaude, self: selfPid() };
}

/**
 * 是不是 Claude Code CLI 进程。
 *
 * ⚠ 这个判定是本模块最要命的一处：**Claude 桌面应用的进程名同样是 claude.exe**
 * （`C:\Program Files\WindowsApps\Claude_*\app\Claude.exe`，外加一堆 Electron 子进程：
 * renderer / gpu-process / crashpad-handler / utility）。首版实测一扫就混进来 11 个，
 * 若照单全杀，一句"帮我切供应商"会把用户的 Claude 桌面版连窗带聊天一起干掉。
 * 故这里用排除法把桌面应用整族剔干净，只留真正的 CLI。
 */
function isClaudeCodeCli(p) {
  const c = p.cmd || '';
  if (/--type=/i.test(c)) return false;                  // Electron 子进程一律带 --type=
  if (/[\\/]WindowsApps[\\/]/i.test(c)) return false;     // 微软商店分发的桌面应用
  if (/[\\/]app[\\/]Claude\.exe/i.test(c)) return false;  // 桌面应用主进程
  return true;
}

/** 调用者自己所在的 claude 会话 pid。Claude Code 通过 CLAUDE_PID 暴露；拿不到就返回 null。 */
function selfPid() {
  const v = Number(process.env.CLAUDE_PID);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ConvertTo-Json 把 CIM 日期序列化成 "/Date(1789488079899)/"，取出毫秒时间戳。 */
function parseCimDate(v) {
  if (!v) return null;
  const m = /\/Date\((\d+)/.exec(String(v));
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 杀进程树。/T 带上子进程（claude 会拉起 mcp 子进程），/F 强杀。返回是否已不存在。 */
function kill(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (_) {
    return !alive(pid);   // taskkill 对"已经没了"的 pid 也报错，以实际存活为准
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 重启桥接侧的 claude 会话：只杀桥接拉起的那个 claude，**不杀桥接主进程**。
 * main.js 监听到 claude 退出会自行恢复（并在拉起前重新落地供应商配置），
 * 这样飞书那端不掉线、会话用 -c 续上，比整个桥接重启轻得多也稳得多。
 */
function restartBridgeSession() {
  const s = scan();
  if (!s.bridgeNode.length) return { ok: false, reason: '桥接未在运行（没找到 node bridge/main.js）' };
  if (!s.bridgeClaude.length) return { ok: true, killed: [], note: '桥接在跑但当前没有 claude 子进程，下次拉起即用新配置' };
  // 同 killTerminalSessions：调用者自己那个会话永不杀。正常情况下切换是从托盘/网页/终端发起的，
  // 调用者不会落在 bridgeClaude 里；但进程归类依赖父子关系(ConPTY 下未必稳)，万一判偏，
  // "帮你切个供应商"就变成"把正在回话的那个会话干掉"——宁可少杀一个并如实说明。
  const killed = [], targets = s.bridgeClaude.filter((p) => p.pid !== s.self);
  const skippedSelf = s.self && s.bridgeClaude.some((p) => p.pid === s.self);
  for (const p of targets) if (kill(p.pid)) killed.push(p.pid);
  return {
    ok: true, killed,
    skippedSelf: skippedSelf ? s.self : null,
    note: skippedSelf
      ? `跳过 pid ${s.self}（调用者自己，不自杀）——这个会话仍在旧配置上，需另行重启才生效`
      : '桥接会自动重新拉起 claude，届时读入新配置',
  };
}

/**
 * 结束终端侧的 claude 会话。默认排除调用者自己——否则这条命令会把下命令的人当场干掉。
 * 终端会话没有守护进程替你拉起，杀完需要用户自己重开窗口，这点由调用方如实告知。
 */
function killTerminalSessions({ includeSelf = false } = {}) {
  const s = scan();
  const targets = s.terminalClaude.filter((p) => includeSelf || p.pid !== s.self);
  const skippedSelf = s.self && !includeSelf && s.terminalClaude.some((p) => p.pid === s.self);
  const killed = [], failed = [];
  for (const p of targets) (kill(p.pid) ? killed : failed).push(p.pid);
  return { killed, failed, skippedSelf: skippedSelf ? s.self : null, total: s.terminalClaude.length };
}

module.exports = { scan, kill, alive, restartBridgeSession, killTerminalSessions, selfPid, isClaudeCodeCli };
