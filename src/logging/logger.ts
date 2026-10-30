import {
  AttachmentBuilder,
  AuditLogEvent,
  ChannelType,
  Events,
  PermissionFlagsBits,
  SnowflakeUtil,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
} from "discord.js";
import { client } from "../bot";
import { ConfigError } from "../messageBuilder";
import {
  deletedEmbed,
  editedEmbed,
  joinEmbed,
  leaveEmbed,
  purgeEmbed,
  type LeaveKind,
  type MemberInfo,
  type Person,
} from "./embeds";
import { allLogSettings, getLogSettings } from "./logStore";
import { messageCache, type CachedMessage } from "./messageCache";
import type { LogSettings } from "./types";

// Audit logs show up a moment after the event itself
const AUDIT_DELAY_MS = process.env.LOG_AUDIT_DELAY_MS !== undefined ? Number(process.env.LOG_AUDIT_DELAY_MS) : 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Last thing that went wrong per server, shown in the panel. */
const problems = new Map<string, string>();

/* --------------------------------- helpers --------------------------------- */

type ChannelLike = { id: string; parentId?: string | null; parent?: { parentId?: string | null } | null };

/** Log channels are never logged (no loops), and neither are ignored channels or categories. */
function isIgnored(s: LogSettings, guild: Guild, channelId: string) {
  const ch = guild.channels.cache.get(channelId) as ChannelLike | undefined;
  const ids = [channelId, ch?.parentId, ch?.parent?.parentId];
  const skip = [s.messageChannelId, s.memberChannelId, ...s.ignoredChannelIds];
  return ids.some((id) => id && skip.includes(id));
}

// Partial users (from uncached events) have an id but no tag yet
const person = (u: { id: string; tag: string | null; displayAvatarURL(options?: { size?: 128 }): string }): Person => ({
  id: u.id,
  tag: u.tag ?? "unknown user",
  avatar: u.displayAvatarURL({ size: 128 }),
});

async function sendLog(guild: Guild, channelId: string, embeds: EmbedBuilder[], files: AttachmentBuilder[] = []) {
  const channel = guild.channels.cache.get(channelId);
  if (channel?.type !== ChannelType.GuildText) {
    problems.set(guild.id, "The log channel doesn't exist anymore. Pick another one in the panel.");
    return;
  }
  try {
    await channel.send({ embeds, files, allowedMentions: { parse: [] } });
    problems.delete(guild.id);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    problems.set(guild.id, `Couldn't post in #${channel.name}: ${why}`);
    console.error(`[logs] ${guild.name}:`, why);
  }
}

const messageChannel = (s: LogSettings) => s.messageChannelId;
const memberChannel = (s: LogSettings) => s.memberChannelId || s.messageChannelId;

/* ------------------------------- audit lookups ------------------------------- */

const canReadAudit = (guild: Guild) => guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog) ?? false;

/** Audit entries whose delete-count we've already accounted for. */
const seenCounts = new Map<string, number>();

/**
 * Who deleted a message? Discord only records deletions by *other people* (moderators), and merges
 * repeated deletions of the same author in the same channel into one entry with a rising count.
 * So an entry only counts when it's brand new or its count went up since we last looked.
 */
export async function findDeleter(guild: Guild, channelId: string, authorId: string): Promise<Person | null> {
  if (!canReadAudit(guild)) return null;
  try {
    await sleep(AUDIT_DELAY_MS);
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 6 });
    for (const entry of logs.entries.values()) {
      const extra = entry.extra as { channel?: { id: string }; count?: number } | null;
      if (entry.targetId !== authorId || extra?.channel?.id !== channelId || !entry.executor) continue;

      const count = extra.count ?? 1;
      const previous = seenCounts.get(entry.id);
      const isNew = previous === undefined ? Date.now() - entry.createdTimestamp < 10_000 : count > previous;
      seenCounts.set(entry.id, count);
      if (seenCounts.size > 200) seenCounts.delete(seenCounts.keys().next().value as string);
      if (isNew) return person(entry.executor);
    }
  } catch (err) {
    console.error("[logs] audit log lookup failed:", err instanceof Error ? err.message : err);
  }
  return null;
}

async function findRemoval(guild: Guild, userId: string) {
  if (!canReadAudit(guild)) return null;
  try {
    await sleep(AUDIT_DELAY_MS);
    for (const [type, kind] of [
      [AuditLogEvent.MemberBanAdd, "banned"],
      [AuditLogEvent.MemberKick, "kicked"],
    ] as const) {
      const logs = await guild.fetchAuditLogs({ type, limit: 5 });
      const entry = logs.entries.find((e) => e.targetId === userId && Date.now() - e.createdTimestamp < 15_000);
      if (entry) return { kind, by: entry.executor ? person(entry.executor) : null, reason: entry.reason };
    }
  } catch (err) {
    console.error("[logs] audit log lookup failed:", err instanceof Error ? err.message : err);
  }
  return null;
}

/* ------------------------------- message events ------------------------------ */

function toCached(m: Message, guildId: string): CachedMessage {
  return {
    id: m.id,
    guildId,
    channelId: m.channelId,
    authorId: m.author.id,
    authorTag: m.author.tag,
    authorAvatar: m.author.displayAvatarURL({ size: 128 }),
    content: m.content,
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    createdAt: m.createdTimestamp,
  };
}

function remember(m: Message) {
  if (!m.guildId || m.system) return;
  const s = getLogSettings(m.guildId);
  if (!s.enabled || !(s.events.delete || s.events.edit)) return;
  if (m.author.bot && s.ignoreBots) return;
  messageCache.set(toCached(m, m.guildId));
}

async function onDelete(m: Message | PartialMessage) {
  const guild = m.guildId ? client.guilds.cache.get(m.guildId) : undefined;
  if (!guild) return;
  const s = getLogSettings(guild.id);
  if (!s.enabled || !s.events.delete || !s.messageChannelId) return;

  const cached = messageCache.get(m.id);
  messageCache.delete(m.id);
  if (isIgnored(s, guild, m.channelId)) return;

  // Without the author there's nothing useful to show (and it's often just a bot cleaning up)
  const author: Person | null = cached
    ? { id: cached.authorId, tag: cached.authorTag, avatar: cached.authorAvatar }
    : m.author
      ? person(m.author)
      : null;
  if (!author || (!cached && m.author?.bot && s.ignoreBots)) return;

  const attachments = cached?.attachments ?? (m.attachments ? [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })) : []);
  const content = cached ? cached.content : typeof m.content === "string" ? m.content : null;
  const deletedBy = await findDeleter(guild, m.channelId, author.id);

  await sendLog(
    guild,
    messageChannel(s),
    [deletedEmbed({ author, channelId: m.channelId, messageId: m.id, content, attachments, sentAt: cached?.createdAt ?? m.createdTimestamp ?? undefined, deletedBy })],
  );
}

async function onBulkDelete(messages: ReadonlyMap<string, Message | PartialMessage>, channel: { id: string; guildId: string }) {
  const guild = client.guilds.cache.get(channel.guildId);
  if (!guild) return;
  const s = getLogSettings(guild.id);
  if (!s.enabled || !s.events.delete || !s.messageChannelId || isIgnored(s, guild, channel.id)) return;

  const rows = [...messages.values()].map((m) => {
    const cached = messageCache.get(m.id);
    messageCache.delete(m.id);
    const at = cached?.createdAt ?? m.createdTimestamp ?? SnowflakeUtil.timestampFrom(m.id); // message IDs encode their send time
    const who = cached ? `${cached.authorTag} (${cached.authorId})` : m.author ? `${m.author.tag} (${m.author.id})` : "unknown author";
    const content = cached ? cached.content : typeof m.content === "string" ? m.content : null;
    return { at, known: content !== null, line: `[${new Date(at).toISOString()}] ${who}: ${content ?? "(I didn't see this message)"}` };
  });
  rows.sort((a, b) => a.at - b.at);

  const file = new AttachmentBuilder(Buffer.from(rows.map((r) => r.line).join("\n"), "utf8"), { name: "deleted-messages.txt" });
  await sendLog(guild, messageChannel(s), [purgeEmbed(rows.length, rows.filter((r) => r.known).length, channel.id)], [file]);
}

async function onUpdate(oldM: Message | PartialMessage, newM: Message | PartialMessage) {
  const guild = newM.guildId ? client.guilds.cache.get(newM.guildId) : undefined;
  if (!guild) return;
  const s = getLogSettings(guild.id);
  if (!s.enabled || !s.events.edit || !s.messageChannelId) return;

  let current: Message;
  try {
    current = newM.partial ? await newM.fetch() : (newM as Message);
  } catch {
    return; // message is gone
  }
  if (current.system || (current.author.bot && s.ignoreBots) || isIgnored(s, guild, current.channelId)) return;

  const cached = messageCache.get(current.id);
  const before = cached ? cached.content : typeof oldM.content === "string" ? oldM.content : null;
  const after = current.content;

  if (before !== null) {
    if (before === after) return; // an embed loaded or the message was pinned, not an edit
  } else if (!current.editedTimestamp || Date.now() - current.editedTimestamp > 10_000) {
    return; // can't compare, and nothing says it was edited just now
  }

  messageCache.set(toCached(current, guild.id));
  await sendLog(
    guild,
    messageChannel(s),
    [editedEmbed({ author: person(current.author), channelId: current.channelId, messageId: current.id, url: current.url, before, after })],
  );
}

/* -------------------------------- member events ------------------------------ */

function memberInfo(m: GuildMember | PartialGuildMember, guild: Guild): MemberInfo {
  return {
    id: m.id,
    tag: m.user.tag,
    bot: m.user.bot,
    avatar: m.user.displayAvatarURL({ size: 128 }),
    createdAt: m.user.createdTimestamp,
    joinedAt: m.joinedTimestamp,
    roles: [...m.roles.cache.keys()].filter((id) => id !== guild.id),
    memberCount: guild.memberCount,
  };
}

async function onJoin(member: GuildMember) {
  const s = getLogSettings(member.guild.id);
  if (!s.enabled || !s.events.join || !memberChannel(s)) return;
  await sendLog(member.guild, memberChannel(s), [joinEmbed(memberInfo(member, member.guild), s.newAccountDays)]);
}

async function onLeave(member: GuildMember | PartialGuildMember) {
  const guild = member.guild;
  const s = getLogSettings(guild.id);
  if (!s.enabled || !s.events.leave || !memberChannel(s) || member.id === client.user?.id) return;

  const removal = await findRemoval(guild, member.id);
  const kind: LeaveKind = removal?.kind ?? "left";
  await sendLog(guild, memberChannel(s), [leaveEmbed(memberInfo(member, guild), kind, removal?.by, removal?.reason)]);
}

/** Members who joined before I started aren't in memory yet; load them so leave logs can show roles. */
export function warmMembers(guild: Guild) {
  const s = getLogSettings(guild.id);
  if (!s.enabled || !s.events.leave || guild.memberCount > 5000) return;
  guild.members.fetch().catch((err) => console.error("[logs] couldn't load members:", err instanceof Error ? err.message : err));
}

/* ----------------------------------- wiring ---------------------------------- */

function safe<A extends unknown[]>(name: string, fn: (...args: A) => unknown) {
  return (...args: A) => {
    Promise.resolve(fn(...args)).catch((err) => console.error(`[logs] ${name} failed:`, err));
  };
}

export function registerLogger() {
  client.on(Events.MessageCreate, safe("messageCreate", remember));
  client.on(Events.MessageUpdate, safe("messageUpdate", onUpdate));
  client.on(Events.MessageDelete, safe("messageDelete", onDelete));
  client.on(Events.MessageBulkDelete, safe("messageDeleteBulk", onBulkDelete));
  client.on(Events.GuildMemberAdd, safe("guildMemberAdd", onJoin));
  client.on(Events.GuildMemberRemove, safe("guildMemberRemove", onLeave));
  client.once(Events.ClientReady, () => {
    for (const id of allLogSettings()) {
      const guild = client.guilds.cache.get(id);
      if (guild) warmMembers(guild);
    }
  });
}

/* ---------------------------------- panel API -------------------------------- */

export function getLogStatus(guildId: string) {
  return { remembered: messageCache.size, problem: problems.get(guildId) ?? "" };
}

/** Names of the permissions I'm missing to post in a channel (empty = all good). */
export function missingPostPermissions(guild: Guild, channelId: string): string[] {
  const channel = guild.channels.cache.get(channelId);
  const me = guild.members.me;
  if (channel?.type !== ChannelType.GuildText || !me) return [];
  const perms = channel.permissionsFor(me);
  const needed = [
    ["View Channel", PermissionFlagsBits.ViewChannel],
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Embed Links", PermissionFlagsBits.EmbedLinks],
    ["Attach Files", PermissionFlagsBits.AttachFiles],
  ] as const;
  return needed.filter(([, flag]) => !perms?.has(flag)).map(([name]) => name);
}

/** Posts sample log entries so you can check the channels and permissions. */
export async function sendTestLogs(guild: Guild, s: LogSettings) {
  const bot = client.user;
  const me = {
    id: bot?.id ?? "0",
    tag: bot?.tag ?? "Rynata",
    avatar: bot?.displayAvatarURL({ size: 128 }) ?? "",
  };
  const now = Date.now();
  const member: MemberInfo = { ...me, bot: true, createdAt: now - 3 * 86_400_000, joinedAt: now - 86_400_000, memberCount: guild.memberCount, sample: true };

  const wantsMessages = s.events.delete || s.events.edit;
  const wantsMembers = s.events.join || s.events.leave;
  if ((wantsMessages && !s.messageChannelId) || (wantsMembers && !memberChannel(s))) throw new ConfigError("Pick the log channels and save first");

  const messageEmbeds: EmbedBuilder[] = [];
  if (s.events.delete) messageEmbeds.push(deletedEmbed({ author: me, channelId: s.messageChannelId, messageId: "0", content: "This is what a deleted message will look like.", attachments: [], sentAt: now - 60_000, sample: true }));
  if (s.events.edit) messageEmbeds.push(editedEmbed({ author: me, channelId: s.messageChannelId, messageId: "0", url: "https://discord.com", before: "The old text", after: "The new text", sample: true }));
  if (messageEmbeds.length) await sendLog(guild, s.messageChannelId, messageEmbeds);

  const memberEmbeds: EmbedBuilder[] = [];
  if (s.events.join) memberEmbeds.push(joinEmbed(member, s.newAccountDays));
  if (s.events.leave) memberEmbeds.push(leaveEmbed(member, "left"));
  if (memberEmbeds.length) await sendLog(guild, memberChannel(s), memberEmbeds);

  const problem = problems.get(guild.id);
  if (problem) throw new ConfigError(problem);
}
