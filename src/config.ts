import fs from "fs";
import TOML from "@iarna/toml";

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

export interface Config {
  provider: string;
  model: string;
  apiKey?: string;
  authFile?: string;
  systemPrompt: string;
  postgres: PostgresConfig;
  tts?: TtsConfig;
  stt?: SttConfig;
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "config.toml";
  const configContent = fs.readFileSync(configPath, "utf-8");
  const config = TOML.parse(configContent) as unknown as Config;

  if (config.apiKey === undefined && config.authFile === undefined) {
    throw new Error("Config must specify either apiKey or authFile.");
  }
  if (config.apiKey !== undefined && config.authFile !== undefined) {
    throw new Error("Config must specify either apiKey or authFile, not both.");
  }

  return config;
}
