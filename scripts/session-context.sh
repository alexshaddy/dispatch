#!/bin/bash
set -euo pipefail

SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
CONFIG_FILE="$HOME/.config/dispatch/config.json"

# Exit silently if not configured
[ -f "$CONFIG_FILE" ] || exit 0

# Check if briefing is enabled
BRIEFING_ENABLED=$(python3 -c "
import json
try:
    config = json.load(open('$CONFIG_FILE'))
    print('true' if config.get('briefing', {}).get('enabled', True) else 'false')
except:
    print('false')
" 2>/dev/null)

[ "$BRIEFING_ENABLED" = "true" ] || exit 0

# Determine which timeout command to use (macOS compatibility)
TIMEOUT_CMD=$(command -v gtimeout || command -v timeout || echo "")

# Run briefing subcommand (5s timeout)
if [ -n "$TIMEOUT_CMD" ]; then
    BRIEFING_JSON=$($TIMEOUT_CMD 5 bun run "$SCRIPT_DIR/dispatch.ts" briefing 2>/dev/null || echo '{}')
else
    BRIEFING_JSON=$(bun run "$SCRIPT_DIR/dispatch.ts" briefing 2>/dev/null || echo '{}')
fi

# If save_directory is configured, save briefing to disk
SAVE_DIR=$(python3 -c "
import json
try:
    data = json.loads('''$BRIEFING_JSON''')
    print(data.get('save_directory', ''))
except:
    print('')
" 2>/dev/null)

if [ -n "$SAVE_DIR" ]; then
    DATE=$(date +%Y-%m-%d)
    BRIEF_DIR="$SAVE_DIR/dispatch/briefs"
    mkdir -p "$BRIEF_DIR"
    echo "$BRIEFING_JSON" > "$BRIEF_DIR/$DATE-briefing.json" 2>/dev/null || true
fi

# Format output as markdown
python3 -c "
import json, sys, os

root = os.environ.get('CLAUDE_PLUGIN_ROOT', '')

try:
    data = json.loads('''$BRIEFING_JSON''')
except:
    data = {}

lines = []

slack = data.get('slack', {})
if slack and isinstance(slack, dict):
    unread = slack.get('unread_count', 0)
    by_channel = slack.get('unread_by_channel', {})
    mentions = slack.get('mentions', [])
    dms = slack.get('dms', [])

    channel_str = ', '.join(f'{k}: {v}' for k, v in list(by_channel.items())[:5])
    mention_count = len(mentions)
    dm_count = len(dms)

    parts = [f'{unread} unread']
    if channel_str:
        parts[0] = f'{unread} unread ({channel_str})'
    if mention_count:
        parts.append(f'{mention_count} mention{\"s\" if mention_count != 1 else \"\"}')
    if dm_count:
        parts.append(f'{dm_count} DM{\"s\" if dm_count != 1 else \"\"}')

    lines.append('Dispatch: Slack — ' + ', '.join(parts))

    for m in mentions[:3]:
        ch = m.get('channel', '?')
        frm = m.get('from', '?')
        snippet = m.get('snippet', '')[:80]
        lines.append(f'  Mention: @{frm} in {ch}: \"{snippet}\"')

    for d in dms[:3]:
        frm = d.get('from', '?')
        snippet = d.get('snippet', '')[:80]
        lines.append(f'  DM: {frm}: \"{snippet}\"')

discord = data.get('discord', {})
if discord and isinstance(discord, dict):
    unread = discord.get('unread_count', 0)
    by_channel = discord.get('unread_by_channel', {})
    channel_str = ', '.join(f'{k}: {v}' for k, v in list(by_channel.items())[:5])
    line = f'Dispatch: Discord — {unread} unread'
    if channel_str:
        line += f' ({channel_str})'
    lines.append(line)

warning = data.get('warning', '')
if 'slack_unavailable' in warning:
    lines.append('  ⚠ Slack: API unavailable (token expired or network error)')
if 'discord_unavailable' in warning:
    lines.append('  ⚠ Discord: API unavailable (token expired or network error)')

if not lines:
    content = ''
else:
    content = 'Dispatch plugin root: ' + root + '\n\n' + '\n'.join(lines)

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': content
    }
}))
"
