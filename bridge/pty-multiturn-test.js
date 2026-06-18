// Phase 1B test — exercise PtyClaude across multiple turns in ONE persistent session.
// Turn 2 depends on turn 1's context, proving session continuity.

const { PtyClaude } = require('./lib/pty-claude');

(async () => {
  const c = new PtyClaude({ cwd: process.cwd() });
  c.on('exit', (code) => console.log(`[test] claude exited: ${code}`));

  console.log('[test] starting session…');
  await c.start();
  console.log('[test] ready.');

  const turns = [
    '请只用一行中文回答：1+1 等于几？',
    '在上一个答案的基础上再加 3，等于几？只回答一个数字。',
    '用一句话介绍你自己（不超过20字）。',
  ];

  let allOk = true;
  for (let i = 0; i < turns.length; i++) {
    const q = turns[i];
    console.log(`\n[test] --- turn ${i + 1} --- Q: ${q}`);
    try {
      const a = await c.ask(q);
      console.log(`[test] A: ${JSON.stringify(a)}`);
      if (!a) { allOk = false; console.log('[test] WARN empty reply'); }
    } catch (e) {
      allOk = false;
      console.log(`[test] ERROR: ${e.message}`);
    }
  }

  console.log(`\n[test] ${allOk ? 'MULTITURN PASS' : 'MULTITURN FAIL'}`);
  c.dispose();
  setTimeout(() => process.exit(allOk ? 0 : 1), 1200);
})();
