import type { WASocket } from "@whiskeysockets/baileys";

let whatsappSocket: WASocket | undefined;

export function setWhatsappSocket(socket: WASocket | undefined): void {
  whatsappSocket = socket;
}

export function getWhatsappSocket(): WASocket | undefined {
  return whatsappSocket;
}

export function jidToE164(jid: string): string {
  if (!jid.endsWith("@s.whatsapp.net")) {
    throw new Error(`jidToE164 called with non-PN JID: ${jid}`);
  }
  const raw = jid.split("@")[0];
  // LID-resolved JIDs can include a device suffix (e.g. "306947899292:0"), strip it.
  const number = raw.split(":")[0];
  return `+${number}`;
}

export function e164ToJid(phoneNumber: string): string {
  const number = phoneNumber.startsWith("+") ? phoneNumber.slice(1) : phoneNumber;
  return `${number}@s.whatsapp.net`;
}

export async function sendWhatsappTextMessage(recipient: string, text: string): Promise<void> {
  const socket = getWhatsappSocket();
  if (socket === undefined) {
    console.warn("[stavrobot] sendWhatsappTextMessage: WhatsApp socket not connected, dropping message.");
    return;
  }
  const jid = e164ToJid(recipient);
  await socket.sendMessage(jid, { text });
}
