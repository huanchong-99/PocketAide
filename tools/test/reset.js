// 测试重置：把 knowledge/ tasks/active/ tasks/reminders/ 清回只剩 .gitkeep（删测试残留），
// 报告删了什么。计划任务的注销另由 PowerShell 做（Unregister-ScheduledTask）。
// 用法：node tools/test/reset.js
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DIRS = ['knowledge', 'tasks/active', 'tasks/reminders'];

function walk(d) {
  let out = [];
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

let removed = 0;
for (const rel of DIRS) {
  const base = path.join(REPO, rel);
  for (const f of walk(base)) {
    if (path.basename(f) === '.gitkeep') continue;
    try { fs.unlinkSync(f); removed++; console.log('del', path.relative(REPO, f)); } catch (e) { console.log('skip', f, e.message); } // 本机 fs.rmSync 删文件静默失效, 用 unlinkSync
  }
  // 删空子目录（保留顶层 DIRS 目录本身）
  for (const f of walk(base)) { /* noop */ }
}
// 清空子目录（如 knowledge/dev）
function pruneEmptyDirs(d, isRoot) {
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) if (e.isDirectory()) pruneEmptyDirs(path.join(d, e.name), false);
  if (!isRoot) {
    try {
      const left = fs.readdirSync(d);
      if (left.length === 0) { fs.rmdirSync(d); console.log('rmdir', path.relative(REPO, d)); }
    } catch (_) {}
  }
}
for (const rel of DIRS) pruneEmptyDirs(path.join(REPO, rel), true);

console.log(`\n清理完成，删除 ${removed} 个文件。`);
