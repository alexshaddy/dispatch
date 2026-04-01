---
description: List recent messages in a Slack or Discord channel
argument-hint: [slack|discord] [<channel>] [--limit N] [--unread] [--thread <id>]
allowed-tools: Bash(*dispatch*)
---

List recent messages from a channel.

**Step 1: Parse arguments**

- `[slack|discord]`: Optional platform override. If omitted, uses `default_platform` from config.
- `[<channel>]`: Optional channel name/ID. If omitted, uses `default_channel` from platform config.
- `--limit <N>`: Max messages to return (overrides `default_limit`).
- `--unread` / `--no-unread`: Show only unread messages (overrides `default_unread_only`).
- `--thread <id>`: List replies in a specific thread.

**Step 2: Run the command**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" list [slack|discord] [<channel>] [--limit <N>] [--unread|--no-unread] [--thread <id>]
```

**Step 3: Format output**

Returns a JSON array of message objects. Present as a formatted list: timestamp, author, content, reaction counts.

**Step 4: Handle errors**

- `{"error": "not_configured", ...}` → Run /chat-config --wizard first
- `{"error": "platform_not_specified", ...}` → Pass platform arg or set default: `/chat-config --set default_platform slack`
- `{"error": "platform_not_enabled", ...}` → Run /chat-config --enable slack/discord and set token
- `{"error": "channel_not_found", ...}` → Check channel name/ID; for Discord, use numeric channel ID
