#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""kg —— PocketAide 本地知识图谱 CLI。

纯本地：SQLite（向量 BLOB + FTS5 全文 + wikilink 图）+ 本地嵌入模型。
所有命令成功时输出 JSON 到 stdout；出错输出到 stderr 且非零退出码。

命令：
  index   [--all | --file <相对路径>]   解析→嵌入→upsert，增量，清理已删
  search  "<查询>" [--k 5]              语义向量 + FTS5 混合检索
  related "<id或标题>" [--depth 1]      按 wikilink 取邻居（出边+入边）
  overview [--tag <t>]                  概览：按 tag/子目录/type 计数分布

数据源：扫描 KNOWLEDGE_ROOT（默认 <repo>/knowledge）下的 **/*.md。
可用环境变量 KG_KNOWLEDGE_ROOT 覆盖扫描根（自测用），KG_DB 覆盖库路径。
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys

# Windows 默认 stdout 是 GBK(cp936)，打印含 BOM/emoji/生僻字的 JSON 会崩。
# 入口处强制 UTF-8（Python 3.7+ 的 reconfigure），保证输出永远是合法 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001  老解释器或被重定向时静默跳过
        pass

# 让本目录可导入 embedder
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import embedder  # noqa: E402

# ---------- 路径配置 ----------
THIS_DIR = os.path.dirname(os.path.abspath(__file__))
# repo 根 = tools/kg/ 的上上级
REPO_ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))


def knowledge_root():
    env = os.environ.get("KG_KNOWLEDGE_ROOT", "").strip()
    if env:
        return os.path.abspath(env)
    return os.path.join(REPO_ROOT, "knowledge")


def db_path():
    env = os.environ.get("KG_DB", "").strip()
    if env:
        p = os.path.abspath(env)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p
    idx = os.path.join(REPO_ROOT, ".index")
    os.makedirs(idx, exist_ok=True)
    return os.path.join(idx, "kg.db")


# ---------- 工具函数 ----------
def die(msg, code=1):
    print(json.dumps({"error": str(msg)}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


def rel_id(abspath, root):
    """相对 knowledge_root 的路径，统一用正斜杠作为 node id。"""
    r = os.path.relpath(abspath, root)
    return r.replace("\\", "/")


def file_hash(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


# ---------- Markdown 解析 ----------
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]")
H1_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def parse_frontmatter(raw):
    """极简 YAML frontmatter 解析（只取我们关心的标量/列表字段）。

    不引入 PyYAML 依赖。支持：
      key: value
      tags: [a, b]
      tags:
        - a
        - b
    """
    meta = {}
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return meta, raw
    block = m.group(1)
    body = raw[m.end():]
    lines = block.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.strip().startswith("#"):
            i += 1
            continue
        mkv = re.match(r"^([A-Za-z_][\w\-]*)\s*:\s*(.*)$", line)
        if not mkv:
            i += 1
            continue
        key = mkv.group(1).strip()
        val = mkv.group(2).strip()
        if val == "":
            # 可能是块状列表
            items = []
            j = i + 1
            while j < len(lines):
                lm = re.match(r"^\s*-\s+(.*)$", lines[j])
                if lm:
                    items.append(_clean_scalar(lm.group(1)))
                    j += 1
                else:
                    break
            if items:
                meta[key] = items
                i = j
                continue
            meta[key] = ""
            i += 1
            continue
        # 行内列表 [a, b]
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            items = [_clean_scalar(x) for x in inner.split(",") if x.strip()] if inner else []
            meta[key] = items
        else:
            meta[key] = _clean_scalar(val)
        i += 1
    return meta, body


def _clean_scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        s = s[1:-1]
    return s


def extract_title(body, fallback):
    m = H1_RE.search(body)
    if m:
        return m.group(1).strip()
    return fallback


def extract_links(body):
    out = []
    for m in WIKILINK_RE.finditer(body):
        target = m.group(1).strip()
        if target:
            out.append(target)
    return out


def normalize_tags(meta):
    t = meta.get("tags", [])
    if isinstance(t, str):
        t = [x.strip() for x in re.split(r"[,，]", t) if x.strip()] if t else []
    return [str(x) for x in t]


def parse_md_file(abspath, root):
    # utf-8-sig：自动吞掉文件开头的 BOM，避免 frontmatter/标题解析被 ﻿ 干扰
    with open(abspath, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    meta, body = parse_frontmatter(raw)
    rid = rel_id(abspath, root)
    fallback_title = os.path.splitext(os.path.basename(abspath))[0]
    title = extract_title(body, fallback_title)
    tags = normalize_tags(meta)
    node = {
        "id": rid,
        "title": title,
        "tags": tags,
        "source": str(meta.get("source", "")),
        "created": str(meta.get("created", "")),
        "type": str(meta.get("type", "knowledge")) or "knowledge",
        "hash": file_hash(raw),
        "mtime": os.path.getmtime(abspath),
        "body": body,
        "links": extract_links(body),
        "subdir": rid.split("/")[0] if "/" in rid else "(root)",
    }
    return node


# ---------- 中文友好的 FTS 分词 ----------
def fts_tokenize(text):
    """把文本转成 FTS 友好的 token 串。

    用 unicode61 建表，但中文连写无空格 → 默认会被当成一个超长 token，难命中。
    策略：把 CJK 连续段切成 unigram + bigram（字 + 双字），其余（英文/数字）保留原样。
    检索查询也走同样的处理，确保中文能被 FTS 命中。
    """
    if not text:
        return ""
    tokens = []
    # 先按非中文/中文分段
    for chunk in re.findall(r"[一-鿿㐀-䶿]+|[A-Za-z0-9_]+", text):
        if re.match(r"[一-鿿㐀-䶿]", chunk):
            chars = list(chunk)
            tokens.extend(chars)  # unigram
            for a, b in zip(chars, chars[1:]):
                tokens.append(a + b)  # bigram
        else:
            tokens.append(chunk.lower())
    return " ".join(tokens)


def fts_query_string(query):
    """把用户查询转成 FTS5 MATCH 串：token 之间 OR，容错。"""
    toks = fts_tokenize(query).split()
    if not toks:
        return ""
    # 去重保序
    seen = set()
    uniq = []
    for t in toks:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    # FTS5：用双引号包裹每个 token 防止特殊字符，OR 连接
    quoted = ['"' + t.replace('"', '""') + '"' for t in uniq]
    return " OR ".join(quoted)


# ---------- SQLite ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id      TEXT PRIMARY KEY,
    title   TEXT,
    tags    TEXT,           -- JSON array
    source  TEXT,
    created TEXT,
    type    TEXT,
    hash    TEXT,
    mtime   REAL,
    subdir  TEXT,
    model   TEXT            -- 生成该节点向量所用的模型名
);
CREATE TABLE IF NOT EXISTS vectors (
    id        TEXT PRIMARY KEY,
    dim       INTEGER,
    embedding BLOB,         -- float32 little-endian
    FOREIGN KEY (id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS links (
    src TEXT,
    dst TEXT,               -- 解析后的目标 node id（解析不到则存原始标题）
    raw TEXT,               -- wikilink 原始文本
    UNIQUE(src, raw)
);
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
"""


def connect():
    # timeout + busy_timeout: 桥接的 claude 写知识、常驻 embed_daemon、测试夹具可能并发碰 kg.db,
    # 让写者等锁而不是立刻 SQLITE_BUSY 报错。WAL: 读写并发(读不挡写), -wal/-shm 落在 .index/(已 gitignore)。
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


def get_all_node_ids(conn):
    return {r[0] for r in conn.execute("SELECT id FROM nodes")}


def get_node_hash(conn, nid):
    row = conn.execute("SELECT hash FROM nodes WHERE id=?", (nid,)).fetchone()
    return row[0] if row else None


def delete_node(conn, nid):
    conn.execute("DELETE FROM nodes WHERE id=?", (nid,))
    conn.execute("DELETE FROM vectors WHERE id=?", (nid,))
    conn.execute("DELETE FROM fts WHERE id=?", (nid,))
    conn.execute("DELETE FROM links WHERE src=?", (nid,))


DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")


def _basename_no_ext(nid):
    return os.path.splitext(os.path.basename(nid))[0]


def _strip_date_prefix(name):
    return DATE_PREFIX_RE.sub("", name)


def _norm_key(s):
    """归一化用于宽松匹配：去空格、去 .md、去日期前缀、小写。"""
    s = s.strip()
    if s.lower().endswith(".md"):
        s = s[:-3]
    s = _strip_date_prefix(s)
    return re.sub(r"\s+", "", s).lower()


def resolve_link_target(conn, raw, all_nodes_by_title, all_ids):
    """把 wikilink 原始文本解析成 node id。

    匹配优先级：精确 id → +.md → 标题 → 去扩展名文件名 →
    （宽松）去日期前缀/空格后的文件名或标题 → 原文（未解析悬挂链接）。
    命名约定为 `YYYY-MM-DD-主题关键词.md`，而 wikilink 常只写主题关键词，
    故需支持去日期前缀的宽松匹配。
    """
    if raw in all_ids:
        return raw
    if raw + ".md" in all_ids:
        return raw + ".md"
    if raw in all_nodes_by_title:
        return all_nodes_by_title[raw]
    for nid in all_ids:
        if _basename_no_ext(nid) == raw:
            return nid
    # 宽松匹配
    rk = _norm_key(raw)
    for nid in all_ids:
        if _norm_key(nid) == rk:
            return nid
    for title, nid in all_nodes_by_title.items():
        if _norm_key(title) == rk:
            return nid
    return raw  # 未解析，保留原文（悬挂链接）


def upsert_node(conn, node):
    import numpy as np

    vecs = embedder.embed([node["title"] + "\n" + node["body"]])
    vec = vecs[0]
    model_name = embedder.get_model_name()

    conn.execute(
        """INSERT INTO nodes(id,title,tags,source,created,type,hash,mtime,subdir,model)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, tags=excluded.tags, source=excluded.source,
             created=excluded.created, type=excluded.type, hash=excluded.hash,
             mtime=excluded.mtime, subdir=excluded.subdir, model=excluded.model""",
        (
            node["id"], node["title"], json.dumps(node["tags"], ensure_ascii=False),
            node["source"], node["created"], node["type"], node["hash"],
            node["mtime"], node["subdir"], model_name,
        ),
    )
    conn.execute("DELETE FROM vectors WHERE id=?", (node["id"],))
    conn.execute(
        "INSERT INTO vectors(id,dim,embedding) VALUES(?,?,?)",
        (node["id"], int(vec.shape[0]), np.asarray(vec, dtype=np.float32).tobytes()),
    )
    conn.execute("DELETE FROM fts WHERE id=?", (node["id"],))
    conn.execute(
        "INSERT INTO fts(id,title,body) VALUES(?,?,?)",
        (node["id"], fts_tokenize(node["title"]), fts_tokenize(node["body"])),
    )
    # links 在第二遍统一解析（需要全量节点表），这里先存原始
    conn.execute("DELETE FROM links WHERE src=?", (node["id"],))
    for raw in node["links"]:
        conn.execute(
            "INSERT OR IGNORE INTO links(src,dst,raw) VALUES(?,?,?)",
            (node["id"], raw, raw),  # dst 先用 raw 占位，下面重解析
        )


def rebuild_link_targets(conn):
    """全量重解析 links.dst（基于当前全部节点的 id/title）。"""
    all_ids = get_all_node_ids(conn)
    title_map = {}
    for nid, title in conn.execute("SELECT id,title FROM nodes"):
        if title and title not in title_map:
            title_map[title] = nid
    for src, raw in conn.execute("SELECT src,raw FROM links").fetchall():
        dst = resolve_link_target(conn, raw, title_map, all_ids)
        conn.execute("UPDATE links SET dst=? WHERE src=? AND raw=?", (dst, src, raw))


# ---------- 命令实现 ----------
def scan_files(root):
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(".md"):
                out.append(os.path.join(dirpath, fn))
    return out


def cmd_index(args):
    root = knowledge_root()
    conn = connect()
    indexed = skipped = removed = 0

    if args.file:
        # 单文件模式
        target_rel = args.file.replace("\\", "/")
        abspath = os.path.join(root, target_rel)
        if not os.path.isfile(abspath):
            # 文件不存在 → 视为删除
            if get_node_hash(conn, target_rel) is not None:
                delete_node(conn, target_rel)
                removed = 1
            conn.commit()
        else:
            node = parse_md_file(abspath, root)
            old = get_node_hash(conn, node["id"])
            if old == node["hash"]:
                skipped = 1
            else:
                upsert_node(conn, node)
                indexed = 1
            conn.commit()
    else:
        # 全量
        if not os.path.isdir(root):
            os.makedirs(root, exist_ok=True)
        files = scan_files(root)
        present_ids = set()
        for abspath in files:
            node = parse_md_file(abspath, root)
            present_ids.add(node["id"])
            old = get_node_hash(conn, node["id"])
            if old == node["hash"]:
                skipped += 1
            else:
                upsert_node(conn, node)
                indexed += 1
        # 清理已删
        existing = get_all_node_ids(conn)
        for nid in existing - present_ids:
            delete_node(conn, nid)
            removed += 1
        conn.commit()

    rebuild_link_targets(conn)
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    model_name = None
    if indexed > 0:
        model_name = embedder.get_model_name()
    else:
        row = conn.execute("SELECT model FROM nodes LIMIT 1").fetchone()
        model_name = row[0] if row else embedder.PRIMARY_MODEL
    conn.close()
    print(json.dumps({
        "indexed": indexed, "skipped": skipped, "removed": removed,
        "model": model_name, "total_nodes": total,
    }, ensure_ascii=False))


def _cosine_search(conn, qvec, limit):
    import numpy as np

    rows = conn.execute("SELECT id,dim,embedding FROM vectors").fetchall()
    if not rows:
        return []
    scores = []
    q = np.asarray(qvec, dtype=np.float32)
    for nid, dim, blob in rows:
        v = np.frombuffer(blob, dtype=np.float32)
        if v.shape[0] != q.shape[0]:
            continue  # 维度不匹配（换过模型），跳过
        scores.append((nid, float(np.dot(q, v))))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores[:limit]


def _fts_search(conn, query, limit):
    qstr = fts_query_string(query)
    if not qstr:
        return {}
    try:
        rows = conn.execute(
            "SELECT id, bm25(fts) AS rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?",
            (qstr, limit * 3),
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    # bm25 越小越相关 → 转成 [0,1] 的归一化分（简单 min-max 反向）
    if not rows:
        return {}
    ranks = [r[1] for r in rows]
    lo, hi = min(ranks), max(ranks)
    out = {}
    for nid, rank in rows:
        if hi == lo:
            norm = 1.0
        else:
            norm = (hi - rank) / (hi - lo)
        out[nid] = norm
    return out


def make_snippet(conn, nid, query, length=160):
    row = conn.execute("SELECT body FROM fts WHERE id=?", (nid,)).fetchone()
    # fts.body 是分词后的，不适合展示；读原始节点重新取 body 片段
    # 改为从原文件读不现实（可能已变），用 nodes 无 body；故存一份展示用 body。
    # 简化：直接从 knowledge 文件读首段。
    root = knowledge_root()
    abspath = os.path.join(root, nid)
    try:
        with open(abspath, "r", encoding="utf-8-sig", errors="replace") as f:
            raw = f.read()
        _meta, body = parse_frontmatter(raw)
        body = re.sub(r"\s+", " ", body).strip()
    except OSError:
        body = ""
    if not body:
        return ""
    # 尝试定位查询中某个中文/词的位置
    pos = -1
    for ch in re.findall(r"[一-鿿]{2,}|[A-Za-z]{2,}", query):
        p = body.find(ch)
        if p >= 0:
            pos = p
            break
    if pos < 0:
        return body[:length]
    start = max(0, pos - 30)
    return ("…" if start > 0 else "") + body[start:start + length]


def cmd_search(args):
    conn = connect()
    total = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    if total == 0:
        conn.close()
        print(json.dumps([], ensure_ascii=False))
        return
    k = args.k
    qvec = embedder.embed(args.query, is_query=True)[0]
    sem = _cosine_search(conn, qvec, max(k * 3, 10))
    fts = _fts_search(conn, args.query, max(k * 3, 10))

    # 混合排序：语义为主(0.7) + FTS(0.3)
    sem_map = {nid: s for nid, s in sem}
    all_ids = set(sem_map) | set(fts)
    combined = []
    for nid in all_ids:
        s_sem = sem_map.get(nid, 0.0)
        s_fts = fts.get(nid, 0.0)
        score = 0.7 * s_sem + 0.3 * s_fts
        combined.append((nid, score, s_sem, s_fts))
    combined.sort(key=lambda x: x[1], reverse=True)
    combined = combined[:k]

    results = []
    for nid, score, s_sem, s_fts in combined:
        row = conn.execute(
            "SELECT title,tags,source FROM nodes WHERE id=?", (nid,)
        ).fetchone()
        if not row:
            continue
        title, tags_json, source = row
        results.append({
            "id": nid,
            "title": title,
            "score": round(score, 4),
            "snippet": make_snippet(conn, nid, args.query),
            "tags": json.loads(tags_json) if tags_json else [],
            "source": source or "",
        })
    conn.close()
    print(json.dumps(results, ensure_ascii=False))


def resolve_id(conn, ref):
    """把 id 或标题解析成 node id。"""
    ref_norm = ref.replace("\\", "/")
    if conn.execute("SELECT 1 FROM nodes WHERE id=?", (ref_norm,)).fetchone():
        return ref_norm
    if conn.execute("SELECT 1 FROM nodes WHERE id=?", (ref_norm + ".md",)).fetchone():
        return ref_norm + ".md"
    row = conn.execute("SELECT id FROM nodes WHERE title=?", (ref,)).fetchone()
    if row:
        return row[0]
    # 文件名匹配
    rows = conn.execute("SELECT id,title FROM nodes").fetchall()
    for (nid, _t) in rows:
        if _basename_no_ext(nid) == ref:
            return nid
    # 宽松匹配（去日期前缀/空格）
    rk = _norm_key(ref)
    for (nid, title) in rows:
        if _norm_key(nid) == rk or (title and _norm_key(title) == rk):
            return nid
    return None


def cmd_related(args):
    conn = connect()
    nid = resolve_id(conn, args.ref)
    if nid is None:
        conn.close()
        die(f"未找到节点: {args.ref}", 2)

    depth = max(1, args.depth)
    visited = {nid}
    frontier = {nid}
    edges = []
    for _ in range(depth):
        nxt = set()
        for cur in frontier:
            # 出边
            for dst, raw in conn.execute(
                "SELECT dst,raw FROM links WHERE src=?", (cur,)
            ).fetchall():
                edges.append({"src": cur, "dst": dst, "raw": raw, "dir": "out"})
                if dst not in visited:
                    nxt.add(dst)
            # 入边
            for src, raw in conn.execute(
                "SELECT src,raw FROM links WHERE dst=?", (cur,)
            ).fetchall():
                edges.append({"src": src, "dst": cur, "raw": raw, "dir": "in"})
                if src not in visited:
                    nxt.add(src)
        visited |= nxt
        frontier = nxt
        if not frontier:
            break

    neighbors = []
    for vid in sorted(visited - {nid}):
        row = conn.execute(
            "SELECT title,tags,type FROM nodes WHERE id=?", (vid,)
        ).fetchone()
        if row:
            neighbors.append({
                "id": vid, "title": row[0],
                "tags": json.loads(row[1]) if row[1] else [],
                "type": row[2], "resolved": True,
            })
        else:
            # 悬挂链接（指向不存在的节点）
            neighbors.append({"id": vid, "title": vid, "tags": [],
                              "type": None, "resolved": False})

    root_row = conn.execute(
        "SELECT title FROM nodes WHERE id=?", (nid,)
    ).fetchone()
    conn.close()
    print(json.dumps({
        "id": nid,
        "title": root_row[0] if root_row else nid,
        "depth": depth,
        "neighbors": neighbors,
        "edges": edges,
    }, ensure_ascii=False))


def cmd_overview(args):
    conn = connect()
    total = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]

    where = ""
    params = ()
    tag_filter = args.tag

    rows = conn.execute(
        "SELECT id,tags,subdir,type FROM nodes"
    ).fetchall()

    by_tag = {}
    by_subdir = {}
    by_type = {}
    matched = 0
    for nid, tags_json, subdir, typ in rows:
        tags = json.loads(tags_json) if tags_json else []
        if tag_filter and tag_filter not in tags:
            continue
        matched += 1
        for t in tags:
            by_tag[t] = by_tag.get(t, 0) + 1
        by_subdir[subdir] = by_subdir.get(subdir, 0) + 1
        by_type[typ] = by_type.get(typ, 0) + 1

    link_count = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    model_row = conn.execute("SELECT model FROM nodes LIMIT 1").fetchone()
    conn.close()

    out = {
        "total_nodes": total,
        "matched_nodes": matched if tag_filter else total,
        "filter_tag": tag_filter,
        "by_tag": dict(sorted(by_tag.items(), key=lambda x: -x[1])),
        "by_subdir": dict(sorted(by_subdir.items(), key=lambda x: -x[1])),
        "by_type": by_type,
        "total_links": link_count,
        "model": model_row[0] if model_row else None,
    }
    print(json.dumps(out, ensure_ascii=False))


# ---------- argparse ----------
def build_parser():
    p = argparse.ArgumentParser(prog="kg", description="本地知识图谱 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("index", help="解析并索引知识库")
    g = pi.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="全量索引（默认）")
    g.add_argument("--file", type=str, help="只索引指定相对路径文件")
    pi.set_defaults(func=cmd_index)

    ps = sub.add_parser("search", help="语义 + 全文混合检索")
    ps.add_argument("query", type=str)
    ps.add_argument("--k", type=int, default=5)
    ps.set_defaults(func=cmd_search)

    pr = sub.add_parser("related", help="按 wikilink 取邻居")
    pr.add_argument("ref", type=str, help="节点 id 或标题")
    pr.add_argument("--depth", type=int, default=1)
    pr.set_defaults(func=cmd_related)

    po = sub.add_parser("overview", help="知识库概览")
    po.add_argument("--tag", type=str, default=None)
    po.set_defaults(func=cmd_overview)
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(e, 1)


if __name__ == "__main__":
    main()
