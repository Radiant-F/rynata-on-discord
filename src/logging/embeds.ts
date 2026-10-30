import { EmbedBuilder, escapeMarkdown } from "discord.js";

const unix = (ms: number) => Math.floor(ms / 1000);
const when = (ms: number) => `<t:${unix(ms)}:F> (<t:${unix(ms)}:R>)`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
// Show the text exactly as typed (no bold/italic), clipped to what Discord allows
const raw = (s: string, max: number) => clip(escapeMarkdown(s), max);

export interface Person {
  id: string;
  tag: string;
  avatar: string;
}

export interface DeletedInfo {
  author: Person;
  channelId: string;
  messageId: string;
  content: string | null; // null = I never saw this message
  attachments: { name: string; url: string }[];
  sentAt?: number;
  deletedBy?: Person | null;
  sample?: boolean;
}

export function deletedEmbed(i: DeletedInfo) {
  const embed = new EmbedBuilder()
    .setColor(0xda373c)
    .setTitle(`🗑️ Message deleted${i.sample ? " (sample)" : ""}`)
    .setThumbnail(i.author.avatar || null)
    .setDescription(
      i.content === null
        ? "*I didn't see this message (it was sent before I started watching, or a long time ago), so I can't show its text.*"
        : i.content
          ? raw(i.content, 4000)
          : "*(no text)*",
    )
    .addFields(
      { name: "Author", value: `<@${i.author.id}> (${escapeMarkdown(i.author.tag)})`, inline: true },
      { name: "Channel", value: `<#${i.channelId}>`, inline: true },
    )
    .setFooter({ text: `Author ID: ${i.author.id} · Message ID: ${i.messageId}` })
    .setTimestamp();

  if (i.deletedBy) embed.addFields({ name: "Deleted by", value: `<@${i.deletedBy.id}> (${escapeMarkdown(i.deletedBy.tag)})`, inline: true });
  if (i.sentAt) embed.addFields({ name: "Sent", value: `<t:${unix(i.sentAt)}:R>`, inline: true });
  if (i.attachments.length) {
    const list = i.attachments.map((a) => `[${escapeMarkdown(a.name)}](${a.url})`).join("\n");
    embed.addFields({ name: "Attachments", value: clip(list, 1024) });
  }
  return embed;
}

export interface EditedInfo {
  author: Person;
  channelId: string;
  messageId: string;
  url: string;
  before: string | null;
  after: string;
  sample?: boolean;
}

export function editedEmbed(i: EditedInfo) {
  const show = (s: string | null) => (s === null ? "*(unknown, I didn't see the original)*" : s ? raw(s, 1024) : "*(empty)*");
  return new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle(`✏️ Message edited${i.sample ? " (sample)" : ""}`)
    .setThumbnail(i.author.avatar || null)
    .setDescription(`[Jump to message](${i.url})`)
    .addFields(
      { name: "Before", value: show(i.before) },
      { name: "After", value: show(i.after) },
      { name: "Author", value: `<@${i.author.id}> (${escapeMarkdown(i.author.tag)})`, inline: true },
      { name: "Channel", value: `<#${i.channelId}>`, inline: true },
    )
    .setFooter({ text: `Author ID: ${i.author.id} · Message ID: ${i.messageId}` })
    .setTimestamp();
}

export function purgeEmbed(count: number, known: number, channelId: string) {
  return new EmbedBuilder()
    .setColor(0xda373c)
    .setTitle(`🧹 ${count} messages deleted at once`)
    .setDescription(
      `In <#${channelId}>. I knew the text of ${known} of them; the full list is in the attached file.`,
    )
    .setTimestamp();
}

export interface MemberInfo {
  id: string;
  tag: string;
  bot: boolean;
  avatar: string;
  createdAt: number;
  joinedAt?: number | null;
  roles?: string[]; // role ids
  memberCount: number;
  sample?: boolean;
}

export function joinEmbed(m: MemberInfo, newAccountDays: number) {
  const young = newAccountDays > 0 && Date.now() - m.createdAt < newAccountDays * 86_400_000;
  const embed = new EmbedBuilder()
    .setColor(young ? 0xf0b232 : 0x23a55a)
    .setTitle(`📥 ${m.bot ? "Bot" : "Member"} joined${m.sample ? " (sample)" : ""}`)
    .setThumbnail(m.avatar || null)
    .setDescription(`<@${m.id}> (${escapeMarkdown(m.tag)})`)
    .addFields(
      { name: "Account created", value: when(m.createdAt), inline: true },
      { name: "Member count", value: String(m.memberCount), inline: true },
    )
    .setFooter({ text: `User ID: ${m.id}` })
    .setTimestamp();
  if (young) embed.addFields({ name: "⚠️ New account", value: `Younger than ${newAccountDays} day${newAccountDays === 1 ? "" : "s"}` });
  return embed;
}

export type LeaveKind = "left" | "kicked" | "banned";

export function leaveEmbed(m: MemberInfo, kind: LeaveKind, by?: Person | null, reason?: string | null) {
  const style = {
    left: { color: 0x80848e, title: "📤 Member left" },
    kicked: { color: 0xf0b232, title: "👢 Member kicked" },
    banned: { color: 0xda373c, title: "🔨 Member banned" },
  }[kind];

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.title}${m.sample ? " (sample)" : ""}`)
    .setThumbnail(m.avatar || null)
    .setDescription(`<@${m.id}> (${escapeMarkdown(m.tag)})`)
    .addFields({ name: "Member count", value: String(m.memberCount), inline: true })
    .setFooter({ text: `User ID: ${m.id}` })
    .setTimestamp();

  if (m.joinedAt) embed.addFields({ name: "Joined", value: when(m.joinedAt), inline: true });
  if (m.roles?.length) embed.addFields({ name: "Roles", value: clip(m.roles.map((id) => `<@&${id}>`).join(" "), 1024) });
  if (by) embed.addFields({ name: kind === "banned" ? "Banned by" : "Kicked by", value: `<@${by.id}> (${escapeMarkdown(by.tag)})`, inline: true });
  if (reason) embed.addFields({ name: "Reason", value: raw(reason, 1024) });
  return embed;
}
