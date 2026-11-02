import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
} from "@discordjs/voice";
import type { Guild, MessageCreateOptions, MessageEditOptions, VoiceBasedChannel } from "discord.js";
import { musicConfig } from "./config";
import { MusicError } from "./errors";
import { resolvePlayable } from "./resolve";
import { loadingEmbed, nameOf, nowPlayingEmbed, type Track } from "./ui";
import { openAudioStream, type AudioStream } from "./ytdlp";

/** A message we sent and may want to change or remove later. */
export interface Sent {
  edit(payload: MessageEditOptions): Promise<unknown>;
  delete(): Promise<unknown>;
}
export type Say = (payload: MessageCreateOptions) => Promise<Sent | void>;
export type Loop = "off" | "track" | "queue";

/** The few things we use from a voice connection (also what the tests fake). */
export interface ConnectionLike {
  subscribe(player: AudioPlayer): unknown;
  destroy(): void;
  rejoin(): boolean;
  readonly state: { status: string; reason?: number; closeCode?: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface SessionDeps {
  joinVoice(channel: VoiceBasedChannel): Promise<ConnectionLike>;
  openStream(url: string): AudioStream;
  resolvePlayable(track: Track): Promise<string>;
  noSubscriber: NoSubscriberBehavior;
}

async function joinReal(channel: VoiceBasedChannel): Promise<ConnectionLike> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    throw new MusicError("I couldn't connect to that voice channel. Check that I'm allowed to join and speak there.");
  }
  return connection as unknown as ConnectionLike;
}

export const deps: SessionDeps = {
  joinVoice: joinReal,
  openStream: openAudioStream,
  resolvePlayable,
  noSubscriber: NoSubscriberBehavior.Pause,
};

const sleep = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

export class MusicSession {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loop: Loop = "off";
  readonly player: AudioPlayer;

  private handle: AudioStream | null = null;
  private starting = false; // picking/opening the next track
  private cancelled = false; // skip/stop pressed while it was still being opened
  private skipRequested = false;
  private discard = false;
  private destroyed = false;
  private playerError = "";
  private lastAnnounced = 0;
  private shown: Promise<Sent | undefined> | null = null; // the message announcing the current song
  private started = false; // has its audio really started?
  private pickedAt = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private aloneTimer: NodeJS.Timeout | undefined;
  private stopWatching: () => void = () => {};

  private constructor(
    readonly guild: Guild,
    public voiceChannel: VoiceBasedChannel,
    public say: Say,
    private connection: ConnectionLike,
    private onDestroy: () => void,
    deps: SessionDeps,
  ) {
    this.deps = deps;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: deps.noSubscriber } });
    connection.subscribe(this.player);

    this.player.on("stateChange", (before, after) => {
      if (after.status === AudioPlayerStatus.Idle && before.status !== AudioPlayerStatus.Idle) void this.onTrackEnd();
    });
    this.player.on("error", (err) => {
      console.error("[music] player error:", err.message);
      this.playerError = err.message;
    });

    this.watchConnection(connection);
    this.startIdleTimer();
  }

  private deps: SessionDeps;

  static async create(guild: Guild, voiceChannel: VoiceBasedChannel, say: Say, d: SessionDeps, onDestroy: () => void) {
    return new MusicSession(guild, voiceChannel, say, await d.joinVoice(voiceChannel), onDestroy, d);
  }

  get isIdle() {
    return !this.current && !this.starting && this.queue.length === 0;
  }

  /** Seconds into the current track. */
  position(): number | null {
    const s = this.player.state;
    return s.status === AudioPlayerStatus.Idle ? null : Math.floor(s.resource.playbackDuration / 1000);
  }

  /* ---------------------------------- queue ---------------------------------- */

  /** Returns where the first added track landed: 0 = it starts right now. */
  enqueue(tracks: Track[], next = false): { startedNow: boolean; position: number } {
    this.clearIdle();
    const idle = !this.current && !this.starting;
    if (next) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    const position = idle ? 0 : next ? 1 : this.queue.length - tracks.length + 1;
    if (idle) void this.playNext();
    return { startedNow: idle, position };
  }

  remove(n: number): Track | null {
    return n >= 1 && n <= this.queue.length ? this.queue.splice(n - 1, 1)[0] : null;
  }

  clear() {
    this.queue.length = 0;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /* --------------------------------- controls -------------------------------- */

  pause() {
    return this.player.pause(true);
  }

  resume() {
    return this.player.unpause();
  }

  private stopCurrent() {
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
    else if (this.starting) this.cancelled = true;
  }

  skip(): Track | null {
    if (!this.current) return null;
    const skipped = this.current;
    this.skipRequested = true;
    this.stopCurrent();
    return skipped;
  }

  skipTo(n: number): boolean {
    if (!this.current || n < 1 || n > this.queue.length) return false;
    this.queue.splice(0, n - 1);
    this.skip();
    return true;
  }

  stop() {
    this.queue.length = 0;
    if (this.current || this.starting) {
      this.discard = true;
      this.stopCurrent();
    } else {
      this.startIdleTimer();
    }
  }

  /** Leave the voice channel. `why` goes in the log, so a disappearing bot is never a mystery. */
  destroy(why = "requested") {
    if (this.destroyed) return;
    this.destroyed = true;
    console.log(`[music] left "${this.voiceChannel.name ?? this.voiceChannel.id}" (${this.guild.name}): ${why}`);
    this.stopWatching();
    this.clearIdle();
    clearTimeout(this.aloneTimer);
    this.queue.length = 0;
    this.handle?.stop();
    this.dropAnnouncement();
    this.player.stop(true);
    try {
      this.connection.destroy();
    } catch {
      /* already gone */
    }
    this.onDestroy();
  }

  /** Keeps the voice connection alive through network hiccups, and never lets its errors crash the bot. */
  private watchConnection(connection: ConnectionLike) {
    const where = () => `"${this.voiceChannel.name ?? this.voiceChannel.id}" (${this.guild.name})`;
    let giveUp: NodeJS.Timeout | undefined;
    let retry: NodeJS.Timeout | undefined;
    let moveCheck: NodeJS.Timeout | undefined;
    let dropped = false;
    const clear = () => {
      clearTimeout(giveUp);
      clearTimeout(moveCheck);
      clearInterval(retry);
      giveUp = moveCheck = retry = undefined;
    };
    this.stopWatching = clear;

    // Without a listener, one network error would throw and take the whole bot down
    connection.on("error", (err: Error) => console.error(`[music] voice connection error in ${where()}:`, err.message));

    connection.on("stateChange", (before: { status: string }, after: { status: string; reason?: number; closeCode?: number }) => {
      if (this.destroyed) return;

      if (after.status === VoiceConnectionStatus.Ready) {
        if (dropped) console.log(`[music] voice connection to ${where()} is back`);
        dropped = false;
        clear();
        return;
      }
      if (after.status === VoiceConnectionStatus.Destroyed) {
        this.destroy("the voice connection was closed");
        return;
      }

      if (before.status === VoiceConnectionStatus.Ready) {
        dropped = true;
        clear();
        const reason = after.closeCode ? `close code ${after.closeCode}` : after.reason !== undefined ? `reason ${after.reason}` : after.status;
        console.warn(`[music] voice connection to ${where()} dropped (${reason}); trying to get it back`);
        const wait = musicConfig().reconnectMs;
        giveUp = setTimeout(() => this.lose(`it couldn't reconnect within ${Math.round(wait / 1000)} seconds`), wait);
        giveUp.unref();
      }

      if (after.status === VoiceConnectionStatus.Disconnected) {
        if (after.closeCode === 4014) {
          // Either I was moved to another channel (then it reconnects by itself) or I was kicked / the channel is gone
          clearTimeout(moveCheck);
          moveCheck = setTimeout(() => {
            if (connection.state.status === VoiceConnectionStatus.Disconnected) this.lose("I was disconnected from the voice channel (kicked, or the channel was deleted)");
          }, Number(process.env.MUSIC_MOVE_GRACE_MS ?? 5000));
          moveCheck.unref();
        } else {
          // Network or gateway trouble: knock again every few seconds until it works
          const knock = () => {
            if (connection.state.status !== VoiceConnectionStatus.Disconnected) return clearInterval(retry);
            connection.rejoin();
          };
          clearInterval(retry);
          retry = setInterval(knock, 5000);
          retry.unref();
          knock();
        }
      }
    });
  }

  /** The connection is gone and not coming back: say so, instead of just vanishing. */
  private lose(why: string) {
    if (this.destroyed) return;
    void Promise.resolve(this.say({ content: `⚠️ I lost the voice connection and had to leave: ${why}.` })).catch(() => {});
    this.destroy(why);
  }

  /** Called when someone joins/leaves voice: leave if only bots remain. */
  checkAlone() {
    const ms = musicConfig().aloneMs;
    if (!ms) return; // 0 = stay no matter what

    // Count people from voice states; someone I can't identify yet counts as a person, so I never leave by mistake
    const me = this.guild.client.user?.id;
    let humans = 0;
    for (const state of this.guild.voiceStates.cache.values()) {
      if (state.channelId === this.voiceChannel.id && state.id !== me && !state.member?.user.bot) humans++;
    }
    if (humans > 0) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = undefined;
      return;
    }
    if (this.aloneTimer) return;
    this.aloneTimer = setTimeout(() => {
      void this.say({ content: "👋 Everyone left, so I did too." });
      this.destroy("everyone left the voice channel");
    }, ms);
    this.aloneTimer.unref();
  }

  /* --------------------------------- playback -------------------------------- */

  private clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private startIdleTimer() {
    this.clearIdle();
    const ms = musicConfig().idleMs;
    if (!ms || this.destroyed) return;
    this.idleTimer = setTimeout(() => {
      void this.say({ content: "💤 Nothing is playing, so I left the voice channel." });
      this.destroy(`idle for ${ms / 60_000} minutes`);
    }, ms);
    this.idleTimer.unref();
  }

  private sendLoading(track: Track): Promise<Sent | undefined> {
    return Promise.resolve(this.say({ embeds: [loadingEmbed(track)] })).then(
      (message) => (message ? message : undefined),
      () => undefined,
    );
  }

  /** Real audio is flowing now: turn "Loading…" into "Now playing". */
  private onAudioStart(track: Track) {
    if (this.current !== track) return;
    this.started = true;
    console.log(`[music] "${track.title}" started ${Date.now() - this.pickedAt} ms after it was picked`);

    const shown = this.shown;
    if (!shown) return; // a repeat of the same song: nothing was announced, nothing to update
    const embed = nowPlayingEmbed(track, null, this.queue.length); // no progress bar here, `nowplaying` has it
    void shown.then((message) => (message ? message.edit({ embeds: [embed] }) : this.say({ embeds: [embed] }))).catch(() => {});
  }

  /** The song was skipped or cancelled before it started: remove its "Loading…" message. */
  private dropAnnouncement() {
    const shown = this.shown;
    this.shown = null;
    if (!this.started) void shown?.then((message) => message?.delete()).catch(() => {});
  }

  /** Tell people a song failed, in place of its announcement when there is one. */
  private async reportFailure(track: Track, why: string) {
    const text = `⚠️ I couldn't play **${nameOf(track, 60)}**: ${why}`;
    const shown = this.shown;
    this.shown = null;
    const message = shown ? await shown : undefined;
    if (message) await Promise.resolve(message.edit({ content: text, embeds: [] })).catch(() => {});
    else await this.say({ content: text });
  }

  private async playNext() {
    if (this.starting || this.destroyed) return;
    this.starting = true;
    this.cancelled = false;
    try {
      for (;;) {
        const track = this.queue.shift();
        if (!track) {
          this.current = null;
          this.startIdleTimer();
          return;
        }
        this.clearIdle();
        this.current = track;
        this.pickedAt = Date.now();
        this.started = false;
        this.shown = null;
        if (this.lastAnnounced !== track.id) {
          this.lastAnnounced = track.id;
          this.shown = this.sendLoading(track); // shown right away: finding and opening a song takes a few seconds
        }

        try {
          if (!track.url) track.url = await this.deps.resolvePlayable(track);
          if (this.destroyed) return;
          if (this.cancelled) {
            // skipped or stopped while we were still finding it
            this.cancelled = false;
            this.skipRequested = false;
            this.current = null;
            this.dropAnnouncement();
            continue;
          }

          const handle = this.deps.openStream(track.url);
          this.handle = handle;
          this.player.play(createAudioResource(handle.stream, { inputType: StreamType.OggOpus }));
          void handle.ready.then((ok) => ok && this.handle === handle && this.onAudioStart(track));
          return;
        } catch (err) {
          this.current = null;
          if (!(err instanceof MusicError)) console.error("[music] couldn't start a track:", err);
          const why = err instanceof MusicError ? err.message : "something went wrong";
          await this.reportFailure(track, why);
        }
      }
    } finally {
      this.starting = false;
    }
  }

  private async onTrackEnd() {
    if (this.destroyed) return;
    const ended = this.current;
    const handle = this.handle;
    this.handle = null;

    let failure = this.playerError;
    this.playerError = "";
    if (handle) {
      if (this.skipRequested || this.discard) {
        handle.stop(); // we ended it on purpose (skip/stop): no need to wait around, the next song can start right away
      } else {
        const result = await Promise.race([handle.done, sleep(2000)]);
        handle.stop();
        // No audio at all means the download failed
        if (result && !result.killed && (result.bytes < 4000 || failure)) failure ||= result.error || "no audio came through";
      }
    }

    this.current = null;
    if (ended && failure) {
      await this.reportFailure(ended, failure);
    } else {
      this.dropAnnouncement(); // skipped before it ever started: remove "Loading…"; a song that played keeps its message
    }
    if (ended && !failure && !this.discard) {
      if (this.loop === "track" && !this.skipRequested) this.queue.unshift(ended);
      else if (this.loop === "queue") this.queue.push(ended);
    }
    this.skipRequested = false;
    this.discard = false;
    await this.playNext();
  }
}

/* ------------------------------ one session per server ------------------------------ */

export const sessions = new Map<string, MusicSession>();

/** Leave every voice channel cleanly (used when the bot is told to stop). */
export async function shutdownSessions(why: string, notice?: string) {
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      if (notice) await Promise.race([Promise.resolve(session.say({ content: notice })).catch(() => {}), sleep(1500)]);
      session.destroy(why);
    }),
  );
}
const pending = new Map<string, Promise<MusicSession>>();

export function ensureSession(guild: Guild, voiceChannel: VoiceBasedChannel, say: Say): Promise<MusicSession> {
  const existing = sessions.get(guild.id);
  if (existing) return Promise.resolve(existing);

  let creating = pending.get(guild.id);
  if (!creating) {
    creating = MusicSession.create(guild, voiceChannel, say, deps, () => sessions.delete(guild.id))
      .then((session) => {
        sessions.set(guild.id, session);
        return session;
      })
      .finally(() => pending.delete(guild.id));
    pending.set(guild.id, creating);
  }
  return creating;
}
