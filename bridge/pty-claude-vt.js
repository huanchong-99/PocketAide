// Phase 1A core test (命门), v2 — drive `claude` in a ConPTY AND render the stream
// through a headless terminal emulator (@xterm/headless) so overlapping redraws
// (spinner frames vs. the real reply) resolve into the actual on-screen text.
// This is the capture strategy the real bridge will use. Still: no -p / SDK / API key.
//
// Usage: node pty-claude-vt.js ["prompt"]

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const PROMPT = process.argv[2] || '请只用一行中文回答：1+1 等于几？';
const COLS = 120, ROWS = 40;
const BOOT_MS = Number(process.env.BOOT_MS || 7000);
const IDLE_MS = Number(process.env.IDLE_MS || 5000);
const HARD_MS = Number(process.env.HARD_MS || 75000);
const CLAUDE = process.env.CLAUDE_EXE || 'claude.exe';

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true });

let lastDataTs = Date.now();
let promptSentTs = 0;
let bytesAfterPrompt = 0;
let done = false;

console.log(`[vt] launching ${CLAUDE} --dangerously-skip-permissions (Max login, no API key=${!process.env.ANTHROPIC_API_KEY})`);

const p = pty.spawn(CLAUDE, ['--dangerously-skip-permissions'], {
  name: 'xterm-256color', cols: COLS, rows: ROWS,
  cwd: process.cwd(), env: { ...process.env, LANG: 'zh_CN.UTF-8' },
});

p.onData((d) => {
  term.write(d);
  lastDataTs = Date.now();
  if (promptSentTs) bytesAfterPrompt += d.length;
});
p.onExit(({ exitCode }) => finish(exitCode === 0 ? 0 : 2, 'child-exit'));

setTimeout(() => {
  console.log(`[vt] >>> sending: ${PROMPT}`);
  p.write(PROMPT);
  setTimeout(() => p.write('\r'), 400);
  promptSentTs = Date.now();
}, BOOT_MS);

const idleTimer = setInterval(() => {
  if (!promptSentTs || done) return;
  if (bytesAfterPrompt > 0 && Date.now() - lastDataTs > IDLE_MS) finish(0, 'idle-complete');
}, 750);
const hardTimer = setTimeout(() => finish(124, 'HARD-TIMEOUT'), HARD_MS);

function screenLines() {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const ln = b.getLine(i);
    if (ln) out.push(ln.translateToString(true).replace(/\s+$/, ''));
  }
  return out;
}

// Heuristic extraction: assistant replies render as lines starting with "● ".
// Exclude the known status/effort line "● high · /effort".
function extractReply(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => /^●\s+/.test(l))
    .filter((l) => !/\/effort|running stop hook|tokens\)/.test(l))
    .map((l) => l.replace(/^●\s+/, ''));
}

function finish(code, reason) {
  if (done) return;
  done = true;
  clearInterval(idleTimer);
  clearTimeout(hardTimer);
  // flush the emulator parser, then read the resolved screen
  term.write('', () => {
    const lines = screenLines().filter(Boolean);
    const reply = extractReply(lines);
    console.log('\n========== VT SUMMARY ==========');
    console.log('reason:', reason, '| hang?:', reason === 'HARD-TIMEOUT' ? 'YES' : 'no');
    console.log('bytes after prompt:', bytesAfterPrompt);
    console.log('--- resolved screen (clean, non-empty) ---');
    console.log(lines.join('\n'));
    console.log('--- extracted assistant reply (heuristic) ---');
    console.log(reply.length ? reply.join('\n') : '(none matched)');
    console.log('================================');
    try { p.write('\x03'); } catch (_) {}
    setTimeout(() => { try { p.kill(); } catch (_) {} process.exit(code); }, 800);
  });
}
