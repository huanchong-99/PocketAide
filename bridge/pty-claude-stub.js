// Phase 1A core test (命门) — drive interactive `claude` inside a ConPTY, reusing Max.
// Validates: (1) stable text send/receive, (2) skip-permissions => no hang on prompts.
// This is a STUB: a local console stands in for Feishu. It never uses `claude -p` / SDK / API key.
//
// Usage: node pty-claude-stub.js ["your prompt"]
// Safety: a hard timeout guarantees the harness itself can never hang.

const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripAnsi } = require('./lib/strip-ansi');

const PROMPT  = process.argv[2] || '请只用一行中文回答：1+1 等于几？';
const BOOT_MS  = Number(process.env.BOOT_MS  || 7000);   // wait for TUI to boot before typing
const IDLE_MS  = Number(process.env.IDLE_MS  || 5000);   // no output for this long after prompt => done
const HARD_MS  = Number(process.env.HARD_MS  || 75000);  // absolute cap; prevents any hang

const CLAUDE = process.env.CLAUDE_EXE || 'claude.exe';
const rawLog = path.join(os.tmpdir(), 'PocketAide-stub-raw.log');
fs.writeFileSync(rawLog, '');

let buf = '';
let lastDataTs = Date.now();
let promptSentTs = 0;
let bytesAfterPrompt = 0;
let done = false;

console.log(`[stub] launching: ${CLAUDE} --dangerously-skip-permissions`);
console.log(`[stub] cwd=${process.cwd()}`);
console.log(`[stub] ANTHROPIC_API_KEY set? ${Boolean(process.env.ANTHROPIC_API_KEY)} (expect false => using Max login)`);
console.log(`[stub] raw log: ${rawLog}`);

const term = pty.spawn(CLAUDE, ['--dangerously-skip-permissions'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 34,
  cwd: process.cwd(),
  env: { ...process.env, LANG: 'zh_CN.UTF-8' },
});

term.onData((d) => {
  buf += d;
  fs.appendFileSync(rawLog, d);
  lastDataTs = Date.now();
  if (promptSentTs) bytesAfterPrompt += d.length;
  // live view (cleaned), so we can watch the boot/dialog sequence
  process.stdout.write(stripAnsi(d));
});

term.onExit(({ exitCode }) => {
  console.log(`\n[stub] claude exited code=${exitCode}`);
  finish(exitCode === 0 ? 0 : 2, 'child-exit');
});

// Send the prompt once, after boot.
setTimeout(() => {
  console.log(`\n[stub] >>> sending prompt: ${PROMPT}`);
  term.write(PROMPT);
  setTimeout(() => term.write('\r'), 400); // submit on a separate tick
  promptSentTs = Date.now();
}, BOOT_MS);

// Idle-based end-of-response detection.
const idleTimer = setInterval(() => {
  if (!promptSentTs || done) return;
  const idle = Date.now() - lastDataTs;
  if (bytesAfterPrompt > 0 && idle > IDLE_MS) {
    finish(0, 'idle-complete');
  }
}, 750);

// Hard cap.
const hardTimer = setTimeout(() => finish(124, 'HARD-TIMEOUT'), HARD_MS);

function finish(code, reason) {
  if (done) return;
  done = true;
  clearInterval(idleTimer);
  clearTimeout(hardTimer);
  const clean = stripAnsi(buf);
  console.log('\n========== STUB SUMMARY ==========');
  console.log('reason:', reason);
  console.log('total bytes captured:', buf.length);
  console.log('bytes after prompt:', bytesAfterPrompt);
  console.log('hang?:', reason === 'HARD-TIMEOUT' ? 'YES (investigate)' : 'no');
  console.log('cleaned reply tail (last 20 non-empty lines):');
  console.log(clean.split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean).slice(-20).join('\n'));
  console.log('==================================');
  // try to quit claude gracefully, then force kill
  try { term.write('\x03'); } catch (_) {}
  setTimeout(() => { try { term.kill(); } catch (_) {} process.exit(code); }, 800);
}
