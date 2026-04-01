---
description: Send a message — two-step draft preview then confirmed send
argument-hint: [slack|discord] [<channel>] <message> [--thread <id>] [--confirmed]
allowed-tools: Bash(*dispatch*)
---

Send a message to a Slack or Discord channel. **Always shows a draft preview first — requires --confirmed to actually send.**

**Step 1: Parse arguments**

- `[slack|discord]`: Optional platform override.
- `[<channel>]`: Optional channel. If omitted, uses `default_channel`. If first positional is not a platform name, treated as the channel.
- `<message>`: Required. Quoted string or all remaining arguments joined.
- `--thread <id>`: Reply to a thread.
- `--confirmed`: Required to actually send. Without this flag, only a draft preview is returned.

**Step 2: Run the command — Draft preview first**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" send [slack|discord] [<channel>] "<message>"
```

This returns a draft object. **Show it to the user and ask for confirmation before sending.**

**Step 3: If user confirms, run with --confirmed**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" send [slack|discord] [<channel>] "<message>" --confirmed
```

**Step 4: Format output**

Draft: `{"status": "draft", "platform": "slack", "channel": "#general", "content": "..."}`
Sent: `{"status": "sent", "platform": "slack", "channel": "#general", "message_id": "..."}`

**Step 5: Handle errors**

- `{"error": "send_failed", ...}` → Slack/Discord API rejected the message; check error details
- `{"error": "channel_not_specified", ...}` → Pass channel arg or set default_channel in config
- `{"error": "token_invalid", ...}` → Token expired; run /chat-config --wizard to update
