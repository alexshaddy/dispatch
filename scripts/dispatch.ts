#!/usr/bin/env bun
// Dispatch — Slack and Discord integration for Claude Code
// Run: bun run scripts/dispatch.ts <subcommand> [args]

// =============================================================================
// SECTION 1: Version
// =============================================================================

const VERSION = "0.1.0";

// =============================================================================
// SECTION 2: JSON Output Helpers
// =============================================================================

function printJSON(data: unknown): void {
  console.log(JSON.stringify(data));
}

function exitWithError(code: string, message: string, extra?: Record<string, unknown>): never {
  process.stderr.write(JSON.stringify({ error: code, message, ...extra }) + "\n");
  process.exit(1);
}

// =============================================================================
// SECTION 3: Config
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".config", "dispatch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface PlatformConfig {
  enabled: boolean;
  token: string;
  default_channel: string | null;
  workspaces?: string[];   // Slack
  guilds?: string[];       // Discord
}

interface Config {
  default_platform: string | null;
  platforms: {
    slack: PlatformConfig;
    discord: PlatformConfig;
  };
  briefing: {
    enabled: boolean;
    show_unread_count: boolean;
    show_mentions: boolean;
    show_dms: boolean;
    summary_limit: number;
  };
  default_limit: number;
  default_unread_only: boolean;
  save_directory: string;
}

const DEFAULT_CONFIG: Config = {
  default_platform: null,
  platforms: {
    slack: { enabled: false, token: "", default_channel: null, workspaces: [] },
    discord: { enabled: false, token: "", default_channel: null, guilds: [] },
  },
  briefing: {
    enabled: true,
    show_unread_count: true,
    show_mentions: true,
    show_dms: true,
    summary_limit: 5,
  },
  default_limit: 20,
  default_unread_only: true,
  save_directory: "",
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}

function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

function maskToken(token: string): string {
  if (!token || token.length < 12) return "****";
  return token.substring(0, 6) + "****..." + "****" + token.slice(-4);
}

/** Resolve platform: explicit arg > default_platform config > error */
function resolvePlatform(arg: string | null, config: Config): string {
  if (arg === "slack" || arg === "discord") return arg;
  if (config.default_platform === "slack" || config.default_platform === "discord") {
    return config.default_platform;
  }
  exitWithError("platform_not_specified", "Specify a platform (slack or discord) or set a default with chat-config --set default_platform slack");
}

/** Resolve channel: explicit arg > platform default_channel > error */
function resolveChannel(arg: string | null, platform: string, config: Config): string {
  if (arg) return arg;
  const platformConfig = config.platforms[platform as "slack" | "discord"];
  if (platformConfig.default_channel) return platformConfig.default_channel;
  exitWithError("channel_not_specified", `Specify a channel or set a default with chat-config --set platforms.${platform}.default_channel <channel>`);
}

// =============================================================================
// SECTION 4: HTTP Helpers
// =============================================================================

interface FetchJSONOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

async function fetchJSON<T>(url: string, options: FetchJSONOptions = {}): Promise<T> {
  // HTTPS enforcement
  if (!url.startsWith("https://")) {
    exitWithError("network_error", `Only HTTPS URLs are allowed. Got: ${url}`);
  }

  const { method = "GET", headers = {}, body, timeoutMs = 10000 } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      exitWithError("network_error", `Request timed out after ${timeoutMs}ms: ${url}`);
    }
    exitWithError("network_error", `Network request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  // Rate limit handling
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("retry-after") ?? "60");
    exitWithError("rate_limited", `Rate limited. Retry after ${retryAfter} seconds.`, { retry_after: retryAfter });
  }

  // Auth errors
  if (response.status === 401 || response.status === 403) {
    exitWithError("token_invalid", "API returned 401/403 — token may be expired or revoked. Run chat-config --wizard to update your token.");
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    exitWithError("network_error", `API returned ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// =============================================================================
// SECTION 5: Slack Adapter
// =============================================================================

interface MessageObject {
  id: string;
  author: { name: string; username: string };
  content: string;
  timestamp: string;
  channel: string;
  thread_id: string | null;
  reply_count: number;
  reactions: Array<{ emoji: string; count: number }>;
  has_attachments: boolean;
  platform: string;
}

function slackAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function toISO(slackTs: string): string {
  return new Date(parseFloat(slackTs) * 1000).toISOString();
}

function normalizeSlackMessage(msg: Record<string, unknown>, channelName: string): MessageObject {
  return {
    id: String(msg.ts ?? ""),
    author: {
      name: String((msg.user_profile as Record<string, unknown> | undefined)?.real_name ?? msg.user ?? "Unknown"),
      username: String(msg.user ?? ""),
    },
    content: String(msg.text ?? ""),
    timestamp: toISO(String(msg.ts ?? "0")),
    channel: channelName,
    thread_id: msg.thread_ts && msg.thread_ts !== msg.ts ? String(msg.thread_ts) : null,
    reply_count: Number(msg.reply_count ?? 0),
    reactions: ((msg.reactions as Array<{ name: string; count: number }>) ?? []).map((r) => ({
      emoji: r.name,
      count: r.count,
    })),
    has_attachments: Array.isArray(msg.attachments) && (msg.attachments as unknown[]).length > 0,
    platform: "slack",
  };
}

async function slackList(token: string, channel: string, limit: number, unreadOnly: boolean, threadId?: string): Promise<MessageObject[]> {
  // Resolve channel ID if needed
  const channelsResp = await fetchJSON<{ ok: boolean; channels: Array<{ id: string; name: string }> }>(
    "https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel",
    { headers: slackAuthHeader(token) }
  );

  const channelName = channel.replace("#", "");
  const channelObj = channelsResp.channels?.find((c) => c.name === channelName || c.id === channel);
  if (!channelObj) exitWithError("channel_not_found", `Channel '${channel}' not found in Slack workspace.`);

  const endpoint = threadId
    ? `https://slack.com/api/conversations.replies?channel=${channelObj.id}&ts=${threadId}&limit=${limit}`
    : `https://slack.com/api/conversations.history?channel=${channelObj.id}&limit=${limit}`;

  const resp = await fetchJSON<{ ok: boolean; messages: Array<Record<string, unknown>> }>(
    endpoint,
    { headers: slackAuthHeader(token) }
  );

  if (!resp.ok) exitWithError("channel_not_found", `Slack API error fetching messages from '${channel}'.`);

  let messages = (resp.messages ?? []).map((m) => normalizeSlackMessage(m, `#${channelObj.name}`));

  // Simple unread simulation: Slack Web API doesn't expose per-channel unread without marks
  // We return all messages and note in the response that unread filtering is approximate
  return messages.slice(0, limit);
}

async function slackRead(token: string, messageId: string): Promise<MessageObject & { thread_replies?: MessageObject[] }> {
  // messageId format: "channelId:ts" — e.g. "C1234:1234567890.123456"
  const parts = messageId.split(":");
  if (parts.length < 2) exitWithError("message_not_found", `Invalid message ID format. Expected 'channelId:ts'. Got: ${messageId}`);

  const [channelId, ts] = parts;

  const resp = await fetchJSON<{ ok: boolean; messages: Array<Record<string, unknown>> }>(
    `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${ts}&limit=100`,
    { headers: slackAuthHeader(token) }
  );

  if (!resp.ok || !resp.messages?.length) exitWithError("message_not_found", `Message '${messageId}' not found.`);

  const parent = normalizeSlackMessage(resp.messages[0], `channel:${channelId}`);
  const replies = resp.messages.slice(1).map((m) => normalizeSlackMessage(m, `channel:${channelId}`));

  return { ...parent, thread_replies: replies };
}

async function slackSend(token: string, channel: string, text: string, threadId?: string): Promise<{ status: string; platform: string; channel: string; message_id: string }> {
  const body: Record<string, unknown> = { channel, text };
  if (threadId) body.thread_ts = threadId;

  const resp = await fetchJSON<{ ok: boolean; ts: string; error?: string }>(
    "https://slack.com/api/chat.postMessage",
    { method: "POST", headers: slackAuthHeader(token), body }
  );

  if (!resp.ok) exitWithError("send_failed", `Slack send failed: ${resp.error ?? "unknown error"}`);

  return { status: "sent", platform: "slack", channel, message_id: resp.ts };
}

async function slackSearch(token: string, query: string, channelFilter?: string, fromUser?: string, dateFrom?: string, dateTo?: string, limit = 20): Promise<MessageObject[]> {
  let searchQuery = query;
  if (channelFilter) searchQuery += ` in:${channelFilter.replace("#", "")}`;
  if (fromUser) searchQuery += ` from:${fromUser}`;
  if (dateFrom) searchQuery += ` after:${dateFrom}`;
  if (dateTo) searchQuery += ` before:${dateTo}`;

  const resp = await fetchJSON<{ ok: boolean; messages?: { matches: Array<Record<string, unknown>> }; error?: string }>(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(searchQuery)}&count=${limit}`,
    { headers: slackAuthHeader(token) }
  );

  if (!resp.ok) exitWithError("network_error", `Slack search failed: ${resp.error ?? "unknown"}`);

  return (resp.messages?.matches ?? []).map((m) =>
    normalizeSlackMessage(m, String((m.channel as Record<string, unknown> | undefined)?.name ?? ""))
  );
}

async function slackStatus(token: string, flags: { set?: string; emoji?: string; presence?: string; clear?: boolean }): Promise<Record<string, unknown>> {
  if (flags.set || flags.emoji || flags.clear) {
    const profile: Record<string, unknown> = {};
    if (flags.clear) {
      profile.status_text = "";
      profile.status_emoji = "";
    } else {
      if (flags.set) profile.status_text = flags.set;
      if (flags.emoji) profile.status_emoji = flags.emoji;
    }
    await fetchJSON<{ ok: boolean }>(
      "https://slack.com/api/users.profile.set",
      { method: "POST", headers: slackAuthHeader(token), body: { profile } }
    );
  }

  if (flags.presence) {
    await fetchJSON<{ ok: boolean }>(
      "https://slack.com/api/users.setPresence",
      { method: "POST", headers: slackAuthHeader(token), body: { presence: flags.presence } }
    );
  }

  // Fetch current status
  const profileResp = await fetchJSON<{ ok: boolean; profile: Record<string, unknown> }>(
    "https://slack.com/api/users.profile.get",
    { headers: slackAuthHeader(token) }
  );

  return {
    platform: "slack",
    presence: "auto",
    status_text: String(profileResp.profile?.status_text ?? ""),
    status_emoji: String(profileResp.profile?.status_emoji ?? ""),
    dnd: false,
  };
}

async function slackBriefing(token: string, config: Config["briefing"]): Promise<Record<string, unknown>> {
  // Fetch all channels and their unread counts
  const channelsResp = await fetchJSON<{ ok: boolean; channels: Array<{ id: string; name: string; unread_count?: number }> }>(
    "https://slack.com/api/conversations.list?limit=100&types=public_channel,private_channel&exclude_archived=true",
    { headers: slackAuthHeader(token) }
  );

  const unreadByChannel: Record<string, number> = {};
  let totalUnread = 0;

  for (const ch of channelsResp.channels ?? []) {
    const unread = ch.unread_count ?? 0;
    if (unread > 0) {
      unreadByChannel[`#${ch.name}`] = unread;
      totalUnread += unread;
    }
  }

  // Fetch DMs
  const dmResp = await fetchJSON<{ ok: boolean; channels: Array<{ id: string; unread_count?: number; latest?: { text?: string; user?: string; ts?: string } }> }>(
    "https://slack.com/api/conversations.list?limit=20&types=im",
    { headers: slackAuthHeader(token) }
  );

  const dms: Array<{ from: string; snippet: string; timestamp: string }> = [];
  for (const dm of (dmResp.channels ?? []).slice(0, config.summary_limit)) {
    const unread = dm.unread_count ?? 0;
    if (unread > 0 && dm.latest) {
      const snippet = String(dm.latest.text ?? "").substring(0, 80);
      dms.push({
        from: String(dm.latest.user ?? "unknown"),
        snippet,
        timestamp: dm.latest.ts ? toISO(dm.latest.ts) : "",
      });
    }
  }

  return { unread_count: totalUnread, unread_by_channel: unreadByChannel, mentions: [], dms };
}

// =============================================================================
// SECTION 6: Discord Adapter
// =============================================================================

function discordAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}` };
}

function normalizeDiscordMessage(msg: Record<string, unknown>, channelName: string): MessageObject {
  const author = (msg.author as Record<string, unknown> | undefined) ?? {};
  return {
    id: String(msg.id ?? ""),
    author: {
      name: String(author.global_name ?? author.username ?? "Unknown"),
      username: String(author.username ?? ""),
    },
    content: String(msg.content ?? ""),
    timestamp: String(msg.timestamp ?? ""),
    channel: channelName,
    thread_id: (msg.thread as Record<string, unknown> | undefined)?.id
      ? String((msg.thread as Record<string, unknown>).id)
      : null,
    reply_count: 0,
    reactions: ((msg.reactions as Array<{ emoji: { name: string }; count: number }>) ?? []).map((r) => ({
      emoji: r.emoji?.name ?? "",
      count: r.count,
    })),
    has_attachments: Array.isArray(msg.attachments) && (msg.attachments as unknown[]).length > 0,
    platform: "discord",
  };
}

async function discordList(token: string, channel: string, limit: number, threadId?: string): Promise<MessageObject[]> {
  // channel can be a channel ID or name — Discord API requires channel ID
  // If it looks like a name (not numeric), we need to search guilds
  let channelId = channel;
  let channelName = channel;

  if (!/^\d+$/.test(channel)) {
    // Try to resolve from guild channels
    // Without a guild ID we can't enumerate; advise using channel ID
    exitWithError("channel_not_found", `Discord requires a channel ID (numeric). Got: '${channel}'. Use the channel's ID from Discord.`);
  }

  const endpoint = threadId
    ? `https://discord.com/api/v10/channels/${threadId}/messages?limit=${limit}`
    : `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`;

  const messages = await fetchJSON<Array<Record<string, unknown>>>(
    endpoint,
    { headers: discordAuthHeader(token) }
  );

  return messages.map((m) => normalizeDiscordMessage(m, channelName));
}

async function discordRead(token: string, messageId: string): Promise<MessageObject & { thread_replies?: MessageObject[] }> {
  // messageId format: "channelId:messageId"
  const parts = messageId.split(":");
  if (parts.length < 2) exitWithError("message_not_found", `Invalid Discord message ID format. Expected 'channelId:messageId'. Got: ${messageId}`);

  const [channelId, msgId] = parts;

  const msg = await fetchJSON<Record<string, unknown>>(
    `https://discord.com/api/v10/channels/${channelId}/messages/${msgId}`,
    { headers: discordAuthHeader(token) }
  );

  const normalized = normalizeDiscordMessage(msg, channelId);

  // Check if this message has a thread
  const thread = (msg.thread as Record<string, unknown> | undefined);
  let replies: MessageObject[] = [];
  if (thread?.id) {
    const threadMessages = await fetchJSON<Array<Record<string, unknown>>>(
      `https://discord.com/api/v10/channels/${thread.id}/messages?limit=100`,
      { headers: discordAuthHeader(token) }
    );
    replies = threadMessages.map((m) => normalizeDiscordMessage(m, String(thread.id)));
  }

  return { ...normalized, thread_replies: replies };
}

async function discordSend(token: string, channelId: string, text: string, threadId?: string): Promise<{ status: string; platform: string; channel: string; message_id: string }> {
  const body: Record<string, unknown> = { content: text };
  if (threadId) body.message_reference = { message_id: threadId };

  const resp = await fetchJSON<{ id: string; content: string }>(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { method: "POST", headers: discordAuthHeader(token), body }
  );

  return { status: "sent", platform: "discord", channel: channelId, message_id: String(resp.id) };
}

async function discordSearch(token: string, query: string, channelId?: string, fromUser?: string, limit = 20): Promise<MessageObject[]> {
  // Discord REST API has no full-text search — client-side substring match on fetched messages
  if (!channelId) exitWithError("channel_not_specified", "Discord search requires --channel <channel-id>. Discord's API does not support workspace-wide search.");

  const messages = await fetchJSON<Array<Record<string, unknown>>>(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=${Math.min(limit * 5, 100)}`,
    { headers: discordAuthHeader(token) }
  );

  let normalized = messages.map((m) => normalizeDiscordMessage(m, channelId));

  // Client-side filtering
  const lowerQuery = query.toLowerCase();
  normalized = normalized.filter((m) => m.content.toLowerCase().includes(lowerQuery));
  if (fromUser) normalized = normalized.filter((m) => m.author.username.toLowerCase().includes(fromUser.toLowerCase()));

  return normalized.slice(0, limit);
}

async function discordStatus(token: string, flags: { set?: string; presence?: string; clear?: boolean }): Promise<Record<string, unknown>> {
  // Discord bot tokens cannot set presence or status via REST API — requires Gateway (WebSocket)
  // Deferred to future version (WebSocket/Gateway support)
  return {
    platform: "discord",
    presence: null,
    status_text: null,
    status_emoji: null,
    dnd: null,
    warning: "discord_status_requires_gateway",
    warning_message: "Setting Discord status requires WebSocket Gateway — deferred to future version.",
  };
}

async function discordBriefing(token: string, guildIds: string[]): Promise<Record<string, unknown>> {
  // Discord's REST API has no unread count endpoint — return 0 with a note
  // We can list DMs (DM channels) for the bot user
  const unreadByChannel: Record<string, number> = {};

  return {
    unread_count: 0,
    unread_by_channel: unreadByChannel,
    mentions: [],
    dms: [],
    note: "Discord unread counts require Gateway connection — deferred to future version.",
  };
}

// =============================================================================
// SECTION 7: Unified Dispatch
// =============================================================================

function parseCommonArgs(args: string[]): {
  platform: string | null;
  channel: string | null;
  limit: number | null;
  unreadOnly: boolean | null;
  threadId: string | null;
  remaining: string[];
} {
  let platform: string | null = null;
  let channel: string | null = null;
  let limit: number | null = null;
  let unreadOnly: boolean | null = null;
  let threadId: string | null = null;
  const remaining: string[] = [];

  let i = 0;
  while (i < args.length) {
    if ((args[i] === "slack" || args[i] === "discord") && !platform) {
      platform = args[i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i]);
    } else if (args[i] === "--unread") {
      unreadOnly = true;
    } else if (args[i] === "--no-unread") {
      unreadOnly = false;
    } else if (args[i] === "--thread" && args[i + 1]) {
      threadId = args[++i];
    } else if (args[i] === "--channel" && args[i + 1]) {
      channel = args[++i];
    } else {
      remaining.push(args[i]);
    }
    i++;
  }

  return { platform, channel, limit, unreadOnly, threadId, remaining };
}

async function dispatchList(args: string[]): Promise<void> {
  const config = loadConfig();
  const { platform: platformArg, channel: channelArg, limit, unreadOnly, threadId, remaining } = parseCommonArgs(args);

  const platform = resolvePlatform(platformArg, config);
  const platformConfig = config.platforms[platform as "slack" | "discord"];

  if (!platformConfig.enabled) exitWithError("platform_not_enabled", `Platform '${platform}' is not enabled. Run chat-config --enable ${platform} and provide a token.`);
  if (!platformConfig.token) exitWithError("platform_not_enabled", `Platform '${platform}' has no token configured. Run chat-config --wizard.`);

  const channel = resolveChannel(channelArg ?? remaining[0] ?? null, platform, config);
  const finalLimit = limit ?? config.default_limit;
  const finalUnread = unreadOnly ?? config.default_unread_only;

  if (platform === "slack") {
    const messages = await slackList(platformConfig.token, channel, finalLimit, finalUnread, threadId ?? undefined);
    printJSON(messages);
  } else {
    const messages = await discordList(platformConfig.token, channel, finalLimit, threadId ?? undefined);
    printJSON(messages);
  }
}

async function dispatchRead(args: string[]): Promise<void> {
  const config = loadConfig();
  const { platform: platformArg, remaining } = parseCommonArgs(args);

  const platform = resolvePlatform(platformArg, config);
  const platformConfig = config.platforms[platform as "slack" | "discord"];

  if (!platformConfig.enabled) exitWithError("platform_not_enabled", `Platform '${platform}' is not enabled.`);

  const messageId = remaining[0];
  if (!messageId) exitWithError("message_not_found", "Message ID is required. Usage: chat-read [platform] <message-id>");

  if (platform === "slack") {
    printJSON(await slackRead(platformConfig.token, messageId));
  } else {
    printJSON(await discordRead(platformConfig.token, messageId));
  }
}

async function dispatchSend(args: string[]): Promise<void> {
  const config = loadConfig();
  const { platform: platformArg, channel: channelArgFlag, threadId, remaining } = parseCommonArgs(args);

  const confirmed = args.includes("--confirmed");
  const platform = resolvePlatform(platformArg, config);
  const platformConfig = config.platforms[platform as "slack" | "discord"];

  if (!platformConfig.enabled) exitWithError("platform_not_enabled", `Platform '${platform}' is not enabled.`);

  // Channel: either from --channel flag or first positional remaining arg
  let channelArg = channelArgFlag ?? null;
  let messageArgs = [...remaining];
  if (!channelArg && messageArgs.length > 1) {
    channelArg = messageArgs.shift()!;
  }

  const channel = resolveChannel(channelArg, platform, config);
  const messageText = messageArgs.join(" ");

  if (!messageText) exitWithError("send_failed", "Message text is required. Usage: chat-send [platform] [channel] <message>");

  if (!confirmed) {
    // Draft preview
    printJSON({
      status: "draft",
      platform,
      channel,
      thread_id: threadId ?? null,
      content: messageText,
      send_as: { name: "Dispatch Bot", username: "dispatch" },
    });
    return;
  }

  if (platform === "slack") {
    printJSON(await slackSend(platformConfig.token, channel, messageText, threadId ?? undefined));
  } else {
    printJSON(await discordSend(platformConfig.token, channel, messageText, threadId ?? undefined));
  }
}

async function dispatchSearch(args: string[]): Promise<void> {
  const config = loadConfig();
  const { platform: platformArg, channel: channelArgFlag, limit, remaining } = parseCommonArgs(args);

  let fromUser: string | null = null;
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  let channelArg = channelArgFlag;
  const pureRemaining: string[] = [];

  let i = 0;
  while (i < remaining.length) {
    if (remaining[i] === "--from" && remaining[i + 1]) dateFrom = remaining[++i];
    else if (remaining[i] === "--to" && remaining[i + 1]) dateTo = remaining[++i];
    else if (remaining[i] === "--from-user" && remaining[i + 1]) fromUser = remaining[++i];
    else pureRemaining.push(remaining[i]);
    i++;
  }

  const platform = resolvePlatform(platformArg, config);
  const platformConfig = config.platforms[platform as "slack" | "discord"];

  if (!platformConfig.enabled) exitWithError("platform_not_enabled", `Platform '${platform}' is not enabled.`);

  const query = pureRemaining.join(" ");
  if (!query) exitWithError("network_error", "Search query is required. Usage: chat-search [platform] <query> [--channel <name>]");

  const finalLimit = limit ?? config.default_limit;

  if (platform === "slack") {
    printJSON(await slackSearch(platformConfig.token, query, channelArg ?? undefined, fromUser ?? undefined, dateFrom ?? undefined, dateTo ?? undefined, finalLimit));
  } else {
    printJSON(await discordSearch(platformConfig.token, query, channelArg ?? undefined, fromUser ?? undefined, finalLimit));
  }
}

async function dispatchStatus(args: string[]): Promise<void> {
  const config = loadConfig();
  const { platform: platformArg, remaining } = parseCommonArgs(args);

  const platform = resolvePlatform(platformArg, config);
  const platformConfig = config.platforms[platform as "slack" | "discord"];

  if (!platformConfig.enabled) exitWithError("platform_not_enabled", `Platform '${platform}' is not enabled.`);

  let setStatus: string | undefined;
  let setEmoji: string | undefined;
  let presence: string | undefined;
  let clear = false;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--set" && args[i + 1]) setStatus = args[++i];
    else if (args[i] === "--emoji" && args[i + 1]) setEmoji = args[++i];
    else if (args[i] === "--presence" && args[i + 1]) presence = args[++i];
    else if (args[i] === "--clear") clear = true;
    i++;
  }

  if (platform === "slack") {
    printJSON(await slackStatus(platformConfig.token, { set: setStatus, emoji: setEmoji, presence, clear }));
  } else {
    printJSON(await discordStatus(platformConfig.token, { set: setStatus, presence, clear }));
  }
}

// =============================================================================
// SECTION 8: Briefing
// =============================================================================

async function generateBriefing(): Promise<void> {
  if (!configExists()) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  const config = loadConfig();

  if (!config.briefing.enabled) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  const result: Record<string, unknown> = {};

  if (config.platforms.slack.enabled && config.platforms.slack.token) {
    try {
      result.slack = await Promise.race([
        slackBriefing(config.platforms.slack.token, config.briefing),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500)),
      ]);
    } catch {
      result.warning = result.warning ? `${result.warning},slack_unavailable` : "slack_unavailable";
    }
  }

  if (config.platforms.discord.enabled && config.platforms.discord.token) {
    try {
      result.discord = await Promise.race([
        discordBriefing(config.platforms.discord.token, config.platforms.discord.guilds ?? []),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500)),
      ]);
    } catch {
      result.warning = result.warning ? `${result.warning},discord_unavailable` : "discord_unavailable";
    }
  }

  result.save_directory = config.save_directory;
  printJSON(result);
}

// =============================================================================
// SECTION 9: Config Commands
// =============================================================================

function runConfig(args: string[]): void {
  if (args.includes("--show")) {
    if (!configExists()) exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
    const config = loadConfig();
    // Mask tokens before display
    const display = JSON.parse(JSON.stringify(config)) as Config;
    display.platforms.slack.token = maskToken(config.platforms.slack.token);
    display.platforms.discord.token = maskToken(config.platforms.discord.token);
    printJSON(display);
    return;
  }

  if (args.includes("--reset")) {
    if (!args.includes("--confirm")) {
      exitWithError("not_configured", "--reset requires --confirm to prevent accidental token/config deletion.");
    }
    const { unlinkSync } = require("fs");
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
    printJSON({ status: "reset", message: "Config wiped. Run chat-config --wizard to set up Dispatch." });
    return;
  }

  const getIdx = args.indexOf("--get");
  if (getIdx !== -1 && args[getIdx + 1]) {
    if (!configExists()) exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
    const config = loadConfig();
    const key = args[getIdx + 1];
    const parts = key.split(".");
    let value: unknown = config;
    for (const part of parts) value = (value as Record<string, unknown>)[part];
    // Never surface token values
    if (key.includes("token")) {
      printJSON({ key, value: maskToken(String(value)) });
    } else {
      printJSON({ key, value });
    }
    return;
  }

  const setIdx = args.indexOf("--set");
  if (setIdx !== -1 && args[setIdx + 1] && args[setIdx + 2]) {
    if (!configExists()) exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
    const config = loadConfig();
    const key = args[setIdx + 1];
    const rawValue = args[setIdx + 2];
    const parts = key.split(".");
    let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]] as Record<string, unknown>;
    }
    const lastKey = parts[parts.length - 1];
    const existing = target[lastKey];
    if (typeof existing === "boolean") target[lastKey] = rawValue === "true";
    else if (typeof existing === "number") target[lastKey] = parseFloat(rawValue);
    else target[lastKey] = rawValue;
    saveConfig(config);
    const displayValue = key.includes("token") ? maskToken(rawValue) : target[lastKey];
    printJSON({ status: "updated", key, value: displayValue });
    return;
  }

  const enableIdx = args.indexOf("--enable");
  if (enableIdx !== -1 && args[enableIdx + 1]) {
    if (!configExists()) exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
    const config = loadConfig();
    const platform = args[enableIdx + 1] as "slack" | "discord";
    if (platform !== "slack" && platform !== "discord") exitWithError("platform_not_specified", `Unknown platform: ${platform}`);
    config.platforms[platform].enabled = true;
    saveConfig(config);
    printJSON({ status: "enabled", platform });
    return;
  }

  const disableIdx = args.indexOf("--disable");
  if (disableIdx !== -1 && args[disableIdx + 1]) {
    if (!configExists()) exitWithError("not_configured", "Run chat-config --wizard to set up Dispatch.");
    const config = loadConfig();
    const platform = args[disableIdx + 1] as "slack" | "discord";
    if (platform !== "slack" && platform !== "discord") exitWithError("platform_not_specified", `Unknown platform: ${platform}`);
    config.platforms[platform].enabled = false;
    saveConfig(config);
    printJSON({ status: "disabled", platform });
    return;
  }

  if (args.includes("--wizard")) {
    ensureConfigDir();
    const config = configExists()
      ? (JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config)
      : { ...DEFAULT_CONFIG, platforms: { slack: { ...DEFAULT_CONFIG.platforms.slack }, discord: { ...DEFAULT_CONFIG.platforms.discord } } };
    saveConfig(config);
    printJSON({
      status: "wizard_complete",
      message: "Dispatch configured. Use chat-config --set to adjust individual settings, or chat-config --enable slack/discord to enable platforms.",
      note: "Set tokens with: chat-config --set platforms.slack.token xoxb-... and chat-config --enable slack",
    });
    return;
  }

  exitWithError("not_configured", "Unknown chat-config option. Try --wizard, --show, --get, --set, --enable, --disable, --reset --confirm");
}

// =============================================================================
// SECTION 10: Main
// =============================================================================

const allArgs = process.argv.slice(2);
const subcommand = allArgs[0];
const subArgs = allArgs.slice(1);

(async () => {
  switch (subcommand) {
    case "list":
      await dispatchList(subArgs);
      break;
    case "read":
      await dispatchRead(subArgs);
      break;
    case "send":
      await dispatchSend(subArgs);
      break;
    case "search":
      await dispatchSearch(subArgs);
      break;
    case "status":
      await dispatchStatus(subArgs);
      break;
    case "config":
      runConfig(subArgs);
      break;
    case "briefing":
      await generateBriefing();
      break;
    case "--version":
    case "-v":
      printJSON({ version: VERSION });
      break;
    default:
      process.stderr.write(JSON.stringify({
        error: "unknown_command",
        message: `Unknown subcommand: ${subcommand ?? "(none)"}. Available: list, read, send, search, status, config`,
      }) + "\n");
      process.exit(1);
  }
})();
