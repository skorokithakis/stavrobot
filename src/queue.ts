import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { handlePrompt } from "./agent.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

interface QueueEntry {
  message: string;
  source: string | undefined;
  sender: string | undefined;
  retries: number;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

const queue: QueueEntry[] = [];
let processing = false;

let queueAgent: Agent | undefined;
let queuePool: pg.Pool | undefined;
let queueConfig: Config | undefined;

export function initializeQueue(agent: Agent, pool: pg.Pool, config: Config): void {
  queueAgent = agent;
  queuePool = pool;
  queueConfig = config;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processQueue(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const entry = queue.shift()!;
    try {
      const response = await handlePrompt(queueAgent!, queuePool!, entry.message, queueConfig!, entry.source, entry.sender);
      entry.resolve(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (entry.retries < MAX_RETRIES) {
        const attempt = entry.retries + 1;
        console.log(`[stavrobot] Message failed (attempt ${attempt}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS / 1000}s: ${errorMessage}`);
        await sleep(RETRY_DELAY_MS);
        queue.push({ ...entry, retries: attempt });
      } else {
        console.error(`[stavrobot] Message failed after ${MAX_RETRIES + 1} attempts, giving up: ${errorMessage}`);
        entry.reject(error);
      }
    }
  }
  processing = false;
}

export function enqueueMessage(message: string, source?: string, sender?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    queue.push({ message, source, sender, retries: 0, resolve, reject });
    if (!processing) {
      void processQueue();
    }
  });
}
