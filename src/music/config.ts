const DEFAULT_HOSTS = [
  "youtube.com",
  "youtu.be",
  "music.youtube.com",
  "soundcloud.com",
  "bandcamp.com",
  "open.spotify.com",
  "spotify.link",
];

function int(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Read on every use so changes to the environment (and tests) take effect. */
export function musicConfig() {
  return {
    prefix: (process.env.MUSIC_PREFIX || "ryn").trim().toLowerCase(),
    maxPlaylist: int(process.env.MUSIC_MAX_PLAYLIST, 100, 1, 500),
    mixSize: int(process.env.MUSIC_MIX_SIZE, 20, 1, 100), // YouTube Mixes never end, so only this many are queued
    maxTrackMinutes: int(process.env.MUSIC_MAX_TRACK_MINUTES, 240, 0, 1440), // 0 = no limit
    idleMs: Math.max(0, Number(process.env.MUSIC_IDLE_MINUTES ?? 5)) * 60_000, // 0 = never leave
    aloneMs: Math.max(0, Number(process.env.MUSIC_ALONE_SECONDS ?? 60)) * 1000,
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    cookies: process.env.YTDLP_COOKIES || "",
    autoUpdate: process.env.YTDLP_AUTO_UPDATE !== "0",
    // Links from other sites are refused: yt-dlp would fetch any address it's given (including your home network)
    hosts: [
      ...DEFAULT_HOSTS,
      ...(process.env.MUSIC_EXTRA_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ],
  };
}
