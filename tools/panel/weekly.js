#!/usr/bin/env node
'use strict';
/**
 * 每周任务体检推送。
 *
 * 【为什么这个比页面更要紧】页面解决"打开时看得清"，可它得你想起来去打开。
 * 停滞 92 天的任务不会自己跳出来喊——推送才会。所以这条不依赖面板是否运行、
 * 不依赖桥接是否在线，一个计划任务直接把结论送到飞书。
 *
 * 走 bridge/send-reminder.js 直发卡片（不注入会话）：体检是纯播报，没有上下文价值，
 * 不值得为它占用一轮对话。面板的改动播报才需要进上下文，那条走的是另一条路（events.js）。
 *
 * 用法：
 *   node tools/panel/weekly.js            算一遍并发飞书
 *   node tools/panel/weekly.js --dry-run  只打印，不发
 */

const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./tasks');

const REPO = path.resolve(__dirname, '..', '..');

function build(now = new Date()) {
  const all = T.loadAll();
  const h = T.healthCheck(all, now);
  const c = h.counts;
  const L = [];

  L.push(`**共 ${c.total} 个活跃任务** · 进行中 ${c.running} · 阻塞 ${c.blocked} · 已完成 ${c.done} · 已取消 ${c.cancelled}`);

  if (h.overdue.length) {
    L.push('', `**⛔ 已逾期 ${h.overdue.length} 个**`);
    for (const x of h.overdue.slice(0, 5)) L.push(`- ${x.title}（逾期 ${-x.left} 天）`);
  }
  if (h.dueSoon.length) {
    L.push('', `**📅 7 天内到期 ${h.dueSoon.length} 个**`);
    for (const x of h.dueSoon.slice(0, 5)) L.push(`- ${x.title}（${x.left === 0 ? '今天' : '剩 ' + x.left + ' 天'}）`);
  }
  if (h.stale.length) {
    L.push('', `**⏳ 停滞超过 ${h.staleThreshold} 天的进行中任务：${h.stale.length} 个**`);
    for (const x of h.stale.slice(0, 8)) L.push(`- ${x.title} —— **${x.days} 天**没动了`);
    if (h.stale.length > 8) L.push(`- …另有 ${h.stale.length - 8} 个`);
  }
  if (h.duplicates.length) {
    L.push('', `**🔁 疑似重复 ${h.duplicates.length} 组**`);
    for (const g of h.duplicates) L.push(`- ${g.map((x) => x.title).join('　×　')}`);
  }

  const clean = !h.overdue.length && !h.stale.length && !h.duplicates.length;
  if (clean) L.push('', '✅ 没有逾期、没有长期停滞、没有重复任务。');
  else L.push('', '---', '需要我改哪个，直接说；不想动的也可以让我关掉。');

  return { body: L.join('\n'), health: h, clean };
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const { body, clean } = build();
  if (dry) { process.stdout.write(body + '\n'); return; }
  // 全清爽时也发——"本周没有问题"本身就是有用的信息，而且能证明这条推送还活着。
  const title = clean ? '任务体检 · 一切正常' : '任务体检';
  try {
    execFileSync(process.execPath, [path.join(REPO, 'bridge', 'send-reminder.js'), body, title],
      { stdio: 'inherit', windowsHide: true });
  } catch (e) {
    process.stderr.write('推送失败: ' + (e && e.message) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { build };
