#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Task archiver for the personal AI advisor system.

Lifecycle (per 01-用户功能规格书.md scenario 3 + CLAUDE.md):
  - running / blocked tasks  -> NEVER touched.
  - done tasks completed >= N days ago (default 7) -> moved to tasks/archive/
    keeping ONLY a summary (goal + result + completion time); verbose process
    detail is dropped.

Time uses the local system clock (datetime.now), never the network.

Usage:
  python tools/tasks/archive.py                 # archive done tasks older than 7 days
  python tools/tasks/archive.py --days 3        # custom retention
  python tools/tasks/archive.py --active-dir <dir> --archive-dir <dir>   # for testing
  python tools/tasks/archive.py --dry-run       # report only, change nothing

Output: a JSON object on stdout: {"archived": [...], "skipped": [...], ...}
"""
import argparse
import datetime as _dt
import json
import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_ACTIVE = os.path.join(REPO_ROOT, "tasks", "active")
DEFAULT_ARCHIVE = os.path.join(REPO_ROOT, "tasks", "archive")

FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)

# Date/datetime patterns we accept inside frontmatter values.
_DT_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d",
]


def parse_frontmatter(text):
    """Return (meta_dict, body_str). meta is a flat str->str map (good enough here)."""
    m = FM_RE.match(text)
    if not m:
        return {}, text
    raw, body = m.group(1), m.group(2)
    meta = {}
    for line in raw.split("\n"):
        line = line.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        idx = line.find(":")
        if idx == -1:
            continue
        key = line[:idx].strip()
        val = line[idx + 1:].strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        meta[key] = val
    return meta, body


def parse_dt(s):
    if not s:
        return None
    s = s.strip().strip('"').strip("'")
    for fmt in _DT_FORMATS:
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def find_completion_time(meta, body):
    """Best-effort completion timestamp: prefer explicit frontmatter keys, else scan body."""
    for key in ("completed", "completed_at", "done_at", "finished", "completion", "finished_at"):
        dt = parse_dt(meta.get(key, ""))
        if dt:
            return dt, meta[key].strip()
    # Scan body for a line mentioning completion + a timestamp.
    for line in body.split("\n"):
        if re.search(r"(完成时间|完成于|完成|done|completed)", line, re.IGNORECASE):
            mt = re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?", line)
            if mt:
                dt = parse_dt(mt.group(0))
                if dt:
                    return dt, mt.group(0)
    return None, None


def extract_summary(meta, body):
    """Pull a goal + result from the body if present; fall back gracefully."""
    def section(names):
        # find a markdown heading whose text contains any of `names`, return its block text
        lines = body.split("\n")
        for i, ln in enumerate(lines):
            h = re.match(r"^#{1,6}\s*(.+?)\s*#*\s*$", ln)
            if h and any(n in h.group(1) for n in names):
                buf = []
                for nxt in lines[i + 1:]:
                    if re.match(r"^#{1,6}\s+", nxt):
                        break
                    buf.append(nxt)
                return "\n".join(buf).strip()
        return ""

    goal = section(["目标", "任务目标", "内容", "goal", "objective"])
    result = section(["结果", "成果", "结论", "result", "outcome"])

    # Real tasks (task-manage SKILL) don't use 目标/结果 sections — they use an appended
    # '## 当前进度' log (first entry = background/start, last = latest state / ✅完成 line).
    # Without this fallback the archive summary loses "什么完成了" and keeps only the time.
    if not goal or not result:
        progress = section(["当前进度", "进度", "progress"])
        bullets = [re.sub(r"^[-*]\s*", "", b).strip() for b in progress.split("\n") if b.strip()]
        if bullets:
            if not goal:
                goal = bullets[0]
            if not result:
                last = bullets[-1]
                # if the last entry is just a terse completion marker, prepend the prior one
                if len(bullets) >= 2 and re.search(r"(完成|done|✅)", last) and len(last) < 12:
                    result = bullets[-2] + "；" + last
                else:
                    result = last
    return goal, result


def build_archive_md(slug, meta, goal, result, comp_label):
    title = meta.get("title") or slug
    created = meta.get("created", "")
    lines = []
    lines.append("---")
    lines.append("type: task")
    lines.append("status: done")
    lines.append("archived: true")
    if created:
        lines.append("created: %s" % created)
    if comp_label:
        lines.append("completed: %s" % comp_label)
    lines.append("archived_at: %s" % _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("---")
    lines.append("")
    lines.append("# %s" % title)
    lines.append("")
    lines.append("## 摘要")
    if goal:
        lines.append("- 目标：%s" % goal.replace("\n", " ").strip())
    if result:
        lines.append("- 结果：%s" % result.replace("\n", " ").strip())
    lines.append("- 完成时间：%s" % (comp_label or "未知"))
    lines.append("")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Archive completed (done) tasks older than N days.")
    ap.add_argument("--days", type=int, default=7, help="retention days before a done task is archived (default 7)")
    ap.add_argument("--active-dir", default=DEFAULT_ACTIVE)
    ap.add_argument("--archive-dir", default=DEFAULT_ARCHIVE)
    ap.add_argument("--dry-run", action="store_true", help="report only; do not move/delete")
    args = ap.parse_args(argv)

    now = _dt.datetime.now()
    cutoff = now - _dt.timedelta(days=args.days)

    active_dir = os.path.abspath(args.active_dir)
    archive_dir = os.path.abspath(args.archive_dir)

    result = {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"),
        "retention_days": args.days,
        "cutoff": cutoff.strftime("%Y-%m-%d %H:%M:%S"),
        "active_dir": active_dir,
        "archive_dir": archive_dir,
        "dry_run": args.dry_run,
        "archived": [],
        "skipped": [],
    }

    if not os.path.isdir(active_dir):
        result["error"] = "active dir not found: %s" % active_dir
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    if not args.dry_run and not os.path.isdir(archive_dir):
        os.makedirs(archive_dir, exist_ok=True)

    for name in sorted(os.listdir(active_dir)):
        if not name.lower().endswith(".md"):
            continue
        path = os.path.join(active_dir, name)
        if not os.path.isfile(path):
            continue
        slug = name[:-3]
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            result["skipped"].append({"file": name, "reason": "read error: %s" % e})
            continue

        meta, body = parse_frontmatter(text)
        status = (meta.get("status") or "").strip().lower()

        # SAFETY: never touch anything that isn't explicitly done.
        if status != "done":
            result["skipped"].append({"file": name, "status": status or "(none)", "reason": "not done"})
            continue

        comp_dt, comp_label = find_completion_time(meta, body)
        if comp_dt is None:
            result["skipped"].append({"file": name, "status": "done", "reason": "no completion time found; not archiving"})
            continue

        if comp_dt > cutoff:
            result["skipped"].append({
                "file": name, "status": "done", "completed": comp_label,
                "reason": "within retention window",
            })
            continue

        goal, res = extract_summary(meta, body)
        summary_md = build_archive_md(slug, meta, goal, res, comp_label)
        dest = os.path.join(archive_dir, name)

        entry = {"file": name, "completed": comp_label, "dest": dest}
        if args.dry_run:
            entry["action"] = "would archive"
            result["archived"].append(entry)
            continue

        try:
            with open(dest, "w", encoding="utf-8") as f:
                f.write(summary_md)
            os.remove(path)
            entry["action"] = "archived"
            result["archived"].append(entry)
        except Exception as e:
            result["skipped"].append({"file": name, "reason": "archive write/remove error: %s" % e})

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
