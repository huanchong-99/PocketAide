**English** | [中文](README.zh-CN.md)

# PocketAide

> A pocket AI secretary — a Feishu (Lark) chat UI + a Claude Code brain + a local knowledge graph for long-term memory. Runs on your own Windows machine, reuses your Claude Max subscription, **zero extra API cost**.

PocketAide turns [Claude Code](https://claude.com/claude-code) into an always-on personal secretary: you send a message in Feishu, it drives an **interactive** `claude` through a pseudo-terminal (reusing your Max quota, **not** the pay-per-token API), and sends the reply back to Feishu. It manages a local knowledge base (semantic + full-text + wikilink-graph retrieval), tracks tasks, schedules reminders, and scrapes web pages / transcribes Douyin videos — all data stays in a Git repo on your own machine.

## What it can do

- **Feishu chat → Claude Code**: a Feishu long-connection receives messages, a pseudo-terminal (ConPTY) drives interactive `claude`, and the markdown reply goes back to Feishu
- **Local knowledge graph (kg)**: bge-m3 vectors + SQLite FTS5 full-text + a wikilink relation graph — three-way hybrid retrieval; atomic knowledge notes + confirm-before-write
- **Task tracking**: one markdown file per task, progress appended, archived when due (only touches completed tasks)
- **Scheduled reminders**: registered as Windows scheduled tasks, delivered to Feishu on time, any time zone
- **Web scraping / Douyin transcription**: drives a debug Chrome; results can be saved into the knowledge base
- **System-tray resident**: auto-start on boot, heartbeat self-heal, full restart on each new conversation

## Core constraints (design trade-offs)

- **Reuse Max, zero extra cost**: a pseudo-terminal drives interactive `claude` — no `-p` headless / Agent SDK / pay-per-use API
- **All data local**: a local Git repo + auto-commit on every write
- **Claude Code is the sole decision center**; confirm before writing knowledge; Windows + Chinese first

## Knowledge graph (kg) — in detail

Knowledge retrieval is provided by `tools/kg/` (`kg.py` + `embedder.py` + `embed_daemon.py`). It is **not** an automatically-constructed enterprise knowledge graph (no entity extraction, no relation extraction, no ontology, no RDF/OWL, no automated inference). It is a **three-way hybrid retrieval system** built for a personal knowledge base:

| Retrieval path | What it does | Tech |
|---|---|---|
| **Semantic vector** | Finds by *meaning*, not literal matches | bge-m3 (1024-dim, multilingual) + cosine similarity |
| **Full-text** | Exact keyword matching | SQLite FTS5 (Chinese unigram + bigram tokenization) |
| **Relation graph** | Follows `[[wikilink]]` to related notes | manually-annotated edges + `related` graph traversal |

- `search` = 0.7×vector + 0.3×full-text hybrid ranking; returns title / snippet / tags / source
- `related` = neighbor traversal along wikilink edges
- `overview` = counts by tag / subdirectory / type
- Data lives in local SQLite (`nodes / vectors / fts / links`); the index dir `.index/` is not committed and can be rebuilt anytime
- The embedding model runs as a resident daemon (`127.0.0.1:8199`) to avoid the ~12s cold start on every call

> **You maintain the relations by hand**: notes are linked by tagging `[[other note title]]` wikilinks — only then does kg know they're related; it does **not** auto-extract entities/relations from text. It's practical and sufficient for "take notes + semantic/full-text/related retrieval", but don't expect it to auto-build a knowledge graph the way Wikidata / Neo4j do.

## Prerequisites

- **Windows 10/11** (uses ConPTY, PowerShell 5.1, Task Scheduler)
- **Node.js 20/22 LTS** (the bridge process; node-pty's native module is sensitive to the Node version — use an LTS; developed/tested on Node 22)
- **Python 3.11+** (the knowledge-graph module; developed/tested on 3.14)
- **Claude Code CLI** (`claude`) + a **Claude Max subscription** (reusing the Max quota is the whole point)
- **A self-built Feishu app** (use "long connection" mode; see `bridge/SETUP-飞书.md`)
- **Chrome** (for web scraping / Douyin transcription; optional)

## Set up from scratch

```bash
# 1. Clone
git clone <repo-url> PocketAide
cd PocketAide

# 2. Install bridge deps (Node)
cd bridge && npm install && cd ..

# 3. Install knowledge-graph deps (Python) — first run downloads the bge-m3 model (~2.2GB)
pip install -r requirements.txt
python tools/kg/kg.py index --all    # build the index; slow the first time

# 4. Configure Feishu credentials
cp bridge/.env.example bridge/.env
#   Edit bridge/.env: fill in FEISHU_APP_ID / FEISHU_APP_SECRET / OWNER_OPEN_ID
#   Feishu app setup is in bridge/SETUP-飞书.md (be sure to pick "long connection"; do NOT set a callback URL)

# 5. Start the bridge (foreground, for verification)
cd bridge && npm start
```

Send your app a message in Feishu — you should get Claude's reply back.

**Run it resident** (optional):

```powershell
# Auto-start on boot (registers the scheduled task PocketAide-Bridge)
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
# Auto-archive completed tasks daily
powershell -ExecutionPolicy Bypass -File scripts\register-archive.ps1
```

## One-click setup with an AI agent (recommended)

Don't want to install step by step? Copy the **entire** block below and paste it to any coding agent (Claude Code / Cursor / GitHub Copilot Chat / Codex CLI, etc.) and have it run from the root of your cloned repo. It will detect your machine's environment, install what's missing, configure the files, and verify:

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

## Directory layout

```
bridge/       Feishu long-connection + pseudo-terminal bridge (Node): main.js + lib/ + tray host
tools/kg/     Knowledge-graph CLI (kg.py + resident embedding daemon): bge-m3 + FTS5 + wikilink
tools/tasks/  Task archiver
tools/test/   End-to-end test suite (run-all.js runs everything)
scripts/      Scheduled-task registration / Chrome start-stop, etc. (PowerShell + VBS)
.claude/      Claude Code behavior contract (CLAUDE.md) + hooks + skills
knowledge/    The knowledge base (your notes; example/ shows the format; it is itself an Obsidian vault)
tasks/        active / archive / reminders task records
workspace/    Assistant scratch output (drafts, analyses, etc.)
CLAUDE.md     The behavior contract Claude Code reads when entering the project (the project's soul)
```

For the knowledge-note format, see `knowledge/example/`; for the task/reminder formats, see each skill's `.claude/skills/*/SKILL.md`.

> `bridge/pty-*.js` (`pty-smoke` / `pty-claude-stub` / `pty-claude-vt` / `pty-multiturn-test`) are **development-time validation scripts** for the make-or-break problem: before writing the real bridge, they separately verify "can a pseudo-terminal reuse interactive `claude`, capture the screen, and sustain multiple turns". They run standalone and are **not referenced by the production bridge `main.js`**; they're kept for anyone who wants to understand how the pseudo-terminal captures claude's replies, and have no effect on normal use.

## Optional: visualize with Obsidian + sync via GitHub

`knowledge/` is itself an [Obsidian](https://obsidian.md) vault (it ships with an `.obsidian/` config):

1. Install Obsidian → "Open folder as vault" → choose `knowledge/`
2. Your notes and the `[[wikilink]]` backlink graph become browsable and navigable
3. To cloud-sync / go multi-device: push this repo (or just `knowledge/`) to a **private** GitHub repo, then clone + pull on each device — the knowledge base stays fully local and under your control

> ⚠️ If you sync the whole repo, use a **private** one: `knowledge/` and `tasks/` will contain your personal notes and tasks.

## Known constraints

- **Windows-only**: deeply tied to ConPTY, PowerShell 5.1, and Windows Task Scheduler
- **Reuses Max**: requires a Claude Max subscription + a local `claude` CLI; not for pay-per-token API users
- **bge-m3 first download**: ~2.2GB (auto-downloaded from HuggingFace, cached afterward)
- **Test suite isn't CI-friendly**: `tools/test/run-all.js` actually spins up a `claude` session for the end-to-end runs (needs local Max); some scenarios such as Douyin transcription depend on a real browser and can't run headless

## Docs

- Behavior contract (the project's soul): `CLAUDE.md`
- Feishu integration: `bridge/SETUP-飞书.md`

## Acknowledgments

- [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) (MIT, multilingual embedding model)
- [Lark / Feishu Open SDK](https://github.com/larksuite)
- [Claude Code](https://claude.com/claude-code)
- [node-pty](https://github.com/microsoft/node-pty) / [xterm.js](https://xtermjs.org/)

## License

MIT — see [LICENSE](LICENSE)
