# Changelog

## [0.1.0] — 2026-04-01

### Added
- `chat-list`: List recent messages in a Slack or Discord channel
- `chat-read`: Read a specific message and its thread replies
- `chat-send`: Two-step draft-then-send for Slack and Discord
- `chat-search`: Full-text search on Slack; client-side substring match on Discord
- `chat-status`: Presence and custom status management (Slack full; Discord deferred pending Gateway)
- `chat-config`: Wizard, show, get/set dot notation, enable/disable platforms, reset
- SessionStart hook with opt-in messaging briefing
- Messaging context skill for proactive send capture and briefing surface
- HTTPS enforcement and rate-limit handling in fetchJSON()
- Token masking — tokens never surfaced in stdout or error output
