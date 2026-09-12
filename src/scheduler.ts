import fs from "fs";
import path from "path";
import pg from "pg";
import { CronExpressionParser } from "cron-parser";
import { listCronEntries, deleteCronEntry } from "./database.js";
import { enqueueMessage } from "./queue.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";

interface ScheduledEntry {
  id: number;
  note: string;
  nextFireAt: Date;
  cronExpression: string | null;
}

let scheduledEntries: ScheduledEntry[] = [];
let schedulerPool: pg.Pool | undefined;

function computeNextFireAt(cronExpression: string): Date {
  const interval = CronExpressionParser.parse(cronExpression);
  return interval.next().toDate();
}

async function loadEntries(pool: pg.Pool): Promise<void> {
  const entries = await listCronEntries(pool);
  scheduledEntries = entries.map((entry) => {
    if (entry.cronExpression !== null) {
      return {
        id: entry.id,
        note: entry.note,
        nextFireAt: computeNextFireAt(entry.cronExpression),
        cronExpression: entry.cronExpression,
      };
    } else {
      return {
        id: entry.id,
        note: entry.note,
        nextFireAt: entry.fireAt!,
        cronExpression: null,
      };
    }
  });
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

async function cleanupOldUploads(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(TEMP_ATTACHMENTS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("upload-")) {
      continue;
    }
    const filePath = path.join(TEMP_ATTACHMENTS_DIR, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > THREE_DAYS_MS) {
        await fs.promises.unlink(filePath);
        log.info("[stavrobot] Deleted old upload:", filePath);
      }
    } catch (error) {
      log.error("[stavrobot] Error processing upload file during cleanup:", filePath, error);
    }
  }
}

function tick(): void {
  const now = new Date();

  const toFire = scheduledEntries.filter((entry) => entry.nextFireAt <= now);

  if (toFire.length > 0) {
    log.info(`[stavrobot] Cron tick: firing ${toFire.length} entries (ids: ${toFire.map((e) => e.id).join(", ")})`);
  }

  // Update in-memory state synchronously before any async work.
  for (const entry of toFire) {
    if (entry.cronExpression !== null) {
      entry.nextFireAt = computeNextFireAt(entry.cronExpression);
    } else {
      // Remove from in-memory list immediately so the next tick won't
      // re-fire it, even if the DB deletion hasn't completed yet.
      scheduledEntries = scheduledEntries.filter((e) => e.id !== entry.id);
      void deleteCronEntry(schedulerPool!, entry.id);
    }
  }

  for (const entry of toFire) {
    const framedNote = `[Cron entry ${entry.id} has fired] ${entry.note}`;
    void enqueueMessage(framedNote, "cron");
  }

  void cleanupOldUploads();
}

export async function initializeScheduler(pool: pg.Pool): Promise<void> {
  schedulerPool = pool;
  await loadEntries(pool);
  setInterval(tick, 60_000);
  log.info(`[stavrobot] Scheduler initialized with ${scheduledEntries.length} entries.`);
}

export async function reloadScheduler(pool: pg.Pool): Promise<void> {
  await loadEntries(pool);
  log.info(`[stavrobot] Scheduler reloaded with ${scheduledEntries.length} entries.`);
}
