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

## 四个入口，同一套实现

| 入口 | 适合 | 怎么进 |
|---|---|---|
| **托盘菜单** | 高频、零输入：看当前跑什么、一键切换已有档 | 托盘图标 →「当前：xxx」+「切换供应商 ▸」 |
| **Web 页面** | 低频、要输入：加/改供应商、填 Key、看体检、探活 | 托盘 →「供应商设置…」 |
| **命令行** | 脚本化、排查 | `node tools/switch/switch.js ...` |
| **飞书** | 人在外面 | 跟 AI 参谋说"切到 X" / "现在用的什么模型" |

四个入口都走 `switch.js` 的同一套 `CMDS`——**没有任何一个入口能绕过"探活→落盘→重启"**。
页面和命令行各写一份实现的话，迟早会出现"命令行切了、页面显示没切"这种对不上的事，
所以 `webui.js` 直接调 `CMDS.use`，测试里也钉死了这一点（U8）。

### Web 界面的安全设计

页面能读写**全部供应商的明文 API Key**，所以它不是常驻服务：

- **按需起**：点托盘「供应商设置…」才启动，页面停止心跳 45 秒后进程自杀
- **只绑 `127.0.0.1`**：外网和局域网都碰不到
- **随机端口**：`listen(0)`，不占固定端口也不可预测
- **一次性 token**：每次启动新生成，所有 `/api/*` 都校验（时间安全比较）；页面拿到后立刻用
  `history.replaceState` 把它从地址栏抹掉，不留在浏览器历史里
- **Key 只出不进**：返回给页面的 Key 一律打码（`sk-abc***7f21`），页面永远拿不到完整 Key；
  编辑时留空 = 保留原 Key
- **CSP 锁死**：`default-src 'none'`，页面加载不了任何外部资源，杜绝 Key 被第三方脚本捎走

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
node tools/switch/switch.js copy-global      # 把本机全局配置整份复制到桥接（覆盖式）
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
| `switch.js` | CLI 入口 + 供 `bridge/main.js` require 的 API（`syncBridge`）+ 供 Web 复用的 `CMDS` |
| `procs.js` | 会话进程发现与终止 |
| `webui.js` | 本地 Web 服务（按需起、随机端口、一次性 token、心跳自杀） |
| `webui.html` | 单文件前端，原生 JS 无框架，零依赖 |
| `providers.json` | **含真实 API Key，已 gitignore，绝不入库**（首次运行 `init` 生成） |
| `providers.example.json` | 脱敏模板，入库；照着它填自己的供应商 |

首次使用：`node tools/switch/switch.js init` 会从现有的全局 / 桥接配置里把供应商档案播种出来；
没有可播种的第三方配置时，照 `providers.example.json` 手工加一档即可。

## 与托盘的接线

`bridge/tray-host.ps1` 里三项：

- **「当前：xxx / 模型」** — 菜单打开时调 `status --json` 刷新
- **「切换供应商 ▸」** — 调 `list --json` 建二级菜单，勾选当前档；点击走 `use <名称> --json`
- **「供应商设置…」** — 起 `webui.js --no-open`，读它首行打印的 `{url,port,token}` 再开浏览器

两个约束必须守住：

1. **切换不能阻塞 UI 线程。** 探活最长 20 秒，同步调用会把整个托盘菜单冻住。
   所以 `Start-SwitchUse` 用 `Start-Process` 异步起、结果写临时 JSON，由 3 秒 timer 的
   `Poll-SwitchResult` 取回并弹气泡。
2. **`tray-host.ps1` 必须全文件纯 ASCII。** PowerShell 5.1 把无 BOM 的 `.ps1` 当 GBK 解码，
   源码里的中文会乱码，甚至吃掉行尾换行、把下一行静默注释掉。所有中文进 `tray-labels.json`
   （运行时用显式 UTF-8 解码器读），路径一律用 `$PSScriptRoot` 运行时取、不写字面量。
   开发时踩过：测试脚本里写了中文路径字面量，直接变成乱码路径、目录找不到。

## 两端独立：默认零复制，只有一个复制入口

**桥接首次启动时，一个字节都不从本机全局配置拷。** 它只写 `bridge/main.js` 里那份
`BRIDGE_BASELINE_SETTINGS`（两条：`defaultMode=auto`，`deny WebFetch/WebSearch`），
供应商和模型一概不写——那是本模块的职责。

这条规矩是踩了两次才立起来的：

1. 最早是**整份复制**全局 `settings.json`。后果：换新机或桥接 home 被删时，
   若本机当时正配着第三方，那份 Base URL + Key 就被静默继承过去。
2. 后来改成**剥掉 `ANTHROPIC_*` 再复制**。Key 是不带了，可**拷贝这个行为本身仍然错**——
   桥接该有什么配置是桥接自己的事，不该取决于"第一次启动那天本机恰好长什么样"。

现在两端天生独立，谁也不偷看谁。想让飞书端跟本机一致，走**唯一的显式入口**：

```bash
node tools/switch/switch.js copy-global        # 或：托盘「供应商设置…」页面上的按钮
```

它的语义是**整份覆盖**，不是合并：

- **为什么必须覆盖**——合并同步不了"删除"。本机把 `ANTHROPIC_*` 整组删掉切回官方订阅时，
  合并式传不过去，桥接就卡在旧供应商上。这正是旧 `bridge/main.js` 犯的错、那次漂移事故的成因。
- **第三方和官方订阅都能复制**，不做任何剥离：本机配着第三方就连 Base URL + Key 一起搬；
  本机是官方订阅，搬过去的就是"一个 `ANTHROPIC_*` 都没有"，桥接回到官方直连。
  **不需要重新登录**——鉴权走 `.credentials.json` 的 OAuth 凭据，桥接每次启动都从本机刷新那一份。
- **唯一的例外**：复制**第三方**时，桥接原有的 `permissions.deny` 会并回去。
  理由不是"想保留点什么"，而是某些兼容端点对 `WebSearch`/`WebFetch` 的 `tool_reference`
  有服务端 bug，一加载就毒掉整个会话；全局那份没有这条 deny（直连官方不受影响），
  照搬过去等于给桥接埋雷。复制官方配置时不补——那时确实不需要，真·整份覆盖。
- 覆盖前自动备份（`settings.json.switch-bak-*`，留最近 5 份），覆盖后自动重启桥接会话。

> 代价要知道：覆盖是真覆盖。桥接那份里**本机没有的键会被抹掉**（`deny` 除外）。

**唯一还从本机取的东西是登录凭据**（`.credentials.json`，每次启动刷新）。
那是登录态不是配置：订阅 token 会轮换，不取最新就会掉登录、逼着在桥接里重新登一次。

## 与桥接的接线

`bridge/main.js` 在**每次拉起 claude 之前**调 `syncBridge()` 落地当前供应商。
因此切换器只需杀掉桥接的 claude 子进程、让它重启即可换供应商，
不必重启整个桥接——飞书那端不掉线，会话靠 `-c` 续上。

切换器加载失败或落地失败都只记日志、不阻断桥接启动：底座自己坏了，不该让整个系统起不来。

## 平台说明

进程层（`procs.js`）目前实现基于 Windows（PowerShell `Get-CimInstance` + `taskkill`），
与本项目其余部分（计划任务、采集 Chrome 等）的平台假设一致。
配置层（`switch.js` 的档案管理、落盘、体检、探活）不依赖平台。
