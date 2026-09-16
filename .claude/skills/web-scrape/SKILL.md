---
name: web-scrape
description: >-
  当用户发来一个网页链接时使用——无论只有链接，还是链接 + 一句话指令。它把调试浏览器开到那个网页、连上 chrome-devtools 浏览器
  MCP，之后由随附的那句话决定在页面上做什么（总结帖子、提取某楼层/某用户的评论、采集正文、查看页面信息等，完全开放）。
  Use this whenever the user sends a URL and wants you to read, summarize, extract, collect, or otherwise act on that page —
  forum threads, articles, comment sections, login-required pages included. Trigger even if the user only pastes a link with
  no instructions; default to fetching the main content. Do NOT use plain WebFetch/WebSearch for these — they can't reach
  the user's logged-in session; this skill drives the real browser with the user's persistent profile.
---

# web-scrape — 把浏览器开到网页并连上 MCP

这个 skill 只负责一条**固定通道**：把调试 Chrome 开到目标网页、连上浏览器 MCP，让你能像人坐在浏览器前一样操作这一页。
**到了页面之后具体做什么，由用户随链接发来的那句话决定**——这一步本 skill 不写死，因为需求是开放的：可能是"总结这帖讲了啥"，可能是"把 3 楼那个叫 X 的评论收下来"，也可能是"这页有个表格，导出来"。你照那句话做即可；只有一个链接、没指令时，默认抓主正文并简述。

浏览器 MCP 是本项目 `.mcp.json` 里的 **`chrome-devtools`**（连 `127.0.0.1:19222`），它在这一页**什么都能做**：读 a11y 文本、跑 JS 精确取数、点击、填表、截图、翻页。

## 第 1 步：确保调试 Chrome 已起（端口 19222）

**一条命令**（脚本内部自动探活 19222 → 没开才 wscript 起 vbs → 等 + 复探活，幂等）：

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/launch-scrape-chrome.ps1
```

看 stdout：`READY ...` = 19222 就绪，进第 2 步；`FAILED ...` = 起不来，停下向用户报告"采集 Chrome 启动失败，19222 未就绪"，**不要**自己换方式诊断（见边界）。

**关键**：必须用**相对路径** `scripts/launch-scrape-chrome.ps1`（cwd 是仓库根，相对路径无中文）。**绝不**在 bash 命令行里写中文路径调 powershell/cmd/wscript——仓库路径含中文时，bash(UTF-8)→powershell(GBK) 会让中文乱码、wscript 找不到 vbs、Chrome 根本不会被启动。

## 第 2 步：导航到用户给的 URL

用 `chrome-devtools` MCP 的 `navigate_page`（`type: "url"`）打开目标链接。
导航后可先 `list_pages` 确认当前页就是它。

## 第 3 步：按随附指令在页面上操作（开放，不约束）

这一步**听用户那句话的**。挑合适的 MCP 工具：

- **读内容 / 总结**：`take_snapshot`（拿 a11y 文本，适合通读），或 `evaluate_script` 跑 JS 精确取（如取标题 + 正文：论坛/文章常见 `.cooked`、`article`、`.fancy-title` 等选择器）。
- **定位某楼/某用户的评论**：`evaluate_script` 按选择器/用户名筛出目标块，别把整页一股脑塞回来。
- **需要交互**（展开折叠、翻页、登录后内容）：`click` / `fill` / 再 `navigate_page` reload。
- **可视判断**：`take_screenshot`。

要点：
- 用户说"第几点 / 哪个用户 / 哪段"这种**精确定位**时，优先 `evaluate_script` 精准取那一块，输出干净。
- 只给链接没指令 → 默认抓主正文（去导航/广告），给一段简述。
- **采集结果若要入知识库**：转交 `knowledge-write`，走二次确认再落盘——本 skill 不直接写 `knowledge/`。
- 中文页面注意编码正常（MCP 取到的是渲染后文本，一般没问题）。

## 第 4 步：收尾——关闭调试浏览器

任务**全部完成后**关掉调试 Chrome，避免长期挂着：

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/close-scrape-chrome.ps1
```

它只关"调试实例"（按 19222 / 专用 profile 匹配），**不碰用户的日常 Chrome**。
例外：如果用户正在该窗口里登录、或明确说要留着继续看，就**别关**。

## 边界

- 只在本仓库范围内活动；脚本用**相对路径** `scripts/...`（cwd 是仓库根）。**绝不**在 bash 命令行写中文绝对路径调 powershell/cmd——bash(UTF-8)→powershell(GBK) 会让中文乱码、脚本找不到（曾致 Chrome 起不来、claude 卡死）。
- 需登录的站点：专用 profile 已持久化登录态，用户一次性登录后可复用；过期再补登。
- 真要操作浏览器就走这个 skill，别用 `WebFetch`/`WebSearch` 代替——那俩到不了用户的登录会话。
