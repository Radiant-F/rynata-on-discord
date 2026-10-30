import { ConfigError, isRecord, parseEmbed, text } from "../messageBuilder";
import { defaultSettings, type AlertSettings, type MentionType } from "./types";

const MENTIONS: MentionType[] = ["none", "everyone", "here", "role"];

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function cleanTwitch(input: string): string {
  const fromUrl = input.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)?.[1];
  const login = (fromUrl ?? input).replace(/^@/, "").toLowerCase();
  if (login && !/^[a-z0-9_]{1,25}$/.test(login)) {
    throw new ConfigError("That doesn't look like a Twitch name");
  }
  return login;
}

/** Cleans untrusted request JSON into AlertSettings (no network calls here). */
export function parseSettings(raw: unknown): AlertSettings {
  const r = isRecord(raw) ? raw : {};
  const defaults = defaultSettings();

  const m = isRecord(r.mention) ? r.mention : {};
  const type = MENTIONS.includes(m.type as MentionType) ? (m.type as MentionType) : "none";
  const roleId = type === "role" ? text(m.roleId, 32, "Ping role") : "";
  if (type === "role" && !roleId) throw new ConfigError("Pick a role to ping");

  const content = text(r.content, 2000, "Message");
  const embed = parseEmbed(r.embed);
  if (!content && !embed) throw new ConfigError("Add a message or an embed first");

  return {
    enabled: r.enabled === true,
    channelId: text(r.channelId, 32, "Channel"),
    mention: { type, roleId },
    twitchLogin: cleanTwitch(text(r.twitchLogin, 200, "Twitch name")),
    youtubeChannelId: text(r.youtubeChannelId, 200, "YouTube channel"),
    youtubeName: "",
    content,
    embed,
    liveThumbnail: r.liveThumbnail === true,
    mainPlatform: r.mainPlatform === "youtube" ? "youtube" : "twitch",
    youtubeButton: text(r.youtubeButton, 80, "YouTube button") || defaults.youtubeButton,
    twitchButton: text(r.twitchButton, 80, "Twitch button") || defaults.twitchButton,
    graceSeconds: clampInt(r.graceSeconds, 0, 600, defaults.graceSeconds),
    endAfterMinutes: clampInt(r.endAfterMinutes, 1, 240, defaults.endAfterMinutes),
  };
}
