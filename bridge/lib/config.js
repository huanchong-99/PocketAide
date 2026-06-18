// Minimal .env loader (no dependency). Reads bridge/.env and validates required keys.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const cfg = {};
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      cfg[k] = v;
    }
  }
  return {
    appId: cfg.FEISHU_APP_ID || '',
    appSecret: cfg.FEISHU_APP_SECRET || '',
    ownerOpenId: cfg.OWNER_OPEN_ID || '',
    _path: envPath,
    _exists: fs.existsSync(envPath),
  };
}

// Only the app credentials are required to START. OWNER_OPEN_ID can be discovered
// at runtime (discovery mode) by messaging the bot once.
function validate(cfg) {
  const missing = [];
  if (!cfg.appId) missing.push('FEISHU_APP_ID');
  if (!cfg.appSecret) missing.push('FEISHU_APP_SECRET');
  return missing;
}

module.exports = { loadEnv, validate };
