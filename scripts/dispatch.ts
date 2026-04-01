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

  const parent = normalizeSlackMessage(resp.messages[0], channelId);
  const replies = resp.messages.slice(1).map((m) => normalizeSlackMessage(m, channelId));

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
