# Dispatch

Slack and Discord integration for Claude Code.

## Requirements

- Bun ≥ 1.0
- Slack Bot User OAuth Token (`xoxb-...`) for Slack
- Discord Bot Token for Discord

## Installation

Install via the-grounds plugin manager.

## Commands

| Command | Description |
|---------|-------------|
| `/chat-list` | List recent messages |
| `/chat-read` | Read a message and thread |
| `/chat-send` | Send a message (two-step confirmation) |
| `/chat-search` | Search message history |
| `/chat-status` | Check or set presence |
| `/chat-config` | Configure Dispatch |

## Configuration

Run `/chat-config --wizard` to get started. Set tokens with:
```
/chat-config --set platforms.slack.token xoxb-your-token
/chat-config --enable slack
```

## License

MIT © 2026 alexshaddy
