# B站视频取流 — reference

拿B站视频音频流。原理：用 chrome-devtools 打开B站页，**页面内 fetch playurl 接口**（`/x/player/wbi/playurl`），返回 DASH 音频流直链。**2026-06-25 实测验证通过**（code:0，拿到 akamai CDN 音频流，11MB wav 下载成功）。

> 关键发现：B站 playurl 接口**不需要手动 wbi 签名**——页面内 fetch（带 cookie）直接返回 `code:0`。比想象中简单，不必复刻 bili-note 的 wbi 算法。

## 前置
- 用 `launch-scrape-chrome.vbs` 起专用 Chrome（9222）。
- B站音频流带防盗链，下载带 `Referer: https://www.bilibili.com/`。实测**无需登录 cookie**（audio_url 带 `mid=0` 即可下）。

## 取流步骤（Claude 用 chrome-devtools 工具执行）

### 1. navigate 到B站页
```
navigate_page(url="<b23.tv 短链 或 bilibili.com/video/BVxxx>")
```
短链跳转到 `bilibili.com/video/BV1xxxxx`。从 `__INITIAL_STATE__` 取 bvid/cid。

### 2. evaluate_script 页面内 fetch playurl（拿音频流 + 字幕）
```js
async () => {
  document.querySelectorAll('video,audio').forEach(e=>{e.muted=true;e.volume=0;}); // 静音：压住视频自动播放（launch 已带 --mute-audio，此为兜底）
  const state = window.__INITIAL_STATE__ || {};
  const bvid = state.bvid || state.videoData?.bvid;
  const cid = state.videoData?.cid || state.cidInfo?.pages?.[0]?.cid;
  const r = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&fnver=0&fourk=1`, {credentials:'include', headers:{'Referer':'https://www.bilibili.com/'}});
  const j = await r.json();
  const d = j?.data || {};
  const audio = d.dash?.audio || [];
  return {
    ok: j?.code === 0,
    code: j?.code,
    bvid, cid,
    has_dash: !!d.dash,
    audio_url: audio[0]?.baseUrl || audio[0]?.base_url || '',
    n_audio: audio.length,
    subtitles: (d.subtitle?.subtitles||[]).map(s=>({lan:s.lan_doc, url:s.subtitle_url}))
  };
}
```

### 3a. 若有字幕（CC）—— 直接用，免 ASR
`subtitles` 里的 `url` 是字幕 json（`https://aisubtitle.hdslb.com/...`）。下载解析即得带时间轴文本。很多B站技术/官方视频自带字幕，**优先用字幕，省 ASR**。

### 3b. 若无字幕 —— 下载音频走 ASR
```bash
python scripts/download_audio.py --url "<audio_url>" --out workspace/tmp/<bvid>.wav --referer "https://www.bilibili.com/"
```

## 注意
- `audio_url` 带 `deadline`（时效），现取现用、几分钟内下完。
- 下载必须带 `Referer: https://www.bilibili.com/`。
- `code` 非 0：视频限流/需登录/地区限制——如实报告，别硬来。
- 连续失败 2 次停下报告（[[skill-means-determinism]] 防死循环）。
