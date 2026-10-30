import { ChannelType, type Guild } from "discord.js";
import { client } from "../bot";
import { ConfigError } from "../messageBuilder";
import { allSettings, clearSession, getSession, setSession } from "./alertStore";
import { buildAlert } from "./message";
import { probeTwitch, probeYouTube } from "./platforms";
import type { AlertSettings, LiveSet, Probe, Session } from "./types";

const UNKNOWN_MESSAGE = 10008;

type Probe_ = (key: string, run: () => Promise<Probe>) => Promise<Probe>;

/** What each server's stream looked like at the last check (kept in memory). */
const lastKnown = new Map<string, LiveSet>();
const lastCheck = new Map<string, { at: number; twitch?: Probe; youtube?: Probe; problem: string }>();

function textChannel(guild: Guild, id: string) {
  const channel = guild.channels.cache.get(id);
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

/** Applies a probe result to what we knew. Errors change nothing, so a hiccup never looks like "went offline". */
function merge(previous: LiveSet[keyof LiveSet], probe: Probe | undefined) {
  if (!probe || probe.state === "error") return previous;
  return probe.state === "live" ? probe.info : undefined;
}

async function postAlert(guild: Guild, s: AlertSettings, session: Session, live: LiveSet) {
  const channel = textChannel(guild, s.channelId);
  if (!channel) throw new ConfigError("The alert channel doesn't exist anymore. Pick another one in the panel.");

  const { message, allowedMentions } = buildAlert(s, live);
  const sent = await channel.send({ ...message, allowedMentions });

  session.posted = true;
  session.channelId = channel.id;
  session.messageId = sent.id;
  session.info = { ...live };
  setSession(guild.id, session); // save right away so a crash can't cause a second ping
}

/** A second platform went live (or YouTube got a new video): update the one message, no new ping. */
async function updateAlert(guild: Guild, s: AlertSettings, session: Session, live: LiveSet) {
  const gainedTwitch = live.twitch && session.info.twitch?.url !== live.twitch.url;
  const gainedYoutube = live.youtube && session.info.youtube?.url !== live.youtube.url;
  if (!gainedTwitch && !gainedYoutube) return;

  const merged: LiveSet = {
    twitch: live.twitch ?? session.info.twitch,
    youtube: live.youtube ?? session.info.youtube,
  };

  try {
    const channel = textChannel(guild, session.channelId);
    const message = channel && (await channel.messages.fetch(session.messageId));
    if (message) {
      const { message: payload, allowedMentions } = buildAlert(s, merged);
      await message.edit({ ...payload, allowedMentions });
    }
  } catch (err) {
    // Message was deleted by hand: nothing to update, and we don't re-post
    if ((err as { code?: number }).code !== UNKNOWN_MESSAGE) throw err;
  }
  session.info = merged;
  setSession(guild.id, session);
}

async function processGuild(guild: Guild, s: AlertSettings, probe: Probe_) {
  const [twitch, youtube] = await Promise.all([
    s.twitchLogin ? probe(`t:${s.twitchLogin}`, () => probeTwitch(s.twitchLogin)) : undefined,
    s.youtubeChannelId ? probe(`y:${s.youtubeChannelId}`, () => probeYouTube(s.youtubeChannelId)) : undefined,
  ]);

  const check = { at: Date.now(), twitch, youtube, problem: "" };
  lastCheck.set(guild.id, check);

  try {
    const known = lastKnown.get(guild.id) ?? {};
    const live: LiveSet = { twitch: merge(known.twitch, twitch), youtube: merge(known.youtube, youtube) };
    lastKnown.set(guild.id, live);

    const now = Date.now();
    const anyLive = Boolean(live.twitch || live.youtube);
    let session = getSession(guild.id);

    if (!session) {
      if (!anyLive) return;
      session = { firstSeenAt: now, lastLiveAt: now, posted: false, channelId: "", messageId: "", info: {} };
    }
    if (anyLive) session.lastLiveAt = now;

    if (!session.posted) {
      if (!anyLive) {
        clearSession(guild.id); // it was only a blip, nothing was announced
        return;
      }
      const expected = (s.twitchLogin ? 1 : 0) + (s.youtubeChannelId ? 1 : 0);
      const liveCount = (live.twitch ? 1 : 0) + (live.youtube ? 1 : 0);
      const waited = (now - session.firstSeenAt) / 1000;

      if (liveCount >= expected || waited >= s.graceSeconds) await postAlert(guild, s, session, live);
      else setSession(guild.id, session);
      return;
    }

    await updateAlert(guild, s, session, live);

    if (!anyLive && now - session.lastLiveAt >= s.endAfterMinutes * 60_000) {
      clearSession(guild.id); // stream is over: the next go-live gets a fresh alert
      return;
    }
    setSession(guild.id, session);
  } catch (err) {
    check.problem = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** One round of checks for every server that has alerts on. Exported for tests. */
export async function runOnce() {
  if (!client.isReady()) return;

  // Same channel in two servers? Only ask Twitch/YouTube once per round.
  const probes = new Map<string, Promise<Probe>>();
  const probe: Probe_ = (key, run) => {
    let p = probes.get(key);
    if (!p) probes.set(key, (p = run()));
    return p;
  };

  for (const [guildId, settings] of Object.entries(allSettings())) {
    if (!settings.enabled) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      await processGuild(guild, settings, probe);
    } catch (err) {
      console.error(`[alerts] ${guild.name}:`, err);
    }
  }
}

export function startWatcher() {
  const seconds = Math.max(30, Number(process.env.POLL_SECONDS) || 60);
  const loop = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("[alerts] check failed:", err);
    }
    setTimeout(loop, seconds * 1000);
  };
  setTimeout(loop, 10_000); // give the bot a moment to log in
  console.log(`📡 Stream alerts check every ${seconds}s`);
}

/** Sends a sample alert (never pings) so you can see how it looks without going live. */
export async function sendTestAlert(guild: Guild, s: AlertSettings) {
  const channel = textChannel(guild, s.channelId);
  if (!channel) throw new ConfigError("Pick a channel and save first");

  const startedAt = new Date().toISOString();
  const sample = { title: "Sample stream title", game: "Just Chatting", thumbnail: "", startedAt };
  const live: LiveSet = {
    youtube: {
      ...sample,
      streamer: s.youtubeName || s.twitchLogin || "Streamer",
      url: s.youtubeChannelId ? `https://www.youtube.com/channel/${s.youtubeChannelId}/live` : "https://www.youtube.com",
    },
    twitch: {
      ...sample,
      streamer: s.twitchLogin || s.youtubeName || "Streamer",
      url: s.twitchLogin ? `https://www.twitch.tv/${s.twitchLogin}` : "https://www.twitch.tv",
    },
  };

  const { message, allowedMentions } = buildAlert(s, live, {
    test: true,
    roleName: guild.roles.cache.get(s.mention.roleId)?.name,
  });
  return channel.send({ ...message, allowedMentions });
}

/** Forget the current stream, so the next live check posts a fresh alert. */
export function forgetSession(guildId: string) {
  clearSession(guildId);
  lastKnown.delete(guildId);
}

export function getStatus(guildId: string, s: AlertSettings) {
  const c = lastCheck.get(guildId);
  const describe = (configured: boolean, p?: Probe) => {
    if (!configured) return { state: "off", detail: "" };
    if (!p) return { state: "waiting", detail: "" };
    if (p.state === "live") return { state: "live", detail: p.info.title };
    if (p.state === "offline") return { state: "offline", detail: "" };
    return { state: "error", detail: p.message };
  };

  const session = getSession(guildId);
  return {
    checkedAt: c?.at ?? null,
    problem: c?.problem ?? "",
    twitch: describe(Boolean(s.twitchLogin), c?.twitch),
    youtube: describe(Boolean(s.youtubeChannelId), c?.youtube),
    session: {
      posted: Boolean(session?.posted),
      url: session?.posted ? `https://discord.com/channels/${guildId}/${session.channelId}/${session.messageId}` : "",
    },
  };
}
