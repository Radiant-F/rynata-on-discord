import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  Events,
  type Guild,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { client } from "../bot";
import { musicConfig } from "./config";
import { MusicError } from "./errors";
import { makeTrack, resolveRequest, type Request } from "./resolve";
import { ensureSession, sessions, type Loop, type Say } from "./session";
import { helpEmbed, nameOf, playlistEmbed, queueEmbed, queuedEmbed, nowPlayingEmbed, searchEmbed } from "./ui";
import { ffmpegVersion, searchYouTube, updateYtDlp, ytdlpVersion } from "./ytdlp";

interface Ctx {
  message: Message;
  channel: SendableChannels;
  guild: Guild;
  member: GuildMember;
  args: string;
  say: Say;
}

const ALIASES: Record<string, string> = {
  p: "play",
  pn: "playnext",
  s: "skip",
  next: "skip",
  q: "queue",
  np: "nowplaying",
  now: "nowplaying",
  dc: "leave",
  disconnect: "leave",
  fs: "skip",
  find: "search",
  repeat: "loop",
  unpause: "resume",
};

/* --------------------------------- guards ---------------------------------- */

function requireVoice(ctx: Ctx): VoiceBasedChannel {
  const channel = ctx.member.voice.channel;
  if (!channel) throw new MusicError("Join a voice channel first.");
  if (channel.type !== ChannelType.GuildVoice) throw new MusicError("I can only play in regular voice channels, not Stage channels.");
  if (!channel.joinable) throw new MusicError(`I can't join <#${channel.id}> (I'm missing permission, or it's full).`);
  if (!channel.speakable) throw new MusicError(`I'm not allowed to speak in <#${channel.id}>.`);
  return channel;
}

function requireSession(ctx: Ctx) {
  const session = sessions.get(ctx.guild.id);
  if (!session) throw new MusicError("I'm not playing anything right now.");
  const channel = ctx.member.voice.channel;
  if (!channel || channel.id !== session.voiceChannel.id) throw new MusicError(`Join <#${session.voiceChannel.id}> to control the music.`);
  session.say = ctx.say;
  return session;
}

function number(ctx: Ctx, what: string): number {
  const n = Number.parseInt(ctx.args, 10);
  if (!Number.isFinite(n) || n < 1) throw new MusicError(`Tell me which one: \`${musicConfig().prefix} ${what} <number>\` (see \`${musicConfig().prefix} queue\`).`);
  return n;
}

/* -------------------------------- commands --------------------------------- */

async function addToQueue(ctx: Ctx, request: Request, next: boolean, channel: VoiceBasedChannel) {
  let session = sessions.get(ctx.guild.id);
  if (session && session.voiceChannel.id !== channel.id) {
    if (!session.isIdle) throw new MusicError(`I'm already playing in <#${session.voiceChannel.id}>. Join it to add songs.`);
    session.destroy(); // idle in another channel: move over to the person asking
  }

  session = await ensureSession(ctx.guild, channel, ctx.say);
  session.say = ctx.say;
  const { startedNow, position } = session.enqueue(request.tracks, next);

  if (request.playlist) {
    await ctx.say({ embeds: [playlistEmbed(request.title, request.tracks.length, request.read, request.total, request.thumbnail)] });
  } else if (!startedNow) {
    await ctx.say({ embeds: [queuedEmbed(request.tracks[0], position)] });
  }
  if (request.hint) await ctx.say({ content: request.hint });
}

/** An hourglass on the command message while I look things up, so you know I'm on it. */
async function whileLookingUp<T>(ctx: Ctx, work: () => Promise<T>): Promise<T> {
  const reaction = Promise.resolve(ctx.message.react("⏳")).catch(() => null);
  void ctx.channel.sendTyping().catch(() => {});
  try {
    return await work();
  } finally {
    void reaction.then((r) => r?.users.remove()).catch(() => {}); // removes my own reaction
  }
}

async function play(ctx: Ctx, next = false) {
  const prefix = musicConfig().prefix;
  if (!ctx.args) throw new MusicError(`Tell me what to play: \`${prefix} play <link or song name>\``);
  const channel = requireVoice(ctx);
  const request = await whileLookingUp(ctx, () => resolveRequest(ctx.args, ctx.message.author.id));
  await addToQueue(ctx, request, next, channel);
}

async function search(ctx: Ctx) {
  if (!ctx.args) throw new MusicError(`What should I search for? \`${musicConfig().prefix} search <song name>\``);
  const channel = requireVoice(ctx);
  const results = (await whileLookingUp(ctx, () => searchYouTube(ctx.args, 5))).slice(0, 5);
  if (!results.length) throw new MusicError(`I couldn't find anything for “${ctx.args.slice(0, 80)}”.`);

  const token = ctx.message.id;
  // A row holds at most 5 buttons, so the numbers get one row and "cancel" another
  const numbers = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...results.map((_, i) => new ButtonBuilder().setCustomId(`msearch:${token}:${i}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Secondary)),
  );
  const cancel = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`msearch:${token}:x`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  const sent = await ctx.channel.send({ embeds: [searchEmbed(ctx.args, results)], components: [numbers, cancel], allowedMentions: { parse: [] } });

  let pick;
  try {
    pick = await sent.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: { user: { id: string }; customId: string }) => i.user.id === ctx.message.author.id && i.customId.startsWith(`msearch:${token}:`),
      time: 60_000,
    });
  } catch {
    await sent.edit({ components: [] }).catch(() => {}); // nobody picked: remove the buttons
    return;
  }

  const choice = pick.customId.split(":")[2];
  if (choice === "x") {
    await pick.update({ content: "Search cancelled.", embeds: [], components: [] });
    return;
  }
  await pick.update({ components: [] });

  const chosen = results[Number(choice)];
  const request: Request = { title: chosen.title, playlist: false, tracks: [makeTrack(chosen, ctx.message.author.id, "youtube")], read: 1, total: 1, thumbnail: chosen.thumbnail };
  await addToQueue(ctx, request, false, channel);
}

async function join(ctx: Ctx) {
  const channel = requireVoice(ctx);
  const existing = sessions.get(ctx.guild.id);
  if (existing && existing.voiceChannel.id !== channel.id) {
    if (!existing.isIdle) throw new MusicError(`I'm already playing in <#${existing.voiceChannel.id}>.`);
    existing.destroy();
  }
  const session = await ensureSession(ctx.guild, channel, ctx.say);
  session.say = ctx.say;
  await ctx.say({ content: `🔊 Joined <#${channel.id}>. Use \`${musicConfig().prefix} play\` to start something.` });
}

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  play: (ctx) => play(ctx),
  playnext: (ctx) => play(ctx, true),
  search,
  join,

  async pause(ctx) {
    const session = requireSession(ctx);
    if (!session.current) throw new MusicError("Nothing is playing.");
    session.pause();
    await ctx.say({ content: "⏸️ Paused." });
  },

  async resume(ctx) {
    const session = requireSession(ctx);
    if (!session.current) throw new MusicError("Nothing is playing.");
    session.resume();
    await ctx.say({ content: "▶️ Resumed." });
  },

  async skip(ctx) {
    const session = requireSession(ctx);
    const skipped = session.skip();
    if (!skipped) throw new MusicError("Nothing is playing.");
    await ctx.say({ content: `⏭️ Skipped **${nameOf(skipped, 60)}**.` });
    if (!session.queue.length) await ctx.say({ content: "That was the last song in the queue." });
  },

  async skipto(ctx) {
    const session = requireSession(ctx);
    if (!session.skipTo(number(ctx, "skipto"))) throw new MusicError(`There's no #${ctx.args} in the queue.`);
    await ctx.say({ content: `⏭️ Skipping to #${ctx.args}.` });
  },

  async stop(ctx) {
    const session = requireSession(ctx);
    session.stop();
    await ctx.say({ content: "⏹️ Stopped and cleared the queue." });
  },

  async leave(ctx) {
    const session = requireSession(ctx);
    session.destroy();
    await ctx.say({ content: "👋 Bye!" });
  },

  async clear(ctx) {
    const session = requireSession(ctx);
    session.clear();
    await ctx.say({ content: "🧹 Cleared the queue (the current song keeps playing)." });
  },

  async shuffle(ctx) {
    const session = requireSession(ctx);
    if (session.queue.length < 2) throw new MusicError("There's nothing to shuffle.");
    session.shuffle();
    await ctx.say({ content: `🔀 Shuffled ${session.queue.length} songs.` });
  },

  async remove(ctx) {
    const session = requireSession(ctx);
    const removed = session.remove(number(ctx, "remove"));
    if (!removed) throw new MusicError(`There's no #${ctx.args} in the queue.`);
    await ctx.say({ content: `🗑️ Removed **${nameOf(removed, 60)}**.` });
  },

  async loop(ctx) {
    const session = requireSession(ctx);
    const word = ctx.args.toLowerCase();
    const modes: Record<string, Loop> = { off: "off", none: "off", track: "track", song: "track", one: "track", queue: "queue", all: "queue" };
    const next: Loop = modes[word] ?? ({ off: "track", track: "queue", queue: "off" } as const)[session.loop];
    if (word && !modes[word]) throw new MusicError("Use `off`, `track` or `queue`.");
    session.loop = next;
    await ctx.say({ content: { off: "➡️ Loop is off.", track: "🔂 Looping the current song.", queue: "🔁 Looping the whole queue." }[next] });
  },

  async queue(ctx) {
    const session = sessions.get(ctx.guild.id);
    if (!session || (!session.current && !session.queue.length)) throw new MusicError("The queue is empty.");
    await ctx.say({ embeds: [queueEmbed(session.current, session.queue, Number.parseInt(ctx.args, 10) || 1, session.loop)] });
  },

  async nowplaying(ctx) {
    const session = sessions.get(ctx.guild.id);
    if (!session?.current) throw new MusicError("Nothing is playing.");
    await ctx.say({ embeds: [nowPlayingEmbed(session.current, session.position(), session.queue.length)] });
  },

  async help(ctx) {
    await ctx.say({ embeds: [helpEmbed(musicConfig().prefix)] });
  },
};

/* ------------------------------- entry points ------------------------------- */

function parse(content: string) {
  const prefix = musicConfig().prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = content.trim().match(new RegExp(`^${prefix}\\s+(\\S+)(?:\\s+([\\s\\S]*))?$`, "i"));
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

export async function handleMessage(message: Message) {
  if (message.author.bot || !message.guild || !message.member || !message.channel.isSendable()) return;
  const parsed = parse(message.content);
  if (!parsed) return;
  const run = COMMANDS[ALIASES[parsed.name] ?? parsed.name];
  if (!run) return; // not one of ours: it's just chat

  const channel = message.channel;
  const say: Say = (payload: MessageCreateOptions) => channel.send({ ...payload, allowedMentions: { parse: [] } });
  const ctx: Ctx = { message, channel, guild: message.guild, member: message.member, args: parsed.args, say };

  try {
    await run(ctx);
  } catch (err) {
    if (err instanceof MusicError) {
      await say({ content: `❌ ${err.message}` }).catch(() => {});
    } else {
      console.error("[music] command failed:", err);
      await say({ content: "❌ Something went wrong. Check the bot's log for details." }).catch(() => {});
    }
  }
}

function onVoiceState(before: VoiceState, after: VoiceState) {
  const session = sessions.get(after.guild.id);
  if (!session) return;

  if (after.id === client.user?.id) {
    if (!after.channelId) session.destroy(); // kicked out of the channel
    else if (after.channel && after.channelId !== session.voiceChannel.id) session.voiceChannel = after.channel; // moved
  }
  session.checkAlone();
}

async function upkeep() {
  const [ytdlp, ffmpeg] = await Promise.all([ytdlpVersion(), ffmpegVersion()]);
  const missing = [!ytdlp && "yt-dlp", !ffmpeg && "ffmpeg"].filter(Boolean);
  if (missing.length) {
    console.warn(`⚠️ Music won't work: ${missing.join(" and ")} not found on this machine. See deploy/MUSIC.md.`);
    return;
  }
  console.log(`🎵 Music is ready (yt-dlp ${ytdlp}, ffmpeg ${ffmpeg}). In Discord: "${musicConfig().prefix} help"`);

  if (!musicConfig().autoUpdate) return;
  const update = async () => {
    const result = await updateYtDlp();
    if (result) console.log(`🎵 yt-dlp update check: ${result}`);
  };
  setTimeout(update, 30_000).unref();
  setInterval(update, 12 * 3600_000).unref();
}

export function registerMusic() {
  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => console.error("[music]", err));
  });
  client.on(Events.VoiceStateUpdate, onVoiceState);
  client.once(Events.ClientReady, () => void upkeep());
}
