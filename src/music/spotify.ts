import type { SpotifyUrlInfoModule } from "spotify-url-info";
import { MusicError } from "./errors";

// Spotify's official API now needs a Premium account for developers, so this reads the public
// "embed" page behind every share link instead (no account or key needed).
const spotifyUrlInfo = require("spotify-url-info") as SpotifyUrlInfoModule;
const spotify = spotifyUrlInfo(fetch);

export interface SpotifyTrack {
  title: string;
  artist: string;
  durationSec: number | null;
}

export interface SpotifyResult {
  title: string;
  playlist: boolean;
  tracks: SpotifyTrack[];
  total: number;
}

const SHORT_LINK_HOSTS = new Set(["spotify.link", "spotify.app.link"]);

interface Entity {
  type?: string;
  name?: string;
  title?: string;
  subtitle?: string;
  artists?: { name?: string }[];
  duration?: number;
  trackList?: Entity[];
}

function toTrack(t: Entity): SpotifyTrack | null {
  const title = (t.title ?? t.name ?? "").trim();
  if (!title) return null;
  const artist = (Array.isArray(t.artists) && t.artists.length ? t.artists.map((a) => a.name).filter(Boolean).join(", ") : (t.subtitle ?? ""))
    .replace(/\u00a0/g, " ")
    .trim();
  return { title, artist, durationSec: typeof t.duration === "number" && t.duration > 0 ? Math.round(t.duration / 1000) : null };
}

export async function resolveSpotify(link: URL, max: number): Promise<SpotifyResult> {
  let url = link.href;
  try {
    // spotify.link is a short link: follow it to the real open.spotify.com address
    if (SHORT_LINK_HOSTS.has(link.hostname)) {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      url = res.url;
    }
    url = url.replace(/\/intl-[a-z-]+\//i, "/"); // open.spotify.com/intl-de/track/… -> /track/…

    const entity = (await spotify.getData(url)) as Entity;
    if (entity.type !== "track" && entity.type !== "album" && entity.type !== "playlist") {
      throw new MusicError("I can play Spotify tracks, albums and playlists. Artist and podcast links aren't supported.");
    }

    const all = (entity.trackList ?? [entity]).map(toTrack).filter((t): t is SpotifyTrack => t !== null);
    if (!all.length) throw new MusicError("That Spotify link doesn't have any songs I can read.");
    return {
      title: entity.name ?? "Spotify",
      playlist: entity.type !== "track",
      tracks: all.slice(0, max),
      total: all.length,
    };
  } catch (err) {
    if (err instanceof MusicError) throw err;
    console.error("[music] spotify lookup failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    throw new MusicError("I couldn't read that Spotify link (it may be private, or Spotify changed something). Try `ryn play <song name>` instead.");
  }
}
