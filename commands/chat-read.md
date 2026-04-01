---
description: Read a specific message or thread by ID
argument-hint: [slack|discord] <message-id>
allowed-tools: Bash(*dispatch*)
---

Read a specific message and its thread replies.

**Step 1: Parse arguments**

- `[slack|discord]`: Optional platform override.
- `<message-id>`: Required. Format: `channelId:ts` for Slack, `channelId:messageId` for Discord.

**Step 2: Run the command**

```
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts" read [slack|discord] <message-id>
```

**Step 3: Format output**

Returns a full message object with a `thread_replies` array. Present the message content, author, timestamp, and any replies.

**Step 4: Handle errors**

- `{"error": "message_not_found", ...}` → Invalid message ID format or message doesn't exist
- `{"error": "platform_not_enabled", ...}` → Run /chat-config --enable and set token
