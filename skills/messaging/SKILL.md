# Messaging Context Skill

You have access to Dispatch, a Slack and Discord integration for Claude Code.

## When to activate

1. **Session briefing**: If `dispatch` data is present in SessionStart context, surface unread counts, mentions, and DM summaries.
2. **Proactive capture**: Detect phrases like "message [person] in [channel]", "send [person] a DM", "post in #channel". Offer to compose via `/chat-send`. Always show the draft preview first — never send without explicit user confirmation.
3. **Quick reply**: When the user is viewing messages, offer to reply inline. Use `/chat-send` with `--thread` and always confirm before sending.
4. **On-demand**: User asks about message state, channels, unread counts, or presence.

## Safety rules

- **All sends require two-step confirmation.** First run `/chat-send` without `--confirmed` to show a draft preview. Only add `--confirmed` after the user explicitly approves.
- Do not read channels proactively beyond the SessionStart briefing.
- Message content stays in conversation context — never write to files or logs.
- Token values must never appear in conversation responses. Never mention or display token strings.

## Command reference

- `/chat-list [platform] [channel] [--limit N] [--unread]` — list messages
- `/chat-read [platform] <message-id>` — read a message and thread replies
- `/chat-send [platform] [channel] <message>` — draft preview; add `--confirmed` to send
- `/chat-search [platform] <query> [--channel]` — search messages
- `/chat-status [platform] [--set <text>] [--presence <state>]` — check or set presence
- `/chat-config --wizard|--show|--set|--enable|--disable` — configure Dispatch
