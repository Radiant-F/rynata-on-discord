import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type BaseMessageOptions,
  type MessageMentionOptions,
} from "discord.js";
import type { AlertSettings, LiveSet } from "./types";

// Text that comes from Twitch/YouTube (anyone could put "@everyone" in a stream title)
const UNTRUSTED = new Set(["streamer", "title", "game"]);

/** Replaces {placeholders}. Stream-provided text can never create a ping. */
export function fillTemplate(template: string, vars: Record<string, string>, markdown: boolean): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!Object.hasOwn(vars, key)) return whole;
    const value = vars[key];
    if (!UNTRUSTED.has(key)) return value;
    const safe = value.replace(/@/g, "@\u200b");
    return markdown ? escapeMarkdown(safe) : safe;
  });
}

export interface BuildOptions {
  /** Test alerts never ping: mentions are shown as plain text instead. */
  test?: boolean;
  roleName?: string;
}

function mentionText(s: AlertSettings, opts: BuildOptions): string {
  switch (s.mention.type) {
    case "everyone":
      return opts.test ? "`@everyone`" : "@everyone";
    case "here":
      return opts.test ? "`@here`" : "@here";
    case "role":
      return opts.test ? `**@${opts.roleName ?? "role"}**` : `<@&${s.mention.roleId}>`;
    default:
      return "";
  }
}

// Twitch keeps the same thumbnail URL for a while, so add a changing number
const bust = (u: string) => (u.includes("jtvnw.net") ? `${u}${u.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60_000)}` : u);

const linkButton = (url: string, label: string) =>
  new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label.slice(0, 80));

export function buildAlert(
  s: AlertSettings,
  live: LiveSet,
  opts: BuildOptions = {},
): { message: BaseMessageOptions; allowedMentions: MessageMentionOptions } {
  // Title, thumbnail and title link come from the main platform; if it isn't live (yet), from the other one
  const order = s.mainPlatform === "youtube" ? [live.youtube, live.twitch] : [live.twitch, live.youtube];
  const primary = order.find(Boolean);
  const thumbnail = order.find((info) => info?.thumbnail)?.thumbnail;
  const platforms = [live.youtube && "YouTube", live.twitch && "Twitch"].filter(Boolean).join(" & ");
  const mention = mentionText(s, opts);

  const vars: Record<string, string> = {
    mention,
    streamer: primary?.streamer ?? "",
    title: primary?.title ?? "",
    game: primary?.game || live.twitch?.game || live.youtube?.game || "",
    platforms,
    twitchUrl: live.twitch?.url ?? "",
    youtubeUrl: live.youtube?.url ?? "",
  };

  let content = fillTemplate(s.content, vars, true).trim();
  // A ping only works from the message text, so make sure it's there
  if (mention && !s.content.includes("{mention}")) content = `${mention} ${content}`.trim();
  if (opts.test) content = `🧪 *Test alert. Nobody was pinged.*\n${content}`;

  const embeds: EmbedBuilder[] = [];
  if (s.embed) {
    const e = s.embed;
    const embed = new EmbedBuilder().setColor(parseInt(e.color.slice(1), 16));
    const title = fillTemplate(e.title, vars, false).slice(0, 256);
    const description = fillTemplate(e.description, vars, true).slice(0, 4096);
    const footer = fillTemplate(e.footer, vars, false).slice(0, 2048);
    const image = s.liveThumbnail && thumbnail ? bust(thumbnail) : e.image;

    if (title) {
      embed.setTitle(title);
      if (primary?.url) embed.setURL(primary.url);
    }
    if (description) embed.setDescription(description);
    if (footer) embed.setFooter({ text: footer });
    if (image) embed.setImage(image);
    if (e.thumbnail) embed.setThumbnail(e.thumbnail);

    // Discord rejects embeds with nothing in them (e.g. a title that was only {game})
    if (title || description || footer || image || e.thumbnail) embeds.push(embed);
  }

  if (!content && !embeds.length) content = "🔴 Live now!";
  content = content.slice(0, 2000);

  const row = new ActionRowBuilder<ButtonBuilder>();
  if (live.youtube) row.addComponents(linkButton(live.youtube.url, s.youtubeButton || "Watch on YouTube"));
  if (live.twitch) row.addComponents(linkButton(live.twitch.url, s.twitchButton || "Watch on Twitch"));

  const allowedMentions: MessageMentionOptions = opts.test
    ? { parse: [] }
    : s.mention.type === "role"
      ? { parse: [], roles: [s.mention.roleId] }
      : s.mention.type === "everyone" || s.mention.type === "here"
        ? { parse: ["everyone"] }
        : { parse: [] };

  return {
    message: { content, embeds, components: row.components.length ? [row] : [] },
    allowedMentions,
  };
}
