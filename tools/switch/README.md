# tools/switch —— 供应商 / 模型切换底座

管这套系统**此刻用哪个供应商、哪个模型在跑**。它是基础设施，不是技能：在桥接启动时就参与工作，不等人开口。

## 为什么有这个模块（真实事故）

一次"飞书那端回答质量不对劲"的排查，查出来的事实是：

- 终端会话跑 **官方 Anthropic 模型**
- 飞书桥接跑 **某第三方供应商的模型**
- 这个状态已经持续了 **数周**，使用者全程不知情

根因在 `bridge/main.js` 的旧同步逻辑：

```js
for (const k of Object.keys(glb.env)) if (k.startsWith('ANTHROPIC_')) cur.env[k] = glb.env[k];
```

**只覆盖、不删除。** 于是：

1. 全局配了第三方供应商，桥接重启时同步过去 ✅
2. 后来全局把 `ANTHROPIC_*` 整组**删掉**切回官方订阅
3. 全局已无这些键 → 循环一次都不执行 → **桥接纹丝不动**，永远卡在第三方 ❌

更早一次切换的痕迹还留在配置里（顶层 `model` 字段是上上家供应商的模型名），
和实跑的模型自相矛盾——光看配置文件根本猜不出真在跑什么。

## 两条不变量

**① 写入 = 先删净目标端所有 `ANTHROPIC_*`，再写当前供应商的键。**
删除因此天然可被同步，"切回官方"就等于"一个都不写"，不可能再留残影。

**② 顶层 `settings.model` 与 `env.ANTHROPIC_MODEL` 永远一致。**
实测 `ANTHROPIC_MODEL` 优先级更高（配置里顶层写着 A、实跑却是 `ANTHROPIC_MODEL` 指定的 B）。
本模块保证看到什么就是在跑什么。

## 三步顺序（不可调换）

切换供应商是三件事，缺一步或反了顺序都会出问题：

| 步 | 做什么 | 反了会怎样 |
|---|---|---|
| ① 探活 | 先验证目标供应商真能用 | 切过去才发现不通 = 整套系统当场瘫痪，飞书那端只表现为"机器人不吭声" |
| ② 落盘 | 写 settings.json | —— |
| ③ 重启 | 杀掉在跑的会话让它重读 | **Claude Code 只在启动时读一次 settings**，不重启 = 白改；先杀再写则会留窗口期让进程抢读旧值 |

## 用法

```bash
node tools/switch/switch.js status           # 双端体检：配置 vs 实跑 vs 漂移告警
node tools/switch/switch.js list             # 列出所有供应商
node tools/switch/switch.js use official     # 切换（自动走探活→落盘→重启）
node tools/switch/switch.js use <名称> --kill-terminals   # 连终端会话一起结束
node tools/switch/switch.js model <模型名>    # 换模型
node tools/switch/switch.js model <模型名> --alias haiku  # 换某个别名档位
node tools/switch/switch.js check <名称>      # 只探活不切
node tools/switch/switch.js restart          # 不改配置，只让在跑的会话重读
node tools/switch/switch.js ps               # 看在跑的会话进程
```

机器调用一律加 `--json`。

常用开关：

- `--scope global|bridge|both`：作用端，默认 `both`
- `--kill-terminals`：切换后结束终端会话（默认只结束桥接会话）
- `--no-restart`：只改配置不动进程
- `--force` / `--skip-check`：探活失败仍切 / 跳过探活
- `--dry-run`：只看会改什么，不落盘

## 进程层的两条安全底线

写在 `procs.js` 里，都是实测踩出来的：

1. **绝不杀调用者自己。** Claude Code 把自身 pid 放在 `CLAUDE_PID`，据此排除。
   否则"帮我切个供应商"会变成"把你正在说话的窗口干掉"。
2. **绝不把 Claude 桌面应用当成 CLI。** 桌面版进程名同样是 `claude.exe`
   （`WindowsApps\Claude_*\app\Claude.exe` 加一堆 Electron 子进程）。首版实测一扫混进 11 个，
   照单全杀会把使用者的桌面版连窗带聊天一起干掉。现按 `--type=` / `WindowsApps` / `\app\Claude.exe` 三条规则剔干净。

## 文件

| 文件 | 说明 |
|---|---|
| `switch.js` | CLI 入口 + 供 `bridge/main.js` require 的 API（`syncBridge`） |
| `procs.js` | 会话进程发现与终止 |
| `providers.json` | **含真实 API Key，已 gitignore，绝不入库**（首次运行 `init` 生成） |
| `providers.example.json` | 脱敏模板，入库；照着它填自己的供应商 |

首次使用：`node tools/switch/switch.js init` 会从现有的全局 / 桥接配置里把供应商档案播种出来；
没有可播种的第三方配置时，照 `providers.example.json` 手工加一档即可。

## 与桥接的接线

`bridge/main.js` 在**每次拉起 claude 之前**调 `syncBridge()` 落地当前供应商。
因此切换器只需杀掉桥接的 claude 子进程、让它重启即可换供应商，
不必重启整个桥接——飞书那端不掉线，会话靠 `-c` 续上。

切换器加载失败或落地失败都只记日志、不阻断桥接启动：底座自己坏了，不该让整个系统起不来。

## 平台说明

进程层（`procs.js`）目前实现基于 Windows（PowerShell `Get-CimInstance` + `taskkill`），
与本项目其余部分（计划任务、采集 Chrome 等）的平台假设一致。
配置层（`switch.js` 的档案管理、落盘、体检、探活）不依赖平台。
