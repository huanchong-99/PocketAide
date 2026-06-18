**English** | [中文](SETUP-飞书.zh-CN.md)

# Feishu integration setup (the part only you can do)

The Phase 1B code is complete. Below is the **part only you can do** — the Feishu console configuration plus the startup/debug steps.

## 1. Feishu Open Platform console (log in with your account at https://open.feishu.cn/)

1. **Create a self-built app**: Developer console → Create app → Custom app; set a name and icon.
2. **Enable the bot capability**: App features → Bot → enable.
3. **Configure permissions** (search and add them under Permissions):
   - `im:message` (send/receive direct messages)
   - `im:message:send_as_bot` (send messages as the bot)
4. **Event subscription — you MUST choose "long connection"**: Event subscription → set the subscription method to **long connection** (do NOT enter a request URL) → add the event `Receive message im.message.receive_v1`.
5. **Get the credentials**: Credentials & basic info page → copy the **App ID** and **App Secret**.
6. **Publish a version**: Version management & release → create a version → request release (a custom app usually takes effect immediately).
7. In the Feishu client, **add this bot as a contact / start a direct chat**.

## 2. Fill in the credentials

Edit `bridge\.env`; fill in the first two values (open_id can stay empty for now):

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
OWNER_OPEN_ID=
```

## 3. Start + obtain your open_id (automatic)

Run from the repo:

```
cd bridge
node main.js
```

Once you see "Feishu long connection started [discovery mode]", **send the bot any message** in Feishu. The bot replies with your `open_id` (looks like `ou_xxxx`). Put it into `OWNER_OPEN_ID` in `.env`, press `Ctrl+C` to stop, then run `node main.js` again.

## 4. Real conversation (end-to-end debug)

After restarting, seeing "only responding to open_id=ou_xxxx" means it's working. Now when you send a message in Feishu: the bot first replies with a "🤔 Thinking…" card, then updates it to claude's reply a few seconds later.

- The whole path reuses your Max quota (no API key, no extra billing).
- It only responds to your own open_id; messages from anyone else are ignored.

## 5. Auto-start on boot (do this only after debugging succeeds)

```
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
```

It launches the bridge at login — this project only, with cwd pinned to this repo. To undo: add `-Remove`.

## Troubleshooting

- Startup says "missing fields" → `.env` isn't fully filled in.
- No response to messages → confirm the event subscription is "long connection", `im.message.receive_v1` is subscribed, the version is published, and the bot has been added to a direct chat.
- MCP warnings in `/doctor` can be ignored (chrome-devtools isn't wired up until Phase 4).
