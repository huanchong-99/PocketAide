// send-reminder.js — standalone Feishu reminder sender (does NOT need the resident bridge).
// Usage:  node bridge/send-reminder.js "<body markdown>" "<title>"
// Sends one interactive card to the owner (OWNER_OPEN_ID). Exits non-zero on missing creds/args.
const { loadEnv } = require('./lib/config');
const { Feishu } = require('./lib/feishu');

async function main() {
  const body = process.argv[2];
  const title = process.argv[3] || '提醒';
  if (!body) {
    console.error('usage: node bridge/send-reminder.js "<body markdown>" "<title>"');
    process.exit(2);
  }

  const cfg = loadEnv();
  const missing = [];
  if (!cfg.appId) missing.push('FEISHU_APP_ID');
  if (!cfg.appSecret) missing.push('FEISHU_APP_SECRET');
  if (!cfg.ownerOpenId) missing.push('OWNER_OPEN_ID');
  if (missing.length) {
    console.error('[send-reminder] missing creds: ' + missing.join(', ') +
      (cfg._exists ? ' (in ' + cfg._path + ')' : ' (no .env at ' + cfg._path + ')'));
    process.exit(1);
  }

  const fs = new Feishu({ appId: cfg.appId, appSecret: cfg.appSecret });
  const messageId = await fs.sendCard(cfg.ownerOpenId, body, title);
  if (!messageId) {
    console.error('[send-reminder] send returned no message_id');
    process.exit(1);
  }
  console.log(messageId);
  // The Feishu constructor opens a WSClient handle that keeps the event loop alive.
  // We only needed the REST send; exit deterministically so runners don't hang.
  process.exit(0);
}

main().catch((e) => {
  console.error('[send-reminder] error: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
