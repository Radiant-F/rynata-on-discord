import fs from "node:fs";
import path from "node:path";
import { defaultSettings, type AlertSettings, type Session } from "./types";

interface AlertFile {
  settings: Record<string, AlertSettings>;
  sessions: Record<string, Session>;
}

const dir = path.join(process.cwd(), "data");
const file = path.join(dir, "stream-alerts.json");

function read(): AlertFile {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AlertFile>;
    return { settings: data.settings ?? {}, sessions: data.sessions ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, sessions: {} };
    throw err; // corrupted file: fail loudly instead of overwriting it
  }
}

function write(data: AlertFile) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const allSettings = () => read().settings;

export function getSettings(guildId: string): AlertSettings {
  return { ...defaultSettings(), ...read().settings[guildId] };
}

export function saveSettings(guildId: string, settings: AlertSettings) {
  const data = read();
  data.settings[guildId] = settings;
  write(data);
}

export const getSession = (guildId: string): Session | undefined => read().sessions[guildId];

export function setSession(guildId: string, session: Session) {
  const data = read();
  data.sessions[guildId] = session;
  write(data);
}

export function clearSession(guildId: string) {
  const data = read();
  if (!(guildId in data.sessions)) return;
  delete data.sessions[guildId];
  write(data);
}
