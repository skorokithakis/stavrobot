import fs from "fs";
import TOML from "@iarna/toml";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface Config {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  postgres: PostgresConfig;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "config.toml";
  const configContent = fs.readFileSync(configPath, "utf-8");
  return TOML.parse(configContent) as unknown as Config;
}
