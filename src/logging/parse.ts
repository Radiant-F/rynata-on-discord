import { ConfigError, isRecord, text } from "../messageBuilder";
import { defaultLogSettings, type LogSettings } from "./types";

export function parseLogSettings(raw: unknown): LogSettings {
  const r = isRecord(raw) ? raw : {};
  const e = isRecord(r.events) ? r.events : {};
  const days = Number(r.newAccountDays);
  const ignored = Array.isArray(r.ignoredChannelIds) ? r.ignoredChannelIds : [];
  if (ignored.length > 500) throw new ConfigError("That's too many ignored channels");

  return {
    enabled: r.enabled === true,
    messageChannelId: text(r.messageChannelId, 32, "Message log channel"),
    memberChannelId: text(r.memberChannelId, 32, "Member log channel"),
    events: { delete: e.delete === true, edit: e.edit === true, join: e.join === true, leave: e.leave === true },
    ignoreBots: r.ignoreBots !== false,
    ignoredChannelIds: [...new Set(ignored.map((id) => text(id, 32, "Ignored channel")).filter(Boolean))],
    newAccountDays: Number.isFinite(days) ? Math.min(365, Math.max(0, Math.round(days))) : defaultLogSettings().newAccountDays,
  };
}
