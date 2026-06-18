---
name: task-manage
description: >-
  任务追踪。当用户交办任务、汇报进度、问"我有哪些任务/某任务到哪了"、或说某任务完成了，就用这个 skill。
  一任务一 md 放 tasks/active/，状态 running|blocked|done，进度追加式。务必在用户提到"我开始做/在做的事/进度/做完了/某任务怎么样了"时主动维护，
  即使没明说"任务管理"。安全底线：未完成任务绝不自动删除或归档。
---

# task-manage — 任务追踪（登记 / 进度 / 查询 / 完成 / 归档）

一任务一文件放 `tasks/active/`，进度可追溯，状态流转清晰。**未完成任务绝不自动动它。** 时间一律用系统时钟（`Get-Date`）。

> **核心边界：只追踪，不代做。** 本 skill 只负责"记录任务状态"，**绝不**替用户去执行任务本身，也**不要**主动问"具体怎么做 / 要测什么，我来跑"。用户说"我开始做 X"是让你**记下来**，不是让你去做 X。登记后回一句简短确认即可，进度等用户来汇报。（用户若明确说"你去做 X"，那是「通用助理」模式，不归本 skill。）

## 任务文件格式
路径 `tasks/active/<任务简称>.md`（简称可中文）：
```markdown
---
type: task
status: running   # running | blocked | done
created: YYYY-MM-DD HH:mm
---

# <任务标题>

## 当前进度
- [YYYY-MM-DD HH:mm] 首条：背景/开始

## 下一步计划
- 待办点
```

## 操作（对应 01 场景 3a–3d + 生命周期）

### 3a 登记（新任务）
用户说"我开始做 X"：建 `tasks/active/<简称>.md`，`status: running`，写标题 + 首条进度 + 下一步。
确认就一句，**只确认"记下了"，不揽活**："记下了——X，状态 running。随时把进展发我，我帮你更新进度。"
**不要**追问"具体要做什么 / 要我来做吗 / 告诉我测试项我来跑"——那是越界。

### 3b 进度更新
用户汇报进展：在「当前进度」**追加**一条带时间戳的记录（做了什么、调了什么、下一步），**不覆盖**历史。必要时更新「下一步计划」。卡住 → `status: blocked` 写明卡点；恢复 → 改回 `running`。确认已更新。

### 3c 状态查询
用户问"X 到哪了"：读对应任务，返回 任务内容 + 当前进度 + 下一步。多个匹配 → 列出让用户选。

### 3d 完成
用户说"X 做完了"：`status: done`，在进度追加「✅ 完成 [YYYY-MM-DD HH:mm]」，并在 frontmatter 加 `completed: YYYY-MM-DD HH:mm`（归档脚本据此判断保留期）。**完成后仍先留在 `tasks/active/`**，不立即删。

### 归档（生命周期，仅对 done）
已完成任务保留若干天后归档（搬到 `tasks/archive/`，留摘要删详情）：
```bash
python tools/tasks/archive.py            # 归档完成超过7天的 done 任务
python tools/tasks/archive.py --days 3   # 自定保留期
python tools/tasks/archive.py --dry-run  # 只看不动
```
脚本**只动超期 done**，running/blocked/未超期/无完成时间的一律跳过。解析 stdout JSON 看 `archived`/`skipped`。
**安全（硬）**：未完成（running/blocked）任务绝不归档/删除。拿不准就不动、问用户。

## 版本控制
每次写入 `PostToolUse` 钩子自动 commit；push 由桥接层统一做。

## 边界
- 任务文件只在 `tasks/`（active/archive）。定时提醒交给 `remind`。
- 只在本仓库范围活动。
