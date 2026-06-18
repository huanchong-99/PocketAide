// Single-instance guard via an exclusive lock file holding the owning PID.
// Prevents two bridges responding to the same Feishu messages.
const fs = require('fs');
const path = require('path');

const LOCK = path.join(__dirname, '..', '.bridge.lock');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Returns true if we acquired the lock; false if another live instance holds it.
function acquire() {
  try {
    // wx = create exclusively, fail if exists
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (old && isAlive(old) && old !== process.pid) return false; // another instance running
    // stale lock -> take over
    fs.writeFileSync(LOCK, String(process.pid));
  }
  const release = () => { try { if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch (_) {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
  return true;
}

module.exports = { acquire, LOCK };
