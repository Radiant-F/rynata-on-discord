import type { EmbedConfig } from "../messageBuilder";

export type MentionType = "none" | "everyone" | "here" | "role";

export interface AlertSettings {
  enabled: boolean;
  channelId: string;
  mention: { type: MentionType; roleId: string };
  twitchLogin: string; // "" = not used
  youtubeChannelId: string; // "UC…" id, "" = not used
  youtubeName: string; // display only
  content: string; // supports {placeholders}
  embed: EmbedConfig | null; // supports {placeholders}
  liveThumbnail: boolean; // use the stream's own thumbnail as the embed image
  mainPlatform: "twitch" | "youtube"; // whose title, thumbnail and title link the alert uses when both are live
  youtubeButton: string;
  twitchButton: string;
  graceSeconds: number; // wait this long for the other platform before posting
  endAfterMinutes: number; // a stream "session" ends after this long with nobody live
}

export function defaultSettings(): AlertSettings {
  return {
    enabled: false,
    channelId: "",
    mention: { type: "none", roleId: "" },
    twitchLogin: "",
    youtubeChannelId: "",
    youtubeName: "",
    content: "{mention} **{streamer}** is live on {platforms}! 🔴",
    embed: {
      title: "{title}",
      description: "Come hang out! 💖",
      color: "#9146ff",
      image: "",
      thumbnail: "",
      footer: "Live on {platforms}",
    },
    liveThumbnail: true,
    mainPlatform: "twitch",
    youtubeButton: "Watch on YouTube",
    twitchButton: "Watch on Twitch",
    graceSeconds: 90,
    endAfterMinutes: 15,
  };
}

export interface LiveInfo {
  url: string;
  title: string;
  streamer: string;
  game: string;
  thumbnail: string;
  startedAt: string;
}

export interface LiveSet {
  twitch?: LiveInfo;
  youtube?: LiveInfo;
}

/** One "go live → stream ends" cycle in a server. Saved so restarts don't re-announce. */
export interface Session {
  firstSeenAt: number;
  lastLiveAt: number;
  posted: boolean;
  channelId: string;
  messageId: string;
  info: LiveSet; // what the posted message currently shows
}

export type Probe =
  | { state: "live"; info: LiveInfo }
  | { state: "offline" }
  | { state: "error"; message: string };
