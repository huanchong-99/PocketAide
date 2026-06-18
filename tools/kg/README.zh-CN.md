[English](README.md) | **中文**

# kg —— 本地知识图谱 CLI

PocketAide的知识图谱模块。**纯本地、零额外费用**：本地嵌入模型 + SQLite
（向量 BLOB + FTS5 全文 + wikilink 图），无任何按量付费 API。

知识 skill（`knowledge-write` / `knowledge-query`）通过本 CLI 维护索引与做检索。

## 嵌入模型

- 实际使用：**BAAI/bge-m3**（多语言，输出 **1024 维**，中文质量好）。
- 回退：**BAAI/bge-small-zh-v1.5**（512 维），仅当 bge-m3 加载失败时自动启用。
- 模型名是 `embedder.py` 顶部的常量（`PRIMARY_MODEL` / `FALLBACK_MODEL`），易改。
  也可用环境变量 `KG_EMBED_MODEL` 临时强制指定。
- `encode(..., normalize_embeddings=True)` → 向量已归一化，**余弦相似度 = 点积**。
- 首次运行会下载模型到 HF 缓存（bge-m3 约 2.2GB），之后离线可用。

> 每个节点的向量所用模型名记录在 `nodes.model` 字段；命令输出的 `model` 字段也带它。
> 换模型后维度变化时，旧向量维度不匹配会在检索时被自动跳过——建议换模型后
> 删 `.index/kg.db` 重建全量索引。

## 嵌入守护进程（性能关键）

每个 `python kg.py` 新进程冷启动重载 torch+bge-m3 ≈12s。桥接层（飞书↔伪终端↔claude）
idle 超时只有 5s，模型加载期 PTY 静默会被误判为"回复结束"导致**回复被截断**。
因此引入常驻守护进程 `embed_daemon.py`：

- `embedder.embed()` 调用路径：**先连守护进程**（`127.0.0.1:8199`，length-prefixed JSON over TCP）→
  连不上就 **detached spawn 守护进程**（Windows 不弹窗、不阻塞父进程），轮询到 ready 后用它 →
  守护进程彻底起不来再**回退进程内加载**（保底，慢但能用）。
- 守护进程内进程内加载一次 bge-m3，常驻供所有 kg 调用复用。**空闲 15 分钟自动退出**释放内存。
- 效果实测：首次调用 ≈12-14s（顺带拉起守护进程），之后每次 search/index **≈0.2-0.3s**。
- 手动控制：`python tools/kg/embed_daemon.py` 前台起；发 `{"cmd":"shutdown"}` 可优雅停。

> **端口注意**：Windows 上 Hyper-V/WSL 保留大量动态端口区间（`netsh interface ipv4
> show excludedportrange protocol=tcp` 可查），落在其中的端口 bind 会报 WinError 10013
> （即使端口看似空闲）。默认端口 **8199** 已避开这些区间。换端口前务必查 excludedportrange，
> 并保持 `embed_daemon.py` 与 `embedder.py` 的端口一致。

## 编码（Windows GBK 坑已修）

Windows 默认 stdout 是 GBK(cp936)，打印含 BOM(﻿)/emoji/生僻字的 JSON 会报
`'gbk' codec can't encode ...`。`kg.py` 入口处强制 `sys.stdout/stderr.reconfigure(encoding='utf-8')`，
输出永远是合法 UTF-8（配合 `ensure_ascii=False` 保持中文可读）。读 md 文件用 `utf-8-sig`
自动吞 BOM。

## 数据来源

扫描 `knowledge/**/*.md`，每个文件解析：

- YAML frontmatter：`type`(knowledge/task)、`tags`、`source`、`created`
  （极简内置解析器，支持行内 `[a, b]` 与块状 `- a` 两种列表写法，不依赖 PyYAML）
- 标题：正文第一个 `# 标题`，没有就用文件名
- 正文全文（用于嵌入 + FTS）
- `[[wikilink]]` 关联（建图，双向可查；支持 `[[目标|显示名]]` 语法）

**node id = 相对 `knowledge/` 的路径**（正斜杠），如 `ai/2026-06-16-bge-m3.md`。

## 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `KG_KNOWLEDGE_ROOT` | 覆盖扫描根目录（自测用） | `<repo>/knowledge` |
| `KG_DB` | 覆盖 SQLite 库路径 | `<repo>/.index/kg.db` |
| `KG_EMBED_MODEL` | 强制指定嵌入模型 | 空（用 PRIMARY） |
| `KG_EMBED_PORT` | 守护进程端口 | `8199` |
| `KG_EMBED_IDLE_TIMEOUT` | 守护进程空闲退出秒数 | `900`（15分钟） |
| `KG_EMBED_NO_DAEMON` | =1 禁用守护进程，强制进程内加载 | 空 |
| `KG_EMBED_INPROC` | =1 进程内加载（守护进程内部自用，防递归） | 空 |

## 命令（对外契约，务必稳定）

所有命令**成功时输出 JSON 到 stdout**；出错输出 JSON 到 stderr 且**非零退出码**。

### 1. index —— 解析、嵌入、写库（增量）

```bash
python tools/kg/kg.py index [--all | --file <相对路径>]
```

- 默认 `--all` 全量扫描；`--file` 只处理单个文件（相对 knowledge 根）。
- **增量**：文件内容 hash 没变就跳过（不重算嵌入）。
- 全量时会**清理已删文件**对应的节点（体现在 `removed` 计数）。
- `--file` 指向一个不存在的文件 = 把该节点从库里删除（removed=1）。

输出：
```json
{"indexed": 4, "skipped": 0, "removed": 0, "model": "BAAI/bge-m3", "total_nodes": 4}
```

### 2. search —— 语义 + 全文混合检索

```bash
python tools/kg/kg.py search "<查询>" [--k 5]
```

- 主路径：查询嵌入 vs 全库向量的余弦（点积）相似度。
- 补充：FTS5 全文匹配（中文做 unigram+bigram 切分，确保能命中）。
- 混合排序：`0.7 * 语义 + 0.3 * FTS`（FTS 分经 bm25 归一化到 0~1）。

输出（按 score 降序）：
```json
[
  {
    "id": "2026-06-16-bge-m3嵌入.md",
    "title": "bge-m3 嵌入模型",
    "score": 0.7176,
    "snippet": "# bge-m3 嵌入模型 BAAI/bge-m3 是多语言嵌入模型，输出 1024 维向量…",
    "tags": ["嵌入", "向量检索", "本地模型"],
    "source": "技术选型"
  }
]
```

### 3. related —— 按 wikilink 取邻居

```bash
python tools/kg/kg.py related "<id或标题>" [--depth 1]
```

- 参数可以是 node id、标题、文件名，或去掉日期前缀的关键词（宽松匹配）。
- 取出边（本节点 `[[链接]]` 指向的）+ 入边（别的节点指向本节点的）。
- `--depth` 控制扩散层数。指向不存在节点的链接 → `resolved:false`（悬挂链接）。
- 找不到起点节点：stderr 输出 `{"error":...}`，退出码 2。

输出：
```json
{
  "id": "2026-06-16-bge-m3嵌入.md",
  "title": "bge-m3 嵌入模型",
  "depth": 1,
  "neighbors": [
    {"id": "2026-06-16-ConPTY伪终端.md", "title": "ConPTY 伪终端复用",
     "tags": ["伪终端","Windows","桥接"], "type": "knowledge", "resolved": true}
  ],
  "edges": [
    {"src": "2026-06-16-bge-m3嵌入.md", "dst": "2026-06-16-ConPTY伪终端.md",
     "raw": "ConPTY伪终端", "dir": "out"},
    {"src": "2026-06-16-ConPTY伪终端.md", "dst": "2026-06-16-bge-m3嵌入.md",
     "raw": "bge-m3嵌入", "dir": "in"}
  ]
}
```

### 4. overview —— 知识库概览

```bash
python tools/kg/kg.py overview [--tag <t>]
```

回答"我知识库里关于 X 的内容有多少、覆盖哪些方面"。`--tag` 只统计带该标签的节点。

输出：
```json
{
  "total_nodes": 4,
  "matched_nodes": 4,
  "filter_tag": null,
  "by_tag": {"嵌入": 1, "向量检索": 1, "伪终端": 1, "...": 1},
  "by_subdir": {"(root)": 3, "ai": 1},
  "by_type": {"knowledge": 4},
  "total_links": 4,
  "model": "BAAI/bge-m3"
}
```

## kg.db Schema

```sql
-- 节点元数据
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,    -- 相对 knowledge 根的路径（正斜杠）
    title TEXT, tags TEXT,  -- tags 为 JSON array
    source TEXT, created TEXT, type TEXT,
    hash TEXT,              -- 全文 sha256，用于增量判断
    mtime REAL, subdir TEXT,
    model TEXT              -- 生成该节点向量所用模型名
);
-- 向量（float32 little-endian，已归一化）
CREATE TABLE vectors (
    id TEXT PRIMARY KEY, dim INTEGER, embedding BLOB,
    FOREIGN KEY (id) REFERENCES nodes(id) ON DELETE CASCADE
);
-- FTS5 全文（中文 unigram+bigram 切分后写入）
CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61');
-- wikilink 图边
CREATE TABLE links (
    src TEXT,    -- 源节点 id
    dst TEXT,    -- 解析后的目标 id（解析不到则存原始文本=悬挂链接）
    raw TEXT,    -- wikilink 原始文本
    UNIQUE(src, raw)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- 预留
```

## 知识 skill 集成说明

- **写入知识后**：调用 `python tools/kg/kg.py index --file <相对路径>` 做增量索引
  （或写多个文件后跑一次 `index --all`）。解析 stdout JSON，看 `indexed` 确认生效。
- **查询知识**：
  - 语义/关键词检索 → `search "<用户问题>" --k 5`，基于返回的 `id/title/snippet` 回答；
    结果空或 score 都很低时**如实告知知识库覆盖不足**，不编造。
  - 关系/关联查询 → `related "<id或标题>"`。
  - "我有多少关于 X 的内容" → `overview [--tag X]`。
- 命令均输出 JSON，直接 `json.loads(stdout)` 即可；非零退出码表示出错，读 stderr 的 `error`。

## 中文 FTS 说明

SQLite FTS5 的 unicode61 分词器不切中文连写。本工具在写入和查询时都对中文段做
**unigram（单字）+ bigram（双字）** 切分，保证中文能被 FTS 命中。语义向量是主路径，
FTS 是补充召回。

## 依赖

机器已装：Python 3.14、sentence-transformers、torch、numpy。仅用 Python 标准库
`sqlite3`（FTS5 已验证可用）+ sentence-transformers + numpy，无新增付费依赖。
