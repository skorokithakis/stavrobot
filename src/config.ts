import fs from "fs";
import TOML from "@iarna/toml";

const SYSTEM_PROMPT_PATH = "system-prompt.txt";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface TtsConfig {
  provider: string;
  apiKey: string;
  model: string;
  voice: string;
}

export interface SttConfig {
  provider: string;
  apiKey: string;
  model: string;
}

export interface WebSearchConfig {
  apiKey: string;
  model: string;
}

export interface WebFetchConfig {
  apiKey: string;
  model: string;
}

export interface CoderConfig {
  model: string;
}

export interface TelegramConfig {
  botToken: string;
  allowedChatIds: number[];
}

export interface Config {
  provider: string;
  model: string;
  apiKey?: string;
  authFile?: string;
  publicHostname?: string;
  password?: string;
  baseSystemPrompt: string;
  customPrompt?: string;
  postgres: PostgresConfig;
  tts?: TtsConfig;
  stt?: SttConfig;
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
  coder?: CoderConfig;
  telegram?: TelegramConfig;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "config.toml";
  const configContent = fs.readFileSync(configPath, "utf-8");
  const config = TOML.parse(configContent) as unknown as Config;

  console.log(`[stavrobot] Loading base system prompt from ${SYSTEM_PROMPT_PATH}`);
  config.baseSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trimEnd();

  if (config.apiKey === undefined && config.authFile === undefined) {
    throw new Error("Config must specify either apiKey or authFile.");
  }
  if (config.apiKey !== undefined && config.authFile !== undefined) {
    throw new Error("Config must specify either apiKey or authFile, not both.");
  }
  if (config.authFile !== undefined && config.publicHostname === undefined) {
    throw new Error("Config must specify publicHostname when authFile is set.");
  }
  if (config.publicHostname !== undefined) {
    if (config.publicHostname.trim() === "") {
      throw new Error("Config publicHostname must not be empty.");
    }
    if (!config.publicHostname.startsWith("http://") && !config.publicHostname.startsWith("https://")) {
      throw new Error("Config publicHostname must start with http:// or https://.");
    }
    if (config.publicHostname.endsWith("/")) {
      throw new Error("Config publicHostname must not end with a trailing slash.");
    }
  }

  return config;
}
