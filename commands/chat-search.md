---
description: Search message history (full-text on Slack; client-side substring on Discord)
argument-hint: [slack|discord] <query> [--channel <name>] [--from-user <user>] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD]
allowed-tools: Bash(*dispatch*)
---

Search message history.

**Step 1: Parse arguments**

- `[slack|discord]`: Optional platform override.
- `<query>`: Required. Search text.
- `--channel <name>`: Filter to a specific channel.
- `--from-user <user>`: Filter by author username.
- `--date-from <YYYY-MM-DD>`: Start date (Slack only).
- `--date-to <YYYY-MM-DD>`: End date (Slack only).
- `--limit <N>`: Max results.

**Note on Discord:** Discord's REST API has no full-text search. The `<query>` is matched client-side (case-insensitive substring) against fetched messages. `--channel` is required for Discord search. `--date-from`/`--date-to` have no effect on Discord.

**Step 2: Run the command**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" search [slack|discord] "<query>" [--channel <name>] [--from-user <user>] [--date-from <date>] [--date-to <date>] [--limit <N>]
```

**Step 3: Format output**

Returns a JSON array of message objects (same format as chat-list). Present as a formatted list with channel context.

**Step 4: Handle errors**

- `{"error": "channel_not_specified", ...}` → For Discord, --channel with a numeric channel ID is required
- `{"error": "network_error", ...}` → Slack search requires a token with `search:read` scope
