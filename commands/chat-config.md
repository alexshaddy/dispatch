---
description: Configure Dispatch — platforms, tokens, defaults, briefing preferences
argument-hint: --wizard | --show | --set <key> <value> | --enable <platform> | --disable <platform>
allowed-tools: Bash(*dispatch*)
---

Manage Dispatch configuration.

**Step 1: Run the command**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --wizard
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --show
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --get <key>
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --set <key> <value>
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --enable slack
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --disable discord
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" config --reset --confirm
```

Use dot notation for nested keys: `--set default_platform slack`, `--set platforms.slack.token xoxb-...`, `--set briefing.enabled true`.

**Important:** `--show` and `--get` mask token values — full tokens are never displayed.

**Step 2: Format output**

`--show`: Returns config JSON with tokens masked.
`--set`/`--get`: Returns `{"key": "...", "value": ...}` or `{"status": "updated", ...}`.

**Step 3: Handle errors**

- `--reset` without `--confirm` → exits with error requiring confirmation
- Setting a token: use `--set platforms.slack.token <token>` — displayed as masked in confirmation
