# 抖音视频取流（路线B）— reference

拿抖音视频直链。原理：用 chrome-devtools 打开抖音页，**页面内 fetch detail 接口，抖音 SDK 自动补 a_bogus 签名**，返回 play_addr 直链。**2026-06-25 实测验证通过**（status_code:0，拿到 zjcdn 真实直链，多清晰度）。

> 铁律：**绝不脱离浏览器自己算 a_bogus**（维护地狱）。只在页面里 fetch，让 SDK 补签名——抖音怎么改签名都不影响（浏览器永远对）。

## 前置
- 用 `launch-scrape-chrome.vbs` 起专用 Chrome（9222），它有 fresh cookie。
- 抖音不强制登录，专用 profile 的匿名 session cookie 就够。

## 取流步骤（Claude 用 chrome-devtools 工具执行）

### 1. navigate 到抖音页
```
navigate_page(url="<抖音短链 v.douyin.com/xxx 或 douyin.com/video/xxx>")
```
短链会跳转到 `douyin.com/video/{aweme_id}`。从最终 URL 取 `aweme_id`（纯数字）。

### 2. evaluate_script 页面内 fetch detail（拿直链）
```js
async () => {
  document.querySelectorAll('video,audio').forEach(e=>{e.muted=true;e.volume=0;}); // 静音：压住视频自动播放（launch 已带 --mute-audio，此为兜底）
  const awemeId = '<从 URL 取的 aweme_id>';
  const baseParams = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=170400&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&os_name=Windows&platform=PC';
  const r = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&${baseParams}`, {credentials:'include', headers:{'Referer':'https://www.douyin.com/'}});
  const j = await r.json();
  const d = j?.aweme_detail || {};
  const v = d.video || {};
  const play = v.play_addr?.url_list?.[0] || '';
  return {
    ok: r.ok && j?.status_code === 0,
    desc: (d.desc||'').slice(0,80),
    duration: v.duration,
    play_url: play,
    referer: 'https://www.douyin.com/',
    formats: (v.bit_rate||[]).map(b=>({gear:b.gear_name, url:(b.play_addr?.url_list||[])[0]}))
  };
}
```

### 3. 把 play_url 交给下载脚本
```bash
python scripts/download_audio.py --url "<play_url>" --out workspace/tmp/<aweme_id>.wav --referer "https://www.douyin.com/"
```

## 注意
- **直链有时效**（几小时），现取现用、几分钟内下载，别缓存。
- play_addr url 带防盗链，下载必须带 `Referer: https://www.douyin.com/`。
- `status_code` 非 0 / 无 play_url：刷新页面重新 fetch，或视频限流——如实报告，别硬来。
- 若同一会话连续失败 2 次，停下报告（[[skill-means-determinism]] 防死循环）。
