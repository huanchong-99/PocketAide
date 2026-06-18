// 通过 CDP 轮询豆包页面，等办公任务（抖音转写）完成后把全文写到文件并退出。
// 完成 = 出现「朗读」按钮 或 「任务已完成」标记 && 无生成中字样 && innerText 长度连续两次稳定。
// 异常（登录/验证/报错且无完成信号）或超时 → 退出码 2，输出原因。
//
// 修复记录（2026-06-18）：
//   旧版 hasRead 只查 aria-label==='朗读'，但豆包页面"朗读"写在 innerText，导致永远判 false → 误超时报 TRANSCRIPT_FAIL。
//   现在 aria-label 与 innerText 都查；并加 doneMarker（"任务已完成"）做第二完成信号，双保险。
const http = 'http://127.0.0.1:9222';

async function getDoubaoWsUrl() {
  const res = await fetch(http + '/json');
  const tabs = await res.json();
  const t = tabs.find(x => x.type === 'page' && /doubao\.com\/chat/.test(x.url || ''));
  return t ? t.webSocketDebuggerUrl : null;
}

const EXPR = `(() => {
  const main = document.querySelector('main') || document.body;
  const t = main.innerText || '';
  // 「朗读」按钮：豆包页面文字可能写在 aria-label 或 innerText，两种都查（旧 bug：只查 aria-label 漏判）
  const hasRead = [...document.querySelectorAll('button')].some(b => {
    const al = (b.getAttribute('aria-label')||'').trim();
    const tx = (b.innerText||'').trim();
    return al === '朗读' || tx === '朗读';
  });
  // 备用完成信号：页面出现"任务已完成"标记（办公任务收尾文案）
  const doneMarker = /任务已完成|已完成\\(|生成完毕|文字转写：/.test(t);
  const generating = /停止|生成中|正在(生成|思考|转写)|思考中/.test(t);
  let failReason = '';
  if (!hasRead && !doneMarker) {
    const m = t.match(/请求用户协助|去操作|请登录|登录后|需要验证|服务繁忙|生成失败|发生错误|网络异常|网络错误|无法访问|请求失败|出错了/);
    if (m) failReason = m[0];
  }
  return JSON.stringify({len:t.length, hasRead, doneMarker, generating, failReason, text:t});
})()`;

async function evalOnce(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let done = false;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression: EXPR, returnByValue:true}}));
    });
    ws.addEventListener('message', (ev) => {
      if (done) return;
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        done = true;
        try {
          const v = JSON.parse(msg.result.result.value);
          resolve(v);
        } catch (e) { reject(e); }
        ws.close();
      }
    });
    ws.addEventListener('error', () => { if (!done) { done=true; reject(new Error('ws error')); } });
    setTimeout(() => { if (!done) { done=true; reject(new Error('timeout')); try{ws.close();}catch(e){} } }, 15000);
  });
}

(async () => {
  const startedAt = Date.now();
  const HARD_TIMEOUT_MS = 13 * 60 * 1000; // 13 分钟硬上限（豆包办公任务可能跑 10+ 分钟）
  let prevLen = -1;
  let stableCount = 0;

  while (true) {
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
      console.log('TRANSCRIPT_FAIL: 超时（13分钟）仍无完整文字稿');
      process.exit(2);
    }
    let wsUrl;
    try { wsUrl = await getDoubaoWsUrl(); } catch (e) { wsUrl = null; }
    if (!wsUrl) { console.log('TRANSCRIPT_FAIL: 找不到豆包页面 tab'); process.exit(2); }

    let st;
    try { st = await evalOnce(wsUrl); }
    catch (e) { console.log('poll error: ' + e.message); await new Promise(r=>setTimeout(r,5000)); continue; }

    const { len, hasRead, doneMarker, generating, failReason } = st;
    const done = hasRead || doneMarker;
    console.log(`poll len=${len} hasRead=${hasRead} doneMarker=${doneMarker} generating=${generating} fail=${failReason||''} elapsed=${Math.round((Date.now()-startedAt)/1000)}s`);

    if (failReason) {
      console.log('TRANSCRIPT_FAIL: ' + failReason);
      process.exit(2);
    }

    if (done && !generating) {
      if (Math.abs(len - prevLen) < 50) {
        stableCount++;
      } else {
        stableCount = 1;
      }
      prevLen = len;
      if (stableCount >= 2 && len > 300) {
        const fs = require('fs');
        fs.writeFileSync('workspace/transcript.txt', st.text, 'utf8');
        console.log('TRANSCRIPT_DONE len=' + len + ' file=workspace/transcript.txt');
        process.exit(0);
      }
    } else {
      prevLen = len;
      stableCount = 0;
    }

    await new Promise(r => setTimeout(r, 5000));
  }
})();
