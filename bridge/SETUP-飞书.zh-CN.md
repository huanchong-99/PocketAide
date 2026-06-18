[English](SETUP-飞书.md) | **中文**

# 飞书接入设置（只有你能做的部分）

Phase 1B 代码已开发完成。下面是**只有你能做**的飞书后台配置 + 启动调试步骤。

## 一、飞书开放平台后台（用你的账号登录 https://open.feishu.cn/）

1. **创建企业自建应用**：开发者后台 → 创建应用 → 自建应用，填名称头像。
2. **开启机器人能力**：应用功能 → 机器人 → 启用。
3. **配置权限**（权限管理里搜索并添加）：
   - `im:message`（收发单聊消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
4. **事件订阅 — 必须选「长连接」方式**：事件订阅 → 订阅方式选 **长连接**（不要填请求网址）→ 添加事件 `接收消息 im.message.receive_v1`。
5. **拿凭据**：凭据与基础信息页 → 复制 **App ID** 和 **App Secret**。
6. **发布版本**：版本管理与发布 → 创建版本 → 申请发布（自建应用通常即时生效）。
7. 在飞书客户端里**把这个机器人加为联系人/发起单聊**。

## 二、填凭据

编辑 `bridge\.env`，先填两项（open_id 可留空）：

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
OWNER_OPEN_ID=
```

## 三、启动 + 拿到你的 open_id（自动）

在仓库里运行：

```
cd bridge
node main.js
```

看到「飞书长连接已启动【发现模式】」后，在飞书里给机器人**发任意一句话**。
机器人会回复你的 `open_id`（形如 `ou_xxxx`）。把它填回 `.env` 的 `OWNER_OPEN_ID`，
`Ctrl+C` 停掉再重新 `node main.js`。

## 四、正式对话（端到端调试）

重启后看到「只认 open_id=ou_xxxx」即正常。此时你在飞书发消息：
机器人先回「🤔 正在思考…」卡片，几秒后更新为 claude 的回复。

- 全程复用 Max 额度（无 API key、无额外计费）。
- 只响应你本人的 open_id，别人发消息会被忽略。

## 五、开机自启（调试通过后再做）

```
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
```

登录时自动拉起桥接，仅本项目、cwd 钉死本仓库。撤销：加 `-Remove`。

## 出问题时

- 启动报「缺少字段」→ `.env` 没填全。
- 发消息没反应 → 确认事件订阅是「长连接」且已订阅 `im.message.receive_v1`、版本已发布、机器人已加单聊。
- `/doctor` 里 MCP 的告警可忽略（Phase 4 才接 chrome-devtools）。
