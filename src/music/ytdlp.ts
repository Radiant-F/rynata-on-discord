import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Transform, type Readable } from "node:stream";
import { musicConfig } from "./config";
import { friendlyYtdlpError, MusicError } from "./errors";

export interface RawTrack {
  url: string;
  title: string;
  artist: string;
  durationSec: number | null;
  thumbnail: string | null;
  live: boolean;
}

/** Options every yt-dlp call gets. */
function baseArgs(): string[] {
  const c = musicConfig();
  const args = [
    "--ignore-config",
    "--no-warnings",
    // YouTube needs a JavaScript runtime to solve its challenges; yt-dlp only turns on "deno" by itself
    "--js-runtimes",
    `node:${process.execPath}`,
    "--socket-timeout",
    "20",
    "--retries",
    "3",
  ];
  if (c.cookies && fs.existsSync(c.cookies)) args.push("--cookies", c.cookies);
  return args;
}

/** Runs at most a few yt-dlp lookups at once, so a big playlist can't flatten an old laptop. */
class Limiter {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed to us
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const lookups = new Limiter(3);

/** A paused pipe with unread data never closes, so after killing a process, read and discard what's left. */
function drain(proc: ChildProcess) {
  proc.stdout?.unpipe();
  proc.stdout?.resume();
}

function terminate(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM"); // the yt-dlp binary passes this on to its worker process, SIGKILL wouldn't be
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }, 3000).unref();
}

function runLookup(args: string[], timeoutMs = 60_000): Promise<string> {
  return lookups.run(
    () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(musicConfig().ytdlp, [...baseArgs(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        proc.stdout.setEncoding("utf8").on("data", (d: string) => {
          out += d;
          if (out.length > 64_000_000) terminate(proc);
        });
        proc.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-4000)));

        const timer = setTimeout(() => {
          terminate(proc);
          reject(new MusicError("YouTube took too long to answer. Try again."));
        }, timeoutMs);

        proc.on("error", (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(new MusicError(e.code === "ENOENT" ? "yt-dlp isn't installed on the server." : `Couldn't start yt-dlp: ${e.message}`));
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new MusicError(friendlyYtdlpError(err)));
        });
      }),
  );
}

/* ----------------------------------- parsing ---------------------------------- */

interface YtEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  ie_key?: string;
  title?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  artist?: string;
  creator?: string;
  thumbnail?: string;
  thumbnails?: { url: string }[];
  live_status?: string;
  is_live?: boolean;
  playlist_count?: number;
  _type?: string;
  entries?: (YtEntry | null)[];
}

function toRaw(e: YtEntry | null): RawTrack | null {
  if (!e) return null;
  const url =
    (e.webpage_url && /^https?:\/\//.test(e.webpage_url) ? e.webpage_url : undefined) ??
    (e.url && /^https?:\/\//.test(e.url) ? e.url : undefined) ??
    (e.id && (e.ie_key ?? "").toLowerCase() === "youtube" ? `https://www.youtube.com/watch?v=${e.id}` : undefined);
  const title = e.title?.trim();
  if (!url || !title || /^\[(private|deleted) video\]$/i.test(title)) return null;

  return {
    url,
    title,
    artist: (e.artist ?? e.creator ?? e.uploader ?? e.channel ?? "").replace(/ - Topic$/, ""),
    durationSec: typeof e.duration === "number" && e.duration > 0 ? Math.round(e.duration) : null,
    thumbnail: e.thumbnail ?? e.thumbnails?.at(-1)?.url ?? null,
    live: e.is_live === true || e.live_status === "is_live",
  };
}

/* ----------------------------------- lookups ---------------------------------- */

function parseJson(out: string): YtEntry {
  let data: YtEntry | null;
  try {
    data = JSON.parse(out) as YtEntry | null;
  } catch {
    throw new MusicError("yt-dlp gave an answer I couldn't read.");
  }
  if (!data) throw new MusicError("I couldn't find anything playable at that link.");
  return data;
}

export interface Resolved {
  title: string;
  playlist: boolean;
  tracks: RawTrack[];
  read: number; // how many entries we looked at (the first `max`)
  total: number; // how many the playlist really has
}

export interface LinkOptions {
  max: number; // how many playlist entries to read
  playlist: boolean; // true: a video link that also names a playlist should give the playlist
  start?: number; // first playlist entry to read (1 = the beginning)
}

/** One link: a single video, or a playlist (read as a flat list, so it's fast). */
export async function resolveLink(url: string, opts: LinkOptions): Promise<Resolved> {
  const start = opts.start && opts.start > 1 ? opts.start : 1;
  const out = await runLookup([
    "-J",
    "--flat-playlist",
    ...(opts.playlist ? [] : ["--no-playlist"]),
    ...(start > 1 ? ["--playlist-start", String(start)] : []),
    "--playlist-end",
    String(start - 1 + opts.max),
    "--",
    url,
  ]);
  const data = parseJson(out);

  if (data._type === "playlist" && data.entries) {
    const tracks = data.entries.map(toRaw).filter((t): t is RawTrack => t !== null);
    if (!tracks.length) throw new MusicError("That playlist is empty or private.");
    return { title: data.title ?? "Playlist", playlist: true, tracks, read: data.entries.length, total: data.playlist_count ?? data.entries.length };
  }

  const track = toRaw(data);
  if (!track) throw new MusicError("I couldn't find anything playable at that link.");
  return { title: track.title, playlist: false, tracks: [track], read: 1, total: 1 };
}

export async function searchYouTube(query: string, count: number): Promise<RawTrack[]> {
  const clean = query.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  const out = await runLookup(["-J", "--flat-playlist", `ytsearch${count}:${clean}`]);
  const data = parseJson(out);
  return (data.entries ?? []).map(toRaw).filter((t): t is RawTrack => t !== null && !t.live);
}

/* ------------------------------------ audio ----------------------------------- */

export interface StreamResult {
  bytes: number;
  killed: boolean;
  error: string;
}

export interface AudioStream {
  /** Ogg/Opus audio, ready for the voice connection. */
  stream: Readable;
  stop(): void;
  done: Promise<StreamResult>;
  /** true once real audio is flowing; false if the stream ended or failed before that. */
  ready: Promise<boolean>;
}

const READY_BYTES = 4000; // a fraction of a second of audio: more than just file headers

/**
 * yt-dlp downloads the audio and pipes it into ffmpeg, which turns it into Opus.
 * Discord can use that as-is, so Node doesn't have to encode anything.
 */
export function openAudioStream(url: string): AudioStream {
  const c = musicConfig();
  const yt = spawn(c.ytdlp, [...baseArgs(), "--quiet", "--no-playlist", "-f", "bestaudio/best", "-o", "-", "--", url], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ff = spawn(
    c.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-f", "ogg", "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let bytes = 0;
  let killed = false;
  let ytErr = "";
  let ffErr = "";
  let ytCode: number | null = null;

  let markReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => (markReady = resolve));

  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes >= READY_BYTES) markReady(true);
      cb(null, chunk);
    },
  });

  yt.stdout.pipe(ff.stdin);
  ff.stdin.on("error", () => {}); // ffmpeg closing early is normal (skip, stop)
  yt.stdout.on("error", () => {});
  ff.stdout.pipe(stream);
  yt.stderr.setEncoding("utf8").on("data", (d: string) => (ytErr = (ytErr + d).slice(-4000)));
  ff.stderr.setEncoding("utf8").on("data", (d: string) => (ffErr = (ffErr + d).slice(-2000)));

  const done = new Promise<StreamResult>((resolve) => {
    let open = 2;
    const closed = new Set<ChildProcess>();
    const finish = (proc: ChildProcess) => {
      if (closed.has(proc)) return;
      closed.add(proc);
      if (--open > 0) return;
      markReady(false); // no-op if audio already flowed
      const failed = ytCode !== 0 && !killed;
      resolve({ bytes, killed, error: failed ? (ytErr ? friendlyYtdlpError(ytErr) : ffErr.trim().slice(-200)) : "" });
    };

    yt.on("error", (e: NodeJS.ErrnoException) => {
      ytErr += e.code === "ENOENT" ? "yt-dlp isn't installed on the server." : e.message;
      ytCode = 1;
      ff.stdin.end();
      finish(yt);
    });
    ff.on("error", (e: NodeJS.ErrnoException) => {
      ffErr += e.code === "ENOENT" ? "ffmpeg isn't installed on the server." : e.message;
      terminate(yt);
      stream.end();
      finish(ff);
    });
    yt.on("close", (code) => {
      ytCode = code;
      finish(yt);
    });
    ff.on("close", () => {
      terminate(yt);
      drain(yt);
      finish(ff);
    });
  });

  return {
    stream,
    done,
    ready,
    stop() {
      killed = true;
      terminate(yt);
      terminate(ff);
      drain(yt);
      drain(ff);
      stream.destroy();
    },
  };
}

/* ------------------------------------ upkeep ---------------------------------- */

function runOnce(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(musicConfig().ytdlp, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(out.trim()));
  });
}

export async function ytdlpVersion(): Promise<string> {
  return (await runOnce(["--version"])).split("\n").pop() ?? "";
}

/** YouTube changes often and yt-dlp follows; this keeps it current. */
export async function updateYtDlp(): Promise<string> {
  return (await runOnce(["-U"])).split("\n").filter(Boolean).slice(-2).join(" ");
}

export async function ffmpegVersion(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(musicConfig().ffmpeg, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve((out.split("\n")[0] ?? "").replace(/^ffmpeg version\s+/, "").split(" ")[0]));
  });
}
