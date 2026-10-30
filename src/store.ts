import fs from "node:fs";
import path from "node:path";
import type { MessageConfig } from "./messageBuilder";

export interface StoredMessage {
  messageId: string;
  guildId: string;
  channelId: string;
  config: MessageConfig;
  createdAt: string;
  updatedAt: string;
}

// Tiny JSON "database". In Docker, mount ./data as a volume so it survives redeploys.
const dir = path.join(process.cwd(), "data");
const file = path.join(dir, "messages.json");

function readAll(): StoredMessage[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredMessage[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err; // corrupted file: fail loudly instead of overwriting it
  }
}

function writeAll(items: StoredMessage[]) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, file);
}

export const listMessages = readAll;

export function getMessage(messageId: string) {
  return readAll().find((m) => m.messageId === messageId);
}

export function saveMessage(item: StoredMessage) {
  const all = readAll().filter((m) => m.messageId !== item.messageId);
  all.push(item);
  writeAll(all);
}

export function removeMessage(messageId: string) {
  writeAll(readAll().filter((m) => m.messageId !== messageId));
}
