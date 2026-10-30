import type { LiveInfo, Probe } from "./types";

/** An expected problem with Twitch/YouTube (bad key, unknown channel, quota…) */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

export const twitchConfigured = () =>
  Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
export const youtubeConfigured = () => Boolean(process.env.YOUTUBE_API_KEY);

const describeError = (err: unknown, who: string) =>
  err instanceof PlatformError
    ? err.message
    : `Couldn't reach ${who} (${err instanceof Error ? err.message : "unknown error"})`;

/* ----------------------------------- Twitch ---------------------------------- */

let appToken: { value: string; expiresAt: number } | null = null;

async function twitchToken(forceNew = false): Promise<string> {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) {
    throw new PlatformError(
      "Twitch isn't set up yet: add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env and restart the bot",
    );
  }
  if (!forceNew && appToken && Date.now() < appToken.expiresAt - 60_000) return appToken.value;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new PlatformError(
      `Twitch refused the credentials (HTTP ${res.status}). Double-check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET`,
      res.status,
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return appToken.value;
}

async function helix<T>(query: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.twitch.tv/helix${query}`, {
      headers: {
        Authorization: `Bearer ${await twitchToken(attempt > 0)}`,
        "Client-Id": process.env.TWITCH_CLIENT_ID ?? "",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 0) continue; // token expired or revoked: get a fresh one
    if (!res.ok) throw new PlatformError(`Twitch API error (HTTP ${res.status})`, res.status);
    return (await res.json()) as T;
  }
  throw new PlatformError("Twitch API error (HTTP 401)", 401);
}

interface TwitchStream {
  user_login: string;
  user_name: string;
  game_name: string;
  type: string;
  title: string;
  started_at: string;
  thumbnail_url: string;
}

export async function probeTwitch(login: string): Promise<Probe> {
  try {
    const { data } = await helix<{ data: TwitchStream[] }>(`/streams?user_login=${encodeURIComponent(login)}`);
    const stream = data.find((s) => s.type === "live");
    if (!stream) return { state: "offline" };

    const info: LiveInfo = {
      url: `https://www.twitch.tv/${stream.user_login}`,
      title: stream.title,
      streamer: stream.user_name,
      game: stream.game_name,
      thumbnail: stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720"),
      startedAt: stream.started_at,
    };
    return { state: "live", info };
  } catch (err) {
    return { state: "error", message: describeError(err, "Twitch") };
  }
}

/** Throws a PlatformError if the Twitch name doesn't exist (or the credentials are bad). */
export async function checkTwitchUser(login: string): Promise<void> {
  const { data } = await helix<{ data: unknown[] }>(`/users?login=${encodeURIComponent(login)}`);
  if (!data.length) throw new PlatformError(`I couldn't find a Twitch user called "${login}"`);
}

/* ----------------------------------- YouTube --------------------------------- */

async function yt<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new PlatformError("YouTube isn't set up yet: add YOUTUBE_API_KEY to .env and restart the bot");
  }
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key })}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    } | null;
    const reason = body?.error?.errors?.[0]?.reason;
    throw new PlatformError(
      `YouTube API error (HTTP ${res.status}${reason ? `, ${reason}` : ""}) ${body?.error?.message ?? ""}`.trim(),
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** Accepts a channel ID (UC…), a channel URL, or an @handle. */
export async function resolveYouTubeChannel(input: string): Promise<{ id: string; title: string }> {
  const value = input.trim();
  const id = value.match(/youtube\.com\/channel\/(UC[\w-]{22})/i)?.[1] ?? (/^UC[\w-]{22}$/.test(value) ? value : undefined);
  const handle = value.match(/youtube\.com\/(@[\w.-]+)/i)?.[1] ?? (value.startsWith("@") ? value : undefined);

  const params: Record<string, string> | null = id
    ? { part: "snippet", id }
    : handle
      ? { part: "snippet", forHandle: handle }
      : null;
  if (!params) {
    throw new PlatformError("I couldn't read that YouTube channel. Use the @handle, the channel URL, or the UC… channel ID");
  }

  const res = await yt<{ items?: { id: string; snippet: { title: string } }[] }>("channels", params);
  const channel = res.items?.[0];
  if (!channel) throw new PlatformError("YouTube couldn't find that channel");
  return { id: channel.id, title: channel.snippet.title };
}

/**
 * Newest videos of a channel, via its "Live" playlist (UULV…), falling back to the
 * uploads playlist (UU…). Costs 1 quota unit, unlike search.list.
 */
// Channels with no "Live" tab answer 404 for UULV…; remember that for an hour to save quota
const noLiveTab = new Map<string, number>();

async function recentVideoIds(channelId: string): Promise<string[]> {
  const suffix = channelId.slice(2);
  const playlists = (noLiveTab.get(channelId) ?? 0) > Date.now() ? [`UU${suffix}`] : [`UULV${suffix}`, `UU${suffix}`];

  for (const playlistId of playlists) {
    try {
      const res = await yt<{ items?: { contentDetails: { videoId: string } }[] }>("playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: "10",
      });
      return (res.items ?? []).map((item) => item.contentDetails.videoId);
    } catch (err) {
      if (!(err instanceof PlatformError && err.status === 404)) throw err;
      if (playlistId.startsWith("UULV")) noLiveTab.set(channelId, Date.now() + 60 * 60_000);
    }
  }
  return [];
}

interface YouTubeVideo {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
    liveBroadcastContent: string;
    thumbnails?: Record<string, { url: string }>;
  };
  liveStreamingDetails?: { actualStartTime?: string };
}

export async function probeYouTube(channelId: string): Promise<Probe> {
  try {
    const ids = await recentVideoIds(channelId);
    if (!ids.length) return { state: "offline" };

    const res = await yt<{ items?: YouTubeVideo[] }>("videos", {
      part: "snippet,liveStreamingDetails",
      id: ids.join(","),
    });
    const video = (res.items ?? []).find((v) => v.snippet.liveBroadcastContent === "live");
    if (!video) return { state: "offline" };

    const t = video.snippet.thumbnails ?? {};
    const info: LiveInfo = {
      url: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.snippet.title,
      streamer: video.snippet.channelTitle,
      game: "",
      thumbnail: (t.maxres ?? t.standard ?? t.high ?? t.medium ?? t.default)?.url ?? "",
      startedAt: video.liveStreamingDetails?.actualStartTime ?? "",
    };
    return { state: "live", info };
  } catch (err) {
    return { state: "error", message: describeError(err, "YouTube") };
  }
}
