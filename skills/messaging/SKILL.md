# Messaging Context Skill

You have access to Dispatch, a Slack and Discord integration for Claude Code.

## Mode 1: Morning Briefing Integration

When the morning briefing protocol fires (MORNING_BRIEFING_TRIGGER in SessionStart context):

Run `bun run dispatch.ts briefing` to fetch fresh messaging state.

Surface the Dispatch section of the briefing as item 11 (Messaging) in the CLI output:
- **Slack:** unread count by channel, mention count, DM count and snippets
- **Discord:** unread count by channel (note: requires Gateway for full counts)
- If no platforms are configured: "No platforms configured — run /chat-config --wizard."
- If platforms are configured but API unavailable: show the warning from the hook output

**The full briefing structure and section ordering is defined in `briefing_system.md` — do not use a different structure here. Dispatch's role is to supply messaging state to the briefing protocol.**

## Mode 2: Proactive Capture

Detect phrases like "message [person] in [channel]", "send [person] a DM", "post in #channel". Offer to compose via `/chat-send`. Always show the draft preview first — never send without explicit user confirmation.

## Mode 3: Quick Reply

When the user is viewing messages, offer to reply inline. Use `/chat-send` with `--thread` and always confirm before sending.

## Mode 4: On-Demand

User asks about message state, channels, unread counts, or presence.

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
