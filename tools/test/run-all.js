// 一键跑全部测试：先工具层单元(快、确定性强)，再逐场景端到端(经伪终端=飞书通道)。
// 用法: node tools/test/run-all.js
const path = require('path');
const { spawnSync } = require('child_process');

function run(label, file, args = []) {
  console.log('\n========== ' + label + ' ==========');
  const res = spawnSync('node', [path.join(__dirname, file), ...args], { cwd: path.join(__dirname, '..', '..'), stdio: 'inherit' });
  return res.status === 0;
}

const u = run('工具层单元测试 units.js', 'units.js');
const sc = run('逐场景端到端 scenarios.js', 'scenarios.js');

console.log('\n########## 总汇总 ##########');
console.log('  units.js     : ' + (u ? 'PASS' : 'FAIL'));
console.log('  scenarios.js : ' + (sc ? 'PASS' : 'FAIL'));
process.exit(u && sc ? 0 : 1);
