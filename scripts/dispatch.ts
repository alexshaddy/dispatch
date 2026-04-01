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
