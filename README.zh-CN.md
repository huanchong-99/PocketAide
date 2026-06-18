[English](README.md) | **中文**

# PocketAide

> 口袋随身 AI 秘书 —— 飞书聊天界面 + Claude Code 大脑 + 本地知识图谱长期记忆，跑在你自己的 Windows 上，复用 Claude Max 订阅、**零额外 API 费用**。

PocketAide 把 [Claude Code](https://claude.com/claude-code) 变成一个常驻的私人秘书：你在飞书里发消息，它通过伪终端驱动**交互式** `claude`（复用你的 Max 额度，**不**走按量付费 API），把回复发回飞书。它会管理本地知识库（语义检索 + 全文 + wikilink 图）、追踪任务、定时提醒、采集网页/抖音转写——所有数据留在你本机的 Git 仓库里。

> 💬 **交流讨论：** [LINUX DO](https://linux.do/)

## 它能做什么

- **飞书对话 → Claude Code**：飞书长连接收消息，伪终端（ConPTY）驱动交互式 `claude`，markdown 回复发回飞书
- **本地知识图谱（kg）**：bge-m3 向量 + SQLite FTS5 全文 + wikilink 关系图，三路混合检索；原子化知识笔记 + 写入前二次确认
- **任务追踪**：一任务一 md，进度追加，到期归档（只动已完成）
- **定时提醒**：注册成 Windows 计划任务，到点飞书通知，支持任意时区
- **网页采集 / 抖音转写**：驱动调试 Chrome，采集结果可入知识库
- **系统托盘常驻**：开机自启、心跳自愈、新对话全量重启

## 核心约束（设计取舍）

- **复用 Max、零额外费用**：伪终端驱动交互式 `claude`，不走 `-p` headless / Agent SDK / 按量 API
- **数据全本地**：本地 Git 仓库 + 每次写入自动 commit
- **Claude Code 是唯一决策中心**；知识写入前二次确认；Windows + 中文优先

## 知识图谱（kg）详细说明

知识检索由 `tools/kg/` 提供（`kg.py` + `embedder.py` + `embed_daemon.py`）。它**不是**自动构建的企业级知识图谱（没有实体抽取、关系抽取、本体、RDF/OWL、自动推理），而是面向个人知识库的**三路混合检索系统**：

| 检索路 | 做什么 | 技术 |
|---|---|---|
| **语义向量** | 按「意思」找，不靠字面命中 | bge-m3（1024 维，多语言）+ 余弦相似 |
| **全文检索** | 按关键词精确匹配 | SQLite FTS5（中文 unigram + bigram 切分） |
| **关系图** | 沿 `[[wikilink]]` 找关联笔记 | 手动标注的边 + `related` 图遍历 |

- `search` = 0.7×向量 + 0.3×全文 混合排序，返回标题/摘要/标签/来源
- `related` = 沿 wikilink 边做邻居遍历
- `overview` = 按 标签 / 子目录 / 类型 计数概览
- 数据存本地 SQLite（`nodes / vectors / fts / links`），索引库 `.index/` 不入库、可随时重建
- 嵌入模型常驻 daemon（`127.0.0.1:8199`），避开每次 ~12s 冷启动

> **关系靠你手动维护**：笔记之间用 `[[对方标题]]` 标 wikilink，kg 才知道它们关联；它不会自动从文本里抽取实体/关系。对「记笔记 + 语义/全文/关联检索」这个场景实用够用；但别期待它像 Wikidata / Neo4j 那样自动构建知识图谱。

## 前置依赖

- **Windows 10/11**（用 ConPTY、PowerShell 5.1、计划任务）
- **Node.js 20/22 LTS**（桥接进程；node-pty 原生模块对 Node 版本敏感，建议用 LTS，开发实测 Node 22）
- **Python 3.11+**（知识图谱模块；开发实测 3.14）
- **Claude Code CLI**（`claude`）+ **Claude Max 订阅**（项目核心就是复用 Max 额度）
- **飞书自建应用**（用「长连接」模式，详见 `bridge/SETUP-飞书.zh-CN.md`）
- **Chrome**（网页采集 / 抖音转写用，可选）

## 从零搭建

```bash
# 1. 克隆
git clone <repo-url> PocketAide
cd PocketAide

# 2. 装桥接依赖（Node）
cd bridge && npm install && cd ..

# 3. 装知识图谱依赖（Python）—— 首次会下载 bge-m3 模型（约 2.2GB）
pip install -r requirements.txt
python tools/kg/kg.py index --all    # 建索引；首次较慢

# 4. 配置飞书凭据
cp bridge/.env.example bridge/.env
#   编辑 bridge/.env，填 FEISHU_APP_ID / FEISHU_APP_SECRET / OWNER_OPEN_ID
#   飞书应用配置见 bridge/SETUP-飞书.zh-CN.md（务必选「长连接」，不要填回调网址）

# 5. 启动桥接（前台跑，验证用）
cd bridge && npm start
```

在飞书给应用发条消息，应能收到 Claude 的回复。

**常驻运行**（可选）：

```powershell
# 开机自启（注册计划任务 PocketAide-Bridge）
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
# 每日自动归档已完成任务
powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1
```

## 用 AI Agent 一键配置（推荐）

不想手动一步步装？把下面这段英文**整段复制**，粘贴给任意编程 Agent（Claude Code / Cursor / GitHub Copilot Chat / Codex CLI 等，让它在你 clone 好的仓库根目录运行），它会自动探测你这台机器的环境、补装缺的依赖、配好文件并验证：

```
You are setting up "PocketAide" on THIS machine. PocketAide is a personal AI
secretary that bridges Feishu (Lark) chat <-> an interactive `claude` CLI
(reusing a Claude Max subscription, NOT the pay-per-token API) <-> a local
knowledge graph. Target OS: Windows 10/11 (it relies on ConPTY, PowerShell 5.1,
and Windows Task Scheduler).

GOAL: make this repo runnable here. Detect what is installed, install what is
missing, configure, and verify. Stop and ask me before anything destructive or
before any paid install.

CONSTRAINTS:
- Needs: Node.js 20+ (22 LTS recommended), Python 3.11+, the `claude` CLI with an active Claude Max
  subscription, git.
- Bridge: `cd bridge && npm install`. `node-pty` builds a native module — if it
  fails, install "Desktop development with C++" (Visual Studio Build Tools) and
  retry.
- KG: `pip install -r requirements.txt`. First `python tools/kg/kg.py index --all`
  downloads the bge-m3 model (~2.2GB) and may take several minutes.
- Feishu: the user must create a self-built Feishu app, enable LONG CONNECTION
  (websocket) mode (do NOT set a request/callback URL), then fill `bridge/.env`
  (copy `bridge/.env.example`) with FEISHU_APP_ID / FEISHU_APP_SECRET /
  OWNER_OPEN_ID. See bridge/SETUP-飞书.md. Do not invent credentials — if a value
  is missing, tell me exactly what to get from the Feishu console and wait.

STEPS:
1. Detect versions: `node -v`, `python --version`, `claude --version`, `git
   --version`. Report any missing.
2. Install missing Node/Python if absent (ask first; prefer official installers
   or winget).
3. `cd bridge && npm install`. If node-pty fails, install VS Build Tools
   ("Desktop development with C++") and retry.
4. `pip install -r requirements.txt`.
5. Ensure `bridge/.env` exists (copy from `.env.example`); if empty, list exactly
   what I must fill and wait.
6. `python tools/kg/kg.py index --all` to build the index.
7. Smoke test: `python tools/kg/kg.py search "test" --k 3` returns JSON;
   `cd bridge && npm start` launches and connects to Feishu.
8. Summarize: what you installed, what I must do manually (Feishu app + Max
   subscription), and any warnings.

DO NOT: push to git, modify files outside this repo, or enter credentials for me.
```

## 目录结构

```
bridge/       飞书长连接 + 伪终端桥（Node）：main.js + lib/ + 托盘宿主
tools/kg/     知识图谱 CLI（kg.py + 嵌入常驻 daemon）：bge-m3 + FTS5 + wikilink
tools/tasks/  任务归档器
tools/test/   端到端测试套件（run-all.js 一键跑）
scripts/      计划任务注册 / Chrome 启停 等 PowerShell + VBS
.claude/      Claude Code 行为契约（CLAUDE.md）+ hooks + skills
knowledge/    知识库主体（你的笔记；example/ 是格式示例；本身是 Obsidian vault）
tasks/        active / archive / reminders 任务记录
workspace/    助理杂活产物（草稿、分析等）
CLAUDE.md     Claude Code 进入项目的行为契约（项目灵魂）
```

知识笔记格式见 `knowledge/example/`；任务/提醒格式见各 skill 的 `.claude/skills/*/SKILL.md`。

> `bridge/pty-*.js`（`pty-smoke` / `pty-claude-stub` / `pty-claude-vt` / `pty-multiturn-test`）是**开发期命门验证脚本**：在正式写桥接前，分步单独验证「伪终端能否复用交互式 `claude`、抓屏、多轮连续」这个最难的点。它们独立运行、**不被正式桥接 `main.js` 引用**，留着供想理解「伪终端怎么抓 claude 回复」原理的人参考；对普通使用无影响。

## 可选：用 Obsidian 可视化 + GitHub 云同步

`knowledge/` 本身就是一个 [Obsidian](https://obsidian.md) vault（已含 `.obsidian/` 配置）：

1. 装 Obsidian → 「Open folder as vault」选 `knowledge/`
2. 你的知识笔记、`[[wikilink]]` 双链关系图就能可视化浏览、跳转
3. 想云同步 / 多设备：把本仓库（或单独 `knowledge/`）推到一个 **private** GitHub 仓库，各设备 clone + pull 即可——知识库全本地、自己掌握

> ⚠️ 同步整个仓库务必用**私有**仓：`knowledge/`、`tasks/` 里会是你的个人笔记与任务。

## 已知约束

- **Windows-only**：ConPTY、PowerShell 5.1、Windows 计划任务深度绑定
- **复用 Max**：必须有 Claude Max 订阅 + 本地 `claude` CLI；不适用按量 API 用户
- **bge-m3 首次下载**：约 2.2GB（HuggingFace 自动下载，后续复用缓存）
- **测试套件非 CI 友好**：`tools/test/run-all.js` 会真起一个 `claude` 会话跑端到端，需本地 Max；抖音转写等部分场景依赖真实浏览器，无法 headless

## 文档

- 行为契约（项目灵魂）：`CLAUDE.md`
- 飞书接入：`bridge/SETUP-飞书.zh-CN.md`

## 致谢

- [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)（MIT，多语言嵌入模型）
- [Lark / 飞书 Open SDK](https://github.com/larksuite)
- [Claude Code](https://claude.com/claude-code)
- [node-pty](https://github.com/microsoft/node-pty) / [xterm.js](https://xtermjs.org/)

## License

MIT — 见 [LICENSE](LICENSE)
