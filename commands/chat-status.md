---
description: Set or check presence and custom status
argument-hint: [slack|discord] [--set <text>] [--emoji <emoji>] [--presence <state>] [--clear] [--show]
allowed-tools: Bash(*dispatch*)
---

Check or update your presence and status on Slack or Discord.

**Step 1: Parse arguments**

- `[slack|discord]`: Optional platform override.
- `--set <text>`: Set custom status text.
- `--emoji <emoji>`: Status emoji (Slack only, e.g., `:coffee:`).
- `--presence <state>`: Set presence. Slack: `auto`, `away`. Discord: `online`, `idle`, `dnd`, `invisible` (requires Gateway — deferred, will return warning).
- `--clear`: Clear custom status.
- `--show`: Show current status (default when no mutation flags).

**Note on Discord:** Setting Discord presence requires WebSocket Gateway. The current version returns the current status read with a `warning: "discord_status_requires_gateway"` field.

**Step 2: Run the command**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" status [slack|discord] [--set <text>] [--emoji <emoji>] [--presence <state>] [--clear]
```

**Step 3: Format output**

Returns: `{"platform": "slack", "presence": "auto", "status_text": "In a meeting", "status_emoji": ":calendar:", "dnd": false}`

**Step 4: Handle errors**

- `{"error": "platform_not_enabled", ...}` → Run /chat-config --enable and set token
- Response with `warning: "discord_status_requires_gateway"` → Expected — Discord status setting requires future Gateway support
