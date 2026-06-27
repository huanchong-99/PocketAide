---
name: video-note
description: 把抖音/B站/本地视频转成文字并整理成知识笔记。当用户发来视频链接（抖音 v.douyin.com / douyin.com/video、B站 b23.tv / bilibili.com/video）或本地音视频文件，要求"转写/转文字/做笔记/总结/记下来/整理一下"时，用这个 skill。覆盖 取流→下载→ASR转写(SenseVoice GPU)→整理笔记→入知识库 全链路，是原豆包云转写方案的稳定本地替代。
---

# video-note — 视频转写 + 笔记

## 做什么
视频链接/文件 → 音频 → 文字（SenseVoice ASR，GPU）→ 结构化笔记 → 入 knowledge/（二次确认）→ kg 索引。

## 环境（首次部署见 references/install.md：装 `.venv-video-note` venv + 下 SenseVoice/VAD 模型 + ffmpeg）
- **ASR venv**：`.venv-video-note\Scripts\python.exe`（Python 3.12 + funasr + torch CUDA）
- **ASR 模型**：`models/SenseVoiceSmall` + `models/speech_fsmn_vad`
- **ffmpeg**：download_audio.py 自动查找（WinGet 装的）
- **采集 Chrome**：9222，用 `scripts/launch-scrape-chrome.vbs` 起（启动带 `--mute-audio` 全程静音；取流完自动关，见流程「关闭采集 Chrome」）
- **中文路径**（仓库路径含中文时）：transcribe.py 自动 subst 盘符绕过；ASCII 路径（如默认）不触发，无需关心

## 调用约定
所有脚本用 venv 的 python 调，路径用仓库相对或绝对（中文 OK，脚本内部转 ASCII）：
- 仓库根 = `<仓库根>`（本机克隆的实际根路径，用 `git rev-parse --show-toplevel` 取）
- VPY = `<仓库根>\.venv-video-note\Scripts\python.exe`
- SCRIPTS = `<仓库根>\.claude\skills\video-note\scripts`

## 流程（唯一路径，严格按序）

### 0. 判定输入类型
- 抖音（`v.douyin.com` / `douyin.com/video/`）→ 【抖音】
- B站（`b23.tv` / `bilibili.com/video/`）→ 【B站】
- 本地文件路径（`.mp4`/`.wav`/...）→ 【本地】
- 拿不准 → 问用户，别猜

### 【启动采集 Chrome】（抖音/B站公共前置；本地路线跳过）
chrome-devtools MCP 配的是 `--browserUrl=http://127.0.0.1:9222`（只连已有实例，**自己不起 Chrome**）。取流前必须确保 9222 在监听——没开 chrome-devtools 全废。

**一条命令**（脚本内部自动探活→没开才 wscript 起 vbs→等+复探活，幂等）：
```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/launch-scrape-chrome.ps1
```
看 stdout：`READY ...` = 9222 就绪，继续取流；`FAILED ...` = 起不来，**立即停下向用户报告**"采集 Chrome 启动失败，9222 未就绪"，**绝不自行诊断**（见禁止清单）。

**关键**：必须用**相对路径** `scripts/launch-scrape-chrome.ps1`（cwd 是仓库根，相对路径无中文）。**绝不**在 bash 命令行里写中文路径调 powershell/cmd/wscript——仓库路径含中文，bash(UTF-8)→powershell(GBK) 会让中文乱码，Chrome 根本不会被启动（06-27 那次 `ask hard-timeout` 就栽在这：Chrome 压根没起来，claude 又没早停，自由诊断 chrome.exe 卡死 15 分钟）。

### 【抖音】取流（详见 references/douyin-fetch.md）
0. 前置：先【启动采集 Chrome】确认 9222 就绪
1. chrome-devtools `navigate_page` 到抖音链接（短链跳转后从最终 URL 取 aweme_id）
2. chrome-devtools `evaluate_script` 执行 **douyin-fetch.md 里的取流 JS（整段照抄，别改；JS 开头已含静音行）** → 拿 play_url
3. → 【关闭采集 Chrome】→ 【下载+转写】

### 【B站】取流（详见 references/bili-fetch.md）
0. 前置：先【启动采集 Chrome】确认 9222 就绪
1. chrome-devtools `navigate_page` 到B站链接
2. chrome-devtools `evaluate_script` 执行 **bili-fetch.md 里的取流 JS（整段照抄；JS 开头已含静音行）** → 拿 audio_url + subtitles
3. **若有字幕（CC）**：下字幕 json 解析成文本（省 ASR），→ 【关闭采集 Chrome】→ 【整理笔记】
4. **若无字幕**：拿 audio_url → 【关闭采集 Chrome】→ 【下载+转写】

### 【关闭采集 Chrome】（取流拿到直链/字幕**后立即关**）
拿到 play_url / audio_url / 字幕后立即关采集 Chrome（后续下载用 ffmpeg、转写用本地 ASR，不再需要浏览器）：
```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/close-scrape-chrome.ps1
```
只关 9222 调试实例（按 profile/端口匹配），不碰日常 Chrome。【本地】路线没开浏览器，跳过此步。

### 【本地】
直接用文件路径 → 【转写】（先 ffmpeg 转 16k mono wav）

### 【下载+转写】（Bash 跑脚本）
```
# 1. 下载音频
<VPY> <SCRIPTS>/download_audio.py --url "<直链>" --out workspace/tmp/<id>.wav --referer "<平台 referer>"
# 抖音 referer=https://www.douyin.com/  B站 referer=https://www.bilibili.com/

# 2. 转写（默认 GPU + VAD，自动处理中文路径）
<VPY> <SCRIPTS>/transcribe.py --audio workspace/tmp/<id>.wav --out workspace/tmp/<id>.txt
```

### 【整理笔记】
1. 读 `workspace/tmp/<id>.txt`
2. Claude 整理成结构化笔记：标题、核心要点、摘要（按视频内容组织，不是流水账转写）
3. 调 **knowledge-write skill**：整理好的笔记发用户**二次确认**，通过才入 `knowledge/`
4. 入库后跑 kg 索引：`python tools/kg/kg.py index --file <knowledge相对路径>`

**笔记详略**（按视频时长 + 信息密度定篇幅，别一刀切、别灌水）：
- 短（<3min）/低密度（口播闲聊、流水账）：精简——核心要点 3-5 条 + 一句话摘要，**不硬扩**成长文
- 中（3-15min）/正常密度：标准结构（标题 + 核心要点 + 摘要）
- 长（>15min）/高密度（讲座、教程、干货盘点）：详细——按章节/主题分组、要点充分展开、可带小标题
- 原则：以**信息量**定篇幅，不是以视频时长定；密度低的不灌水，密度高的写足

**证据分级**（轻量标注，让用户分清"视频原话" vs "AI 引申"）：
- **原文要点**（来自字幕/转写的视频实际内容）：笔记主体，默认不额外标注
- **归纳/推断**（Claude 提炼的结论、引申、背景补充、跨内容关联）：用 `（归纳）` 标注，或单独放「延伸」小节
- 只在**明显是引申**时标，不必每条都标；高密度干货视频尤其要分清原文与归纳

## 工具职责（钉死，唯一序列）

| 步骤 | 工具 | 用途 |
|------|------|------|
| 取流 | chrome-devtools `navigate_page` + `evaluate_script` | 拿直链（JS 开头含静音行；页面自动签名，绝不自己算签名） |
| 关 Chrome | Bash + close-scrape-chrome.ps1 | 取流拿到直链/字幕后**立即关**采集 Chrome（只关 9222） |
| 下载 | Bash + download_audio.py | 直链 → 16k mono wav |
| 转写 | Bash + transcribe.py | wav → txt（SenseVoice GPU + VAD） |
| 整理 | Claude 读 txt 结构化 | txt → 笔记 |
| 入库 | knowledge-write skill | 二次确认 → knowledge/ |
| 索引 | Bash + kg.py index | 进知识图谱 |

## 禁止清单（摁死歧路，绝不绕路）
- ❌ **绝不脱离浏览器自己算抖音 a_bogus 签名**（维护地狱；只在页面 fetch 让 SDK 签）
- ❌ **绝不用 CapsWriter 转写**（不同系统各跑各的；ASR 只用本 skill 的 SenseVoice，不抢 CapsWriter 的 Vulkan GPU）
- ❌ **transcribe.py / download_audio.py 内部不改**（参数固定；中文路径脚本自动处理）
- ❌ **直链不缓存**（有时效，每次现取现下）
- ❌ **evaluate_script 只执行 reference 里给的取流 JS**（JS 开头已含静音行，执行取流即同时静音，无需额外静音调用）——不用它干别的（不 querySelector 找元素、不模拟点击、不截图找元素、不读页面文本）。取流 JS 之外的页面交互一律禁止。
- ❌ **启动采集 Chrome / 取流 / 下载 连续失败 2 次**（含启动后 9222 端口复探活失败）：停下向用户报告原因，不死循环重试
- ❌ **绝不自行诊断/换方式启动 Chrome**：启动只用 `launch-scrape-chrome.ps1`（相对路径调，它内部 wscript 起 vbs）。启动后端口复探活仍失败 → 立即停报告，**绝不**改用 cmd/headless、换版本子目录 exe、或在 bash 里直接调 `chrome.exe --version` 诊断（顶层 chrome.exe 是转发器，会挂住不返回；且 bash 命令行写中文路径调 powershell/cmd 会乱码——曾致整轮卡死 15 分钟触发 `ask hard-timeout`）
- ❌ **笔记不直接写 knowledge/**：必须经 knowledge-write 二次确认
- ❌ **模型不现下**：模型已在 `models/`，若缺失报错提示用户按 install.md 装，不自动联网下（慢且可能失败）
