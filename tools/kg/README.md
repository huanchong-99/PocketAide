**English** | [中文](README.zh-CN.md)

# kg — local knowledge-graph CLI

PocketAide's knowledge-graph module. **Fully local, zero extra cost**: a local embedding model + SQLite (vector BLOB + FTS5 full-text + wikilink graph), with no pay-per-use API whatsoever.

The knowledge skills (`knowledge-write` / `knowledge-query`) use this CLI to maintain the index and run retrieval.

## Embedding model

- In use: **BAAI/bge-m3** (multilingual, **1024-dim** output, strong on Chinese).
- Fallback: **BAAI/bge-small-zh-v1.5** (512-dim), enabled automatically only if bge-m3 fails to load.
- The model names are constants at the top of `embedder.py` (`PRIMARY_MODEL` / `FALLBACK_MODEL`), easy to change. You can also force one temporarily via the `KG_EMBED_MODEL` environment variable.
- `encode(..., normalize_embeddings=True)` → vectors are normalized, so **cosine similarity = dot product**.
- The first run downloads the model to the HF cache (bge-m3 is ~2.2GB); afterward it works offline.

> The model name used for each node's vector is recorded in the `nodes.model` field; the `model` field in command output carries it too.
> If you switch models and the dimension changes, old vectors with a mismatched dimension are automatically skipped at retrieval time — after switching models it's best to delete `.index/kg.db` and rebuild the full index.

## Embedding daemon (performance-critical)

Each new `python kg.py` process cold-starts torch+bge-m3 in ≈12s. The bridge layer (Feishu ↔ pseudo-terminal ↔ claude) has an idle timeout of only 5s, so the PTY going silent during model load would be misread as "reply finished" and **truncate the reply**. Hence the resident daemon `embed_daemon.py`:

- `embedder.embed()` call path: **first connect to the daemon** (`127.0.0.1:8199`, length-prefixed JSON over TCP) → if it can't connect, **detached-spawn the daemon** (no window on Windows, doesn't block the parent), poll until ready, then use it → if the daemon truly can't start, **fall back to in-process loading** (last resort, slow but works).
- The daemon loads bge-m3 once in-process and stays resident for all kg calls to reuse. **It auto-exits after 15 minutes idle** to free memory.
- Measured: first call ≈12-14s (which also spins up the daemon), then each search/index is **≈0.2-0.3s**.
- Manual control: `python tools/kg/embed_daemon.py` starts it in the foreground; sending `{"cmd":"shutdown"}` stops it gracefully.

> **Port note**: on Windows, Hyper-V/WSL reserve large dynamic port ranges (check with `netsh interface ipv4 show excludedportrange protocol=tcp`); binding a port inside one of these ranges fails with WinError 10013 (even if the port looks free). The default port **8199** already avoids these ranges. Before changing the port, check excludedportrange, and keep `embed_daemon.py` and `embedder.py` on the same port.

## Encoding (Windows GBK pitfall, fixed)

Windows stdout defaults to GBK (cp936), so printing JSON containing a BOM (﻿)/emoji/rare characters raises `'gbk' codec can't encode ...`. At the `kg.py` entry point it forces `sys.stdout/stderr.reconfigure(encoding='utf-8')`, so output is always valid UTF-8 (with `ensure_ascii=False` to keep Chinese readable). Markdown files are read with `utf-8-sig` to swallow the BOM automatically.

## Data source

Scans `knowledge/**/*.md`; each file is parsed for:

- YAML frontmatter: `type` (knowledge/task), `tags`, `source`, `created` (a minimal built-in parser supporting both inline `[a, b]` and block `- a` list styles, with no PyYAML dependency)
- Title: the first `# Heading` in the body, falling back to the filename
- The full body text (used for embedding + FTS)
- `[[wikilink]]` relations (builds the graph, queryable both ways; supports the `[[target|display name]]` syntax)

**node id = the path relative to `knowledge/`** (forward slashes), e.g. `ai/2026-06-16-bge-m3.md`.

## Environment variables

| Variable | Effect | Default |
|------|------|------|
| `KG_KNOWLEDGE_ROOT` | Override the scan root (for self-testing) | `<repo>/knowledge` |
| `KG_DB` | Override the SQLite DB path | `<repo>/.index/kg.db` |
| `KG_EMBED_MODEL` | Force a specific embedding model | empty (uses PRIMARY) |
| `KG_EMBED_PORT` | Daemon port | `8199` |
| `KG_EMBED_IDLE_TIMEOUT` | Daemon idle-exit seconds | `900` (15 min) |
| `KG_EMBED_NO_DAEMON` | =1 disables the daemon, forces in-process loading | empty |
| `KG_EMBED_INPROC` | =1 in-process loading (used internally by the daemon to prevent recursion) | empty |

## Commands (external contract — keep stable)

All commands **print JSON to stdout on success**; on error they print JSON to stderr and **exit non-zero**.

### 1. index — parse, embed, write to DB (incremental)

```bash
python tools/kg/kg.py index [--all | --file <relative path>]
```

- Defaults to `--all` (full scan); `--file` processes a single file (relative to the knowledge root).
- **Incremental**: if the file content hash is unchanged, it's skipped (no re-embedding).
- A full run **cleans up nodes for deleted files** (reflected in the `removed` count).
- `--file` pointing at a nonexistent file = delete that node from the DB (removed=1).

Output:
```json
{"indexed": 4, "skipped": 0, "removed": 0, "model": "BAAI/bge-m3", "total_nodes": 4}
```

### 2. search — semantic + full-text hybrid retrieval

```bash
python tools/kg/kg.py search "<query>" [--k 5]
```

- Primary path: cosine (dot-product) similarity of the query embedding vs. all stored vectors.
- Supplement: FTS5 full-text matching (Chinese is split into unigram+bigram to guarantee hits).
- Hybrid ranking: `0.7 * semantic + 0.3 * FTS` (the FTS score is bm25-normalized to 0~1).

Output (descending by score):
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

### 3. related — neighbors by wikilink

```bash
python tools/kg/kg.py related "<id or title>" [--depth 1]
```

- The argument can be a node id, a title, a filename, or a keyword with the date prefix stripped (loose matching).
- Returns out-edges (where this node's `[[links]]` point) + in-edges (where other nodes point to this one).
- `--depth` controls how many hops to expand. A link to a nonexistent node → `resolved:false` (a dangling link).
- If the start node isn't found: stderr outputs `{"error":...}`, exit code 2.

Output:
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

### 4. overview — knowledge-base overview

```bash
python tools/kg/kg.py overview [--tag <t>]
```

Answers "how much do I have about X, and what does it cover". `--tag` counts only nodes carrying that tag.

Output:
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

## kg.db schema

```sql
-- node metadata
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,    -- path relative to the knowledge root (forward slashes)
    title TEXT, tags TEXT,  -- tags is a JSON array
    source TEXT, created TEXT, type TEXT,
    hash TEXT,              -- sha256 of the full text, for incremental checks
    mtime REAL, subdir TEXT,
    model TEXT              -- name of the model used to generate this node's vector
);
-- vectors (float32 little-endian, normalized)
CREATE TABLE vectors (
    id TEXT PRIMARY KEY, dim INTEGER, embedding BLOB,
    FOREIGN KEY (id) REFERENCES nodes(id) ON DELETE CASCADE
);
-- FTS5 full-text (Chinese written after unigram+bigram splitting)
CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61');
-- wikilink graph edges
CREATE TABLE links (
    src TEXT,    -- source node id
    dst TEXT,    -- resolved target id (or the raw text if unresolved = dangling link)
    raw TEXT,    -- the raw wikilink text
    UNIQUE(src, raw)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- reserved
```

## Knowledge-skill integration notes

- **After writing knowledge**: call `python tools/kg/kg.py index --file <relative path>` for an incremental index (or run `index --all` once after writing several files). Parse the stdout JSON and check `indexed` to confirm it took effect.
- **Querying knowledge**:
  - Semantic/keyword retrieval → `search "<user question>" --k 5`, then answer based on the returned `id/title/snippet`; if the result is empty or all scores are very low, **honestly say the knowledge base doesn't cover it** rather than fabricating.
  - Relation/association queries → `related "<id or title>"`.
  - "How much do I have about X" → `overview [--tag X]`.
- All commands output JSON, so `json.loads(stdout)` works directly; a non-zero exit code means an error — read the `error` from stderr.

## Chinese FTS note

SQLite FTS5's unicode61 tokenizer doesn't segment continuous Chinese. This tool splits Chinese spans into **unigrams (single chars) + bigrams (char pairs)** on both write and query, to ensure Chinese can be hit by FTS. The semantic vector is the primary path; FTS is supplementary recall.

## Dependencies

Already installed on the dev machine: Python 3.14, sentence-transformers, torch, numpy. Uses only the Python standard library `sqlite3` (FTS5 verified available) + sentence-transformers + numpy — no new paid dependencies.
