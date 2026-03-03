import qrcodeTerminal from "qrcode-terminal";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import type { WhatsappConfig } from "./config.js";
import { isInAllowlist } from "./allowlist.js";
import { enqueueMessage } from "./queue.js";
import { saveAttachment, type FileAttachment } from "./uploads.js";
import { setWhatsappSocket, getWhatsappSocket, jidToE164, e164ToJid } from "./whatsapp-api.js";
import { log } from "./log.js";

// libsignal (used internally by Baileys) has hardcoded console.info and console.warn
// calls in session_record.js and session_builder.js that bypass the pino-compatible
// silent logger we pass to Baileys. These dump session objects (including crypto state)
// on every session open/close. We intercept console.info and console.warn here and
// drop the known noisy messages. console.error is intentionally left untouched because
// libsignal's error logs are operationally useful.
const LIBSIGNAL_SUPPRESSED_PREFIXES: readonly string[] = [
  "Closing session",
  "Opening session",
  "Removing old closed session",
  "Migrating session to",
  "Session already closed",
  "Session already open",
  "Closing open session in favor of incoming prekey bundle",
];

function isLibsignalMessage(args: unknown[]): boolean {
  return (
    args.length > 0 &&
    typeof args[0] === "string" &&
    LIBSIGNAL_SUPPRESSED_PREFIXES.some((prefix) => (args[0] as string).startsWith(prefix))
  );
}

const originalConsoleInfo = console.info.bind(console);
console.info = (...args: unknown[]): void => {
  if (!isLibsignalMessage(args)) {
    originalConsoleInfo(...args);
  }
};

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  if (!isLibsignalMessage(args)) {
    originalConsoleWarn(...args);
  }
};

interface SilentLogger {
  level: string;
  child(obj: Record<string, unknown>): SilentLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

// A minimal pino-compatible logger that only passes through warnings and errors.
// Baileys' default logger is very verbose at debug/info level.
const silentLogger: SilentLogger = {
  level: "warn",
  child(_obj: Record<string, unknown>): SilentLogger {
    return silentLogger;
  },
  trace(_obj: unknown, _msg?: string): void {},
  debug(_obj: unknown, _msg?: string): void {},
  info(_obj: unknown, _msg?: string): void {},
  warn(obj: unknown, msg?: string): void {
    log.warn("[stavrobot] [whatsapp] warn:", msg ?? obj);
  },
  error(obj: unknown, msg?: string): void {
    log.error("[stavrobot] [whatsapp] error:", msg ?? obj);
  },
};

const MAX_RECONNECT_ATTEMPTS = 10;
// Tracks consecutive failed connection attempts. Reset to 0 on successful open.
let reconnectAttempt = 0;

export async function initializeWhatsApp(config: WhatsappConfig): Promise<void> {
  const authDir = process.env.WHATSAPP_AUTH_DIR ?? "data/whatsapp";

  log.info("[stavrobot] Initializing WhatsApp connection, auth dir:", authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Workaround for Baileys 7.0.0-rc.9 hardcoding an outdated WA protocol version
  // that WhatsApp rejects with a 405. Remove this once Baileys ships a fix
  // (see https://github.com/WhiskeySockets/Baileys/issues/2376).
  const socket = makeWASocket({
    auth: state,
    logger: silentLogger,
    // Disable link previews to avoid the link-preview-js peer dependency.
    generateHighQualityLinkPreview: false,
    version: [2, 3000, 1034074495],
  });

  setWhatsappSocket(socket);

  socket.ev.on("creds.update", () => {
    void saveCreds();
  });

  socket.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr !== undefined) {
      log.info("[stavrobot] Scan this QR code with WhatsApp to link this device:");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "open") {
      log.info("[stavrobot] WhatsApp connection established.");
      reconnectAttempt = 0;
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        log.error("[stavrobot] WhatsApp logged out (401). Remove the auth directory and restart to re-link.");
        setWhatsappSocket(undefined);
        return;
      }

      if (statusCode === 405) {
        log.error("[stavrobot] WhatsApp rejected the connection with 405. The protocol version may be outdated.");
      }

      reconnectAttempt++;
      if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
        log.error(
          `[stavrobot] WhatsApp reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Giving up.`,
        );
        setWhatsappSocket(undefined);
        return;
      }

      const delayMs = Math.min(2 ** (reconnectAttempt - 1) * 1000, 60000);
      log.info(
        `[stavrobot] WhatsApp connection closed (status: ${statusCode}), reconnecting in ${delayMs}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}).`,
      );
      // Reconnect by re-initializing. Baileys does not auto-reconnect internally
      // for all disconnect reasons, so we do it ourselves.
      setTimeout(() => {
        void initializeWhatsApp(config);
      }, delayMs);
    }
  });

  socket.ev.on("messages.upsert", ({ messages, type }) => {
    log.debug(`[stavrobot] WhatsApp messages.upsert: type=${type}, count=${messages.length}`);
    // Only process new incoming messages, not history syncs.
    if (type !== "notify") {
      return;
    }

    for (const message of messages) {
      void processInboundMessage(message);
    }
  });
}

async function processInboundMessage(waMessage: WAMessage): Promise<void> {
  const remoteJid = waMessage.key.remoteJid;
  log.debug(`[stavrobot] WhatsApp processInboundMessage: fromMe=${waMessage.key.fromMe}, jid=${remoteJid}, hasMessage=${waMessage.message !== undefined && waMessage.message !== null}`);

  if (waMessage.key.fromMe === true) {
    return;
  }

  if (remoteJid === undefined || remoteJid === null) {
    return;
  }

  // Ignore group messages and status/broadcast messages.
  if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
    log.debug("[stavrobot] WhatsApp ignoring group/broadcast message from:", remoteJid);
    return;
  }

  let effectiveJid = remoteJid;
  if (remoteJid.endsWith("@lid")) {
    const socket = getWhatsappSocket();
    if (socket === undefined) {
      log.debug("[stavrobot] WhatsApp could not resolve LID JID, dropping:", remoteJid);
      return;
    }
    const resolvedJid = await socket.signalRepository.lidMapping.getPNForLID(remoteJid);
    if (resolvedJid === null) {
      log.debug("[stavrobot] WhatsApp could not resolve LID JID, dropping:", remoteJid);
      return;
    }
    log.debug("[stavrobot] WhatsApp resolved LID to PN:", remoteJid, "->", resolvedJid);
    effectiveJid = resolvedJid;
  }

  if (!effectiveJid.endsWith("@s.whatsapp.net")) {
    log.debug("[stavrobot] WhatsApp ignoring non-individual JID:", effectiveJid);
    return;
  }

  const phoneNumber = jidToE164(effectiveJid);

  if (!isInAllowlist("whatsapp", phoneNumber)) {
    log.info("[stavrobot] WhatsApp message from disallowed number:", phoneNumber);
    return;
  }

  const messageContent = waMessage.message;
  if (messageContent === undefined || messageContent === null) {
    log.debug("[stavrobot] WhatsApp message has no content, ignoring. From:", phoneNumber);
    return;
  }

  // Text message.
  const text = messageContent.conversation ?? messageContent.extendedTextMessage?.text;
  if (text !== undefined && text !== null) {
    log.debug("[stavrobot] WhatsApp text message from:", phoneNumber);
    void enqueueMessage(text, "whatsapp", phoneNumber);
    return;
  }

  // Image message.
  if (messageContent.imageMessage !== undefined && messageContent.imageMessage !== null) {
    const caption = messageContent.imageMessage.caption ?? undefined;
    const mimeType = messageContent.imageMessage.mimetype ?? "image/jpeg";
    log.debug("[stavrobot] WhatsApp image message from:", phoneNumber);
    void downloadMediaMessage(waMessage, "buffer", {}).then(async (buffer) => {
      const filename = `whatsapp-image-${Date.now()}.jpg`;
      const { storedPath } = await saveAttachment(buffer as Buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: (buffer as Buffer).length,
      };
      void enqueueMessage(caption, "whatsapp", phoneNumber, [attachment]);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading WhatsApp image:", error);
    });
    return;
  }

  // Audio / voice note message.
  if (messageContent.audioMessage !== undefined && messageContent.audioMessage !== null) {
    // WhatsApp voice notes are OGG Opus; regular audio may have a different mime type.
    // Strip MIME parameters (e.g. "audio/ogg; codecs=opus") to get a clean extension.
    const rawMimeType = messageContent.audioMessage.mimetype ?? "audio/ogg; codecs=opus";
    const mimeType = rawMimeType.split(";")[0].trim();
    const extension = mimeType.split("/")[1] ?? "ogg";
    log.debug("[stavrobot] WhatsApp audio message from:", phoneNumber, "mimeType:", mimeType);
    void downloadMediaMessage(waMessage, "buffer", {}).then(async (buffer) => {
      const filename = `voice-note-${Date.now()}.${extension}`;
      const { storedPath } = await saveAttachment(buffer as Buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: (buffer as Buffer).length,
      };
      void enqueueMessage(undefined, "whatsapp", phoneNumber, [attachment]);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading WhatsApp audio:", error);
    });
    return;
  }

  // Document message.
  if (messageContent.documentMessage !== undefined && messageContent.documentMessage !== null) {
    const caption = messageContent.documentMessage.caption ?? undefined;
    const mimeType = messageContent.documentMessage.mimetype ?? "application/octet-stream";
    const filename = messageContent.documentMessage.fileName ?? `whatsapp-document-${Date.now()}`;
    log.debug("[stavrobot] WhatsApp document message from:", phoneNumber, "filename:", filename);
    void downloadMediaMessage(waMessage, "buffer", {}).then(async (buffer) => {
      const { storedPath } = await saveAttachment(buffer as Buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: (buffer as Buffer).length,
      };
      void enqueueMessage(caption, "whatsapp", phoneNumber, [attachment]);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading WhatsApp document:", error);
    });
    return;
  }

  // Video message.
  if (messageContent.videoMessage !== undefined && messageContent.videoMessage !== null) {
    const caption = messageContent.videoMessage.caption ?? undefined;
    const mimeType = messageContent.videoMessage.mimetype ?? "video/mp4";
    log.debug("[stavrobot] WhatsApp video message from:", phoneNumber);
    void downloadMediaMessage(waMessage, "buffer", {}).then(async (buffer) => {
      const filename = `whatsapp-video-${Date.now()}.mp4`;
      const { storedPath } = await saveAttachment(buffer as Buffer, filename, mimeType);
      const attachment: FileAttachment = {
        storedPath,
        originalFilename: filename,
        mimeType,
        size: (buffer as Buffer).length,
      };
      void enqueueMessage(caption, "whatsapp", phoneNumber, [attachment]);
    }).catch((error: unknown) => {
      log.error("[stavrobot] Error downloading WhatsApp video:", error);
    });
    return;
  }

  log.debug("[stavrobot] WhatsApp message has no supported content type, ignoring. From:", phoneNumber);
}
