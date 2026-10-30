import fs from "node:fs";
import path from "node:path";
import { defaultLogSettings, type LogSettings } from "./types";

const dir = path.join(process.cwd(), "data");
const file = path.join(dir, "log-settings.json");

// Kept in memory: the logger asks for these on every single message.
let settings: Record<string, LogSettings> | null = null;

function load(): Record<string, LogSettings> {
  if (settings) return settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, LogSettings>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // corrupted: fail loudly
    settings = {};
  }
  return settings;
}

export function getLogSettings(guildId: string): LogSettings {
  const d = defaultLogSettings();
  const saved = load()[guildId];
  return saved ? { ...d, ...saved, events: { ...d.events, ...saved.events } } : d;
}

export const allLogSettings = () => Object.keys(load());

export function saveLogSettings(guildId: string, s: LogSettings) {
  load()[guildId] = s;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
  fs.renameSync(tmp, file);
}
