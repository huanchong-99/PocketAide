---
name: remind
description: >-
  定时提醒。当用户说"什么时候 + 干什么"——如"30分钟后提醒我X""明天9点叫我Y""每天18点提醒我Z""每周一早上提醒我W"——就用这个 skill。
  它把提醒注册成 Windows 计划任务，到点通过飞书发给用户。务必在用户表达"到某个时间点要做某事/被提醒"时主动触发。
---

# remind — 定时提醒（计划任务 + 到点发飞书）

用户说"**什么时候 + 干什么**"就触发。换算时间 → 注册计划任务 → 到点跑 runner 经 `bridge/send-reminder.js` 发飞书。
**一次性到点自删；周期性保留。**

## 时区与持久化（硬要求，务必遵守）

> 凡注册"有具体触发时刻"的计划任务，都要保证**到点按正确钟点触发**、且**关机/重启后照常运行**。时区遵循"**默认本地、用户可改**"——别绝对化。

- **时间一律取本机系统时钟**：`Get-Date`，**绝不联网查时间**（联网拿到的是网页缓存快照，会过时）。
- **默认：跟随本机当前时区**（用户没点名时区时）。
  - 用**浮动本地时间**：挂钟显示几点就几点触发，改时区也跟着走。`register-reminder.ps1` 默认即此（内部把 `StartBoundary` 覆盖成不带 `Z`/offset 的本地串 `yyyy-MM-ddTHH:mm:ss`）。
  - 坑：PowerShell `New-ScheduledTaskTrigger` 默认把 `StartBoundary` 写成带 `Z` 的 UTC（"跨时区同步"），换时区会在错钟点触发——所以才要覆盖。自己另写计划任务脚本也照此。
- **例外：用户明确点名某时区就按用户的来**——**任何国家/地区都要适配，不是固定那几个**（用户可能说巴西、德国、迪拜、印度…）。
  - 给 `register-reminder.ps1` 传 `-TimeZone "<时区>"`：`-At` 按那个时区的挂钟解释，脚本钉死到对应**绝对时刻**（不管本机在哪个时区，到那个时区的那个点就触发；DST 由 Windows 时区库自动处理）。
  - `-TimeZone` 接受两种写法：
    1. **Windows 时区 ID**（约 140 个，覆盖所有国家）——你按用户说的国家/城市映射到准确 ID。**下面只是举例，绝不是白名单**：泰国`SE Asia Standard Time`、美东`Eastern Standard Time`、日本`Tokyo Standard Time`、英国`GMT Standard Time`、印度`India Standard Time`、德国`W. Europe Standard Time`、迪拜`Arabian Standard Time`、巴西`E. South America Standard Time`、UTC`UTC`……其它国家同理。
    2. **原始 UTC 偏移**——用户直接给偏移、或你不确定 ID 时的兜底：`UTC+7`、`GMT-3`、`+05:30`、`-0500`（定值偏移，不含 DST）。
  - **别用 DisplayName 模糊搜**（"India" 会误命中含 "Indiana" 的美国时区）。拿不准就列出全部精确匹配：`powershell -NoProfile -Command "[System.TimeZoneInfo]::GetSystemTimeZones() | Select Id,DisplayName,BaseUtcOffset | Format-Table -Auto"`，按区域+偏移挑对的 ID。传错脚本会报错并给出列举命令，可重试或问用户。
- **关机/重启补跑**：计划任务设 `-StartWhenAvailable`（错过的到点任务开机后立刻补跑）+ `-WakeToRun`（从睡眠唤醒执行）。`register-reminder.ps1` 已含。
- 走 `register-reminder.ps1` 就**自动满足以上全部**（含 `-TimeZone`）；**不要**绕开它去裸调 `schtasks`/`New-ScheduledTaskTrigger` 而漏掉这些保证。

## 流程

### 1. 解析时间（用系统时钟，绝不联网查时间）
先取当前时间：`Get-Date`。把用户说法换算成模式 + 时刻：
- 相对一次性（"30分钟后""2小时后"）→ `once`，`-At` = 现在 + 间隔，格式 `"yyyy-MM-dd HH:mm"`。
- 绝对一次性（"今晚8点""明天9点""6月20号15点"）→ `once`，`-At` = 那个完整日期时间。
- 每天（"每天18点"）→ `daily`，`-At` = `"HH:mm"`。
- 每周（"每周一9点"）→ `weekly`，`-At` = `"HH:mm"`，`-DayOfWeek Monday`（英文星期）。
算不清就问用户。

### 2. 生成 ASCII slug
任务名/文件名要 ASCII。用简短 ASCII slug，如 `rmd-20260616-1830` 或 `rmd-<简短英文/拼音>`。**只含 `A-Za-z0-9_-`**（中文提醒内容不进 slug，进 -Text/-Title）。

### 3. 注册
```bash
powershell -ExecutionPolicy Bypass -NoProfile -File scripts\register-reminder.ps1 -Name <slug> -Text "<提醒正文(可中文/markdown)>" -Title "<标题>" -Mode <once|daily|weekly> -At "<时间>" [-DayOfWeek Monday]
```
脚本会：写 UTF-8 sidecar 存中文正文、生成 ASCII runner、注册 `PocketAide-Remind-<slug>`（**浮动本地时区触发** + `-WakeToRun` + `-StartWhenAvailable`，关机/重启自动补跑）、在 `tasks/reminders/` 留记录。**once 触发后 runner 自注销+自删**。看到 `Registered: PocketAide-Remind-<slug>` 即成功。

### 4. 确认
回用户："已设定——<时间> 提醒你 <内容>（一次性/每天/每周）。" 并说可随时让你取消/查看。

## 查询 / 取消
- 查看全部：`powershell ... -File scripts\list-reminders.ps1`
- 取消：`powershell ... -File scripts\cancel-reminder.ps1 -Name <slug>`（注销任务 + 删 runner/sidecar/记录）

## 边界
- 任务名一律 `PocketAide-Remind-` 前缀；**绝不**动非此前缀的系统计划任务。
- 中文只走 `-Text`/`-Title` 参数，绝不写进 `.ps1`（PS5.1 GBK 会乱码）。
- 提醒脚本/记录只在 `tasks/reminders/`；只在本仓库范围活动。
- 发送复用 `bridge/send-reminder.js`，独立可跑、不要求常驻桥接在线。
