// Phase 1A smoke test #1 — prove node-pty (ConPTY) works for IO + UTF-8 Chinese.
// Spawns cmd.exe in a pseudo-terminal, sends echo commands (incl. Chinese), captures
// output, verifies, and exits. Has a hard timeout so it can never hang.

const pty = require('node-pty');
const { stripAnsi } = require('./lib/strip-ansi');

const HARD_TIMEOUT_MS = 15000;
let buf = '';
let done = false;

const term = pty.spawn('cmd.exe', [], {
  name: 'xterm-color',
  cols: 120,
  rows: 30,
  cwd: process.cwd(),
  env: process.env,
});

term.onData((d) => { buf += d; });

term.onExit(({ exitCode }) => {
  finish(exitCode);
});

// Drive the shell. chcp 65001 -> UTF-8 so Chinese is not GBK-mangled.
const send = (s, delay) => setTimeout(() => term.write(s + '\r'), delay);
send('chcp 65001', 300);
send('echo SMOKE_OK_ascii', 900);
send('echo 你好世界_PTY', 1500);
send('exit', 2200);

const hardTimer = setTimeout(() => {
  console.error('FAIL: hard timeout — pty did not exit (possible hang)');
  try { term.kill(); } catch (_) {}
  finish(124);
}, HARD_TIMEOUT_MS);

function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(hardTimer);
  const clean = stripAnsi(buf);
  const hasAscii = clean.includes('SMOKE_OK_ascii');
  const hasCJK = clean.includes('你好世界_PTY');
  console.log('--- captured (cleaned, tail) ---');
  console.log(clean.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'));
  console.log('--- result ---');
  console.log('ascii echo captured:', hasAscii);
  console.log('chinese (UTF-8) captured:', hasCJK);
  const pass = hasAscii && hasCJK;
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(pass ? 0 : 1);
}
