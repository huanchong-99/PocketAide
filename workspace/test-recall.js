// 临时验证脚本：真实测 feishu.sendText + recallMessage 链路（发一条"任务完成提醒"→立刻撤回）。
// 不依赖/不打扰正在运行的 bridge 主进程；独立起一个 node 进程，用同一套凭据发+撤。
const { Feishu } = require('../bridge/lib/feishu');
const { loadEnv } = require('../bridge/lib/config');

(async () => {
  const cfg = loadEnv();
  if (!cfg.appId || !cfg.appSecret) {
    console.error('SKIP: 缺少 FEISHU_APP_ID/SECRET');
    process.exit(2);
  }
  if (!cfg.ownerOpenId) {
    console.error('SKIP: 缺少 OWNER_OPEN_ID (discovery 模式未固定 owner)，无法定向测试');
    process.exit(2);
  }
  const fs = new Feishu({ appId: cfg.appId, appSecret: cfg.appSecret });

  console.log('1) 发送纯文本 "任务完成提醒" ->', cfg.ownerOpenId);
  const mid = await fs.sendText(cfg.ownerOpenId, '任务完成提醒');
  console.log('   发送返回 mid =', mid);
  if (!mid) { console.error('   FAIL: 发送未返回 mid'); process.exit(1); }

  console.log('2) 立刻撤回该消息 (client.im.message.delete)');
  await fs.recallMessage(mid);
  console.log('   撤回调用完成 (未抛异常即接口接受)');

  console.log('OK: 发送 + 撤回 链路验证通过');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', (e && e.code) || (e && e.message) || e);
  process.exit(1);
});
