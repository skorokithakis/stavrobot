import fs from "fs";
import type { Config } from "./config.js";
import { log } from "./log.js";

export interface Allowlist {
  signal: string[];
  telegram: (number | string)[];
  whatsapp: string[];
  email: string[];
  notes: Record<string, string>;
}

const ALLOWLIST_PATH = process.env.ALLOWLIST_PATH ?? "allowlist.json";

let currentAllowlist: Allowlist = { signal: [], telegram: [], whatsapp: [], email: [], notes: {} };

function validateAllowlist(value: unknown): Allowlist {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("allowlist.json must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.signal) || !obj.signal.every((item) => typeof item === "string")) {
    throw new Error("allowlist.json: 'signal' must be an array of strings");
  }
  if (
    !Array.isArray(obj.telegram) ||
    !obj.telegram.every((item) => typeof item === "number" || item === "*")
  ) {
    throw new Error("allowlist.json: 'telegram' must be an array of numbers");
  }
  // The whatsapp field is optional to avoid breaking existing deployments that
  // don't have it yet. Absent means no WhatsApp numbers are allowed.
  const whatsapp = obj.whatsapp ?? [];
  if (!Array.isArray(whatsapp) || !whatsapp.every((item) => typeof item === "string")) {
    throw new Error("allowlist.json: 'whatsapp' must be an array of strings");
  }
  // The email field is optional for the same backward-compat reason as whatsapp.
  const email = obj.email ?? [];
  if (!Array.isArray(email) || !email.every((item) => typeof item === "string")) {
    throw new Error("allowlist.json: 'email' must be an array of strings");
  }
  // The notes field is optional for the same backward-compat reason as whatsapp.
  const notes = obj.notes ?? {};
  if (typeof notes !== "object" || notes === null || Array.isArray(notes)) {
    throw new Error("allowlist.json: 'notes' must be a plain object");
  }
  const notesObj = notes as Record<string, unknown>;
  if (!Object.values(notesObj).every((value) => typeof value === "string")) {
    throw new Error("allowlist.json: 'notes' values must be strings");
  }
  return {
    signal: obj.signal as string[],
    telegram: obj.telegram as (number | string)[],
    whatsapp: whatsapp as string[],
    email: email as string[],
    notes: notesObj as Record<string, string>,
  };
}

export function loadAllowlist(config: Config): Allowlist {
  if (fs.existsSync(ALLOWLIST_PATH)) {
    const content = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
    currentAllowlist = validateAllowlist(JSON.parse(content) as unknown);
    log.info(`[stavrobot] Loaded allowlist from ${ALLOWLIST_PATH}`);
  } else {
    // Migrate from config.toml if values are present there.
    const migratedSignal = config.signal?.allowedNumbers ?? [];
    const migratedTelegram = config.telegram?.allowedChatIds ?? [];

    if (migratedSignal.length > 0 || migratedTelegram.length > 0) {
      log.warn(
        "[stavrobot] Migrated allowlist from config.toml to allowlist.json. " +
          "You can remove signal.allowedNumbers and telegram.allowedChatIds from config.toml.",
      );
    }

    currentAllowlist = { signal: migratedSignal, telegram: migratedTelegram, whatsapp: [], email: [], notes: {} };
    saveAllowlist(currentAllowlist);
  }

  // Auto-seed owner identities so the owner is always in the allowlist.
  let changed = false;

  if (config.owner.signal !== undefined && !currentAllowlist.signal.includes(config.owner.signal)) {
    currentAllowlist.signal.push(config.owner.signal);
    changed = true;
  }

  if (config.owner.telegram !== undefined) {
    const ownerTelegramId = Number(config.owner.telegram);
    if (!Number.isInteger(ownerTelegramId)) {
      log.warn("[stavrobot] owner.telegram is not a valid integer, skipping allowlist seed:", config.owner.telegram);
    } else if (!currentAllowlist.telegram.includes(ownerTelegramId)) {
      currentAllowlist.telegram.push(ownerTelegramId);
      changed = true;
    }
  }

  if (config.owner.whatsapp !== undefined && !currentAllowlist.whatsapp.includes(config.owner.whatsapp)) {
    currentAllowlist.whatsapp.push(config.owner.whatsapp);
    changed = true;
  }

  if (config.owner.email !== undefined) {
    const ownerEmail = config.owner.email.toLowerCase();
    if (!currentAllowlist.email.includes(ownerEmail)) {
      currentAllowlist.email.push(ownerEmail);
      changed = true;
    }
  }

  if (changed) {
    saveAllowlist(currentAllowlist);
  }

  return currentAllowlist;
}

export function saveAllowlist(allowlist: Allowlist): void {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2));
  currentAllowlist = allowlist;
}

export function getAllowlist(): Allowlist {
  return {
    signal: [...currentAllowlist.signal],
    telegram: [...currentAllowlist.telegram],
    whatsapp: [...currentAllowlist.whatsapp],
    email: [...currentAllowlist.email],
    notes: { ...currentAllowlist.notes },
  };
}

export function matchesEmailEntry(senderEmail: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  // Escape all regex-special characters first, then replace the escaped \* with
  // [^@]* so that wildcards cannot match across the @ boundary. The order is
  // critical: escaping must happen before the replacement, otherwise the [^@]*
  // we insert would itself get escaped.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexSource = escaped.replace(/\\\*/g, "[^@]*");
  const regex = new RegExp(`^${regexSource}$`, "i");
  return regex.test(senderEmail);
}

export function isInAllowlist(service: string, identifier: string): boolean {
  if (service === "signal") {
    if (currentAllowlist.signal.includes("*")) {
      return true;
    }
    return currentAllowlist.signal.includes(identifier);
  }
  if (service === "telegram") {
    if (currentAllowlist.telegram.includes("*")) {
      return true;
    }
    const chatId = Number(identifier);
    if (!Number.isInteger(chatId)) {
      return false;
    }
    return currentAllowlist.telegram.includes(chatId);
  }
  if (service === "whatsapp") {
    if (currentAllowlist.whatsapp.includes("*")) {
      return true;
    }
    return currentAllowlist.whatsapp.includes(identifier);
  }
  if (service === "email") {
    return currentAllowlist.email.some((entry) => matchesEmailEntry(identifier, entry));
  }
  return false;
}

export function getOwnerIdentities(config: Config): { signal: string[]; telegram: number[]; whatsapp: string[]; email: string[] } {
  const signal = config.owner.signal !== undefined ? [config.owner.signal] : [];
  let telegram: number[] = [];
  if (config.owner.telegram !== undefined) {
    const ownerTelegramId = Number(config.owner.telegram);
    if (Number.isInteger(ownerTelegramId)) {
      telegram = [ownerTelegramId];
    }
  }
  const whatsapp = config.owner.whatsapp !== undefined ? [config.owner.whatsapp] : [];
  const email = config.owner.email !== undefined ? [config.owner.email.toLowerCase()] : [];
  return { signal, telegram, whatsapp, email };
}
