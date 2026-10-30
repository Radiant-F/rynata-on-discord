/** An error whose message is safe and useful to show in Discord. */
export class MusicError extends Error {}

/** Turns yt-dlp's stderr into something a person can act on. */
export function friendlyYtdlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("not a bot") || s.includes("sign in to confirm")) {
    return "YouTube is asking this server to prove it isn't a bot. The fix is a cookies file (see deploy/MUSIC.md).";
  }
  if (s.includes("age-restricted") || s.includes("confirm your age")) {
    return "That video is age-restricted. It needs a cookies file from a logged-in account (see deploy/MUSIC.md).";
  }
  if (s.includes("private video")) return "That video is private.";
  if (s.includes("premieres in") || s.includes("live event will begin")) return "That premiere or live stream hasn't started yet.";
  if (s.includes("video unavailable") || s.includes("not available") || s.includes("has been removed") || s.includes("account associated with this video has been terminated")) {
    return "That video isn't available (removed, private, or blocked in this country).";
  }
  if (s.includes("unsupported url")) return "I can't play that link.";
  if (/failed to resolve|name or service not known|network is unreachable|temporary failure in name resolution|connection refused|timed out/.test(s)) {
    return "I can't reach YouTube from here right now (network problem). Try again in a moment.";
  }
  if (s.includes("429") || s.includes("too many requests")) return "YouTube is rate-limiting me right now. Try again in a few minutes.";
  const last = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
  return last ? `yt-dlp said: ${last.replace(/^ERROR:\s*/i, "").slice(0, 200)}` : "yt-dlp failed for an unknown reason.";
}
