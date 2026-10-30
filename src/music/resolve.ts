import { musicConfig } from "./config";
import { MusicError } from "./errors";
import { resolveSpotify } from "./spotify";
import type { Track } from "./ui";
import { resolveLink, searchYouTube, type RawTrack } from "./ytdlp";

let nextTrackId = 0;

export function makeTrack(
  raw: Omit<RawTrack, "url"> & { url: string | null },
  requestedBy: string,
  source: Track["source"],
  search?: string,
): Track {
  return { id: ++nextTrackId, ...raw, requestedBy, source, search };
}

export interface Request {
  title: string;
  playlist: boolean;
  tracks: Track[];
  read: number; // how many entries were looked at
  total: number; // how many the source really has
  thumbnail: string | null;
  hint?: string;
}

function parseLink(input: string): URL | null {
  const first = (input.trim().split(/\s+/)[0] ?? "").replace(/^<|>$/g, "");
  if (!/^https?:\/\//i.test(first)) return null;
  try {
    return new URL(first);
  } catch {
    return null;
  }
}

const hostAllowed = (url: URL) => {
  const host = url.hostname.toLowerCase();
  return musicConfig().hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
};

const isSpotify = (url: URL) => /(^|\.)spotify\.(com|link)$|(^|\.)spotify\.app\.link$/i.test(url.hostname);

/** Turns what someone typed after "play" into tracks. */
export async function resolveRequest(input: string, requestedBy: string): Promise<Request> {
  const cfg = musicConfig();
  const link = parseLink(input);
  const tooLong = (r: RawTrack) => cfg.maxTrackMinutes > 0 && r.durationSec !== null && r.durationSec > cfg.maxTrackMinutes * 60;

  if (link) {
    if (!hostAllowed(link)) {
      throw new MusicError("I only play links from YouTube, Spotify, SoundCloud and Bandcamp. For anything else, search by name.");
    }

    if (isSpotify(link)) {
      const r = await resolveSpotify(link, cfg.maxPlaylist);
      const tracks = r.tracks.map((t) =>
        makeTrack({ title: t.title, artist: t.artist, durationSec: t.durationSec, thumbnail: null, live: false, url: null }, requestedBy, "spotify", `${t.artist} ${t.title}`.trim()),
      );
      return { title: r.title, playlist: r.playlist, tracks, read: r.tracks.length, total: r.total, thumbnail: null };
    }

    // A YouTube link with "list=" in it is a playlist link, even when it starts with "watch?v=".
    // "list=RD…" is a Mix: an endless, auto-made radio, so only the first few are queued.
    const youtube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(link.hostname);
    const list = youtube ? link.searchParams.get("list") : null;
    const mix = Boolean(list?.startsWith("RD"));
    const index = Number.parseInt(link.searchParams.get("index") ?? "", 10);

    const r = await resolveLink(link.href, {
      max: mix ? cfg.mixSize : cfg.maxPlaylist,
      playlist: Boolean(list),
      start: !mix && index > 1 ? index : undefined, // "watch?v=…&list=…&index=5" means: from the 5th song on
    });
    const source: Track["source"] = youtube ? "youtube" : "other";
    // Inside a playlist, live streams would never end and very long videos hog the queue
    const usable = r.playlist ? r.tracks.filter((t) => !t.live && !tooLong(t)) : r.tracks;
    if (!r.playlist && tooLong(r.tracks[0])) {
      throw new MusicError(`That's longer than the ${cfg.maxTrackMinutes}-minute limit.`);
    }
    if (!usable.length) throw new MusicError("None of the videos in that playlist can be played.");

    return {
      title: r.title,
      playlist: r.playlist,
      tracks: usable.map((t) => makeTrack(t, requestedBy, source)),
      read: r.read,
      total: r.total,
      thumbnail: usable[0].thumbnail,
      hint: !r.playlist
        ? undefined
        : mix
          ? `ℹ️ That's a YouTube Mix (it never ends), so I queued the first ${cfg.mixSize} songs.`
          : list && link.pathname !== "/playlist"
            ? "ℹ️ That link had a playlist in it, so I queued the playlist. For just the one video, send the link without `&list=…`."
            : undefined,
    };
  }

  const results = (await searchYouTube(input, 5)).filter((r) => !tooLong(r));
  if (!results.length) throw new MusicError(`I couldn't find anything for “${input.slice(0, 80)}”.`);
  return { title: results[0].title, playlist: false, tracks: [makeTrack(results[0], requestedBy, "youtube")], read: 1, total: 1, thumbnail: results[0].thumbnail };
}

/** Spotify songs have no audio of their own: find the best matching YouTube video when it's their turn. */
export async function resolvePlayable(track: Track): Promise<string> {
  if (track.url) return track.url;
  const results = await searchYouTube(track.search ?? `${track.artist} ${track.title}`, 5);
  const want = track.durationSec;
  const close = want ? results.find((r) => r.durationSec !== null && Math.abs(r.durationSec - want) <= Math.max(10, want * 0.08)) : undefined;
  const best = close ?? results[0];
  if (!best) throw new MusicError("I couldn't find that song on YouTube.");
  track.thumbnail ??= best.thumbnail;
  return best.url;
}
