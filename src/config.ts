import fs from "fs";
import TOML from "@iarna/toml";
import { log } from "./log.js";

const SYSTEM_PROMPT_PATH = "system-prompt.txt";
const COMPACTION_PROMPT_PATH = "compaction-prompt.txt";
const AGENT_PROMPT_PATH = "agent-prompt.txt";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface CoderConfig {
  model: string;
}

export interface SignalConfig {
  account: string;
  allowedNumbers?: string[];
}

export interface TelegramConfig {
  botToken: string;
  allowedChatIds?: number[];
}

export interface WhatsappConfig {}

export interface OwnerConfig {
  name: string;
  signal?: string;
  telegram?: string;
  whatsapp?: string;
}

export interface Config {
  provider: string;
  model: string;
  apiKey?: string;
  authFile?: string;
  publicHostname: string;
  password?: string;
  baseSystemPrompt: string;
  compactionPrompt: string;
  baseAgentPrompt: string;
  customPrompt?: string;
  coder?: CoderConfig;
  signal?: SignalConfig;
  telegram?: TelegramConfig;
  whatsapp?: WhatsappConfig;
  owner: OwnerConfig;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "config.toml";
  const configContent = fs.readFileSync(configPath, "utf-8");
  const config = TOML.parse(configContent) as unknown as Config;

  log.info(`[stavrobot] Loading base system prompt from ${SYSTEM_PROMPT_PATH}`);
  config.baseSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trimEnd();

  log.info(`[stavrobot] Loading compaction prompt from ${COMPACTION_PROMPT_PATH}`);
  config.compactionPrompt = fs.readFileSync(COMPACTION_PROMPT_PATH, "utf-8").trimEnd();

  log.info(`[stavrobot] Loading agent prompt from ${AGENT_PROMPT_PATH}`);
  config.baseAgentPrompt = fs.readFileSync(AGENT_PROMPT_PATH, "utf-8").trimEnd();

  if (config.apiKey === undefined && config.authFile === undefined) {
    throw new Error("Config must specify either apiKey or authFile.");
  }
  if (config.apiKey !== undefined && config.authFile !== undefined) {
    throw new Error("Config must specify either apiKey or authFile, not both.");
  }
  if (config.publicHostname === undefined) {
    throw new Error("Config must specify publicHostname.");
  }
  if (config.publicHostname.trim() === "") {
    throw new Error("Config publicHostname must not be empty.");
  }
  if (!config.publicHostname.startsWith("http://") && !config.publicHostname.startsWith("https://")) {
    throw new Error("Config publicHostname must start with http:// or https://.");
  }
  if (config.publicHostname.endsWith("/")) {
    throw new Error("Config publicHostname must not end with a trailing slash.");
  }

  if (config.owner === undefined) {
    throw new Error("Config must specify an [owner] section.");
  }
  if (typeof config.owner.name !== "string" || config.owner.name.trim() === "") {
    throw new Error("Config [owner] section must specify a non-empty name.");
  }

  return config;
}

export function loadPostgresConfig(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? "postgres",
    port: process.env.PGPORT !== undefined ? parseInt(process.env.PGPORT, 10) : 5432,
    user: process.env.PGUSER ?? "stavrobot",
    password: process.env.PGPASSWORD ?? "stavrobot",
    database: process.env.PGDATABASE ?? "stavrobot",
  };
}
