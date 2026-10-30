import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type BaseMessageOptions,
  type Guild,
} from "discord.js";

export type ButtonMode = "toggle" | "give";
export type ButtonColor = "primary" | "secondary" | "success" | "danger";

export interface ButtonConfig {
  label: string;
  emoji: string;
  style: ButtonColor;
  mode: ButtonMode;
  roleId: string;
}

export interface EmbedConfig {
  title: string;
  description: string;
  color: string; // "#rrggbb"
  image: string;
  thumbnail: string;
  footer: string;
}

export interface MessageConfig {
  content: string;
  /** File name of an uploaded image (see images.ts) or "". Sent as an attachment, not inside the embed. */
  image: string;
  embed: EmbedConfig | null;
  buttons: ButtonConfig[];
}

/** Thrown for problems the person using the web panel can fix. */
export class ConfigError extends Error {}

const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
export const isImageName = (v: unknown): v is string => typeof v === "string" && IMAGE_NAME.test(v);

const STYLES: Record<ButtonColor, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
const MODES: ButtonMode[] = ["toggle", "give"];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function text(value: unknown, max: number, field: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length > max) {
    throw new ConfigError(`${field} is too long (max ${max} characters)`);
  }
  return s;
}

export function url(value: unknown, field: string): string {
  const s = text(value, 2000, field);
  if (s && !/^https?:\/\//i.test(s)) {
    throw new ConfigError(`${field} must start with http:// or https://`);
  }
  return s;
}

/** Cleans an embed from request JSON. Returns null when the embed would be empty. */
export function parseEmbed(raw: unknown): EmbedConfig | null {
  if (!isRecord(raw)) return null;
  const e = raw;
  const hex =
    typeof e.color === "string" && /^#?[0-9a-f]{6}$/i.test(e.color)
      ? e.color.replace("#", "").toLowerCase()
      : "5865f2";
  const embed: EmbedConfig = {
    title: text(e.title, 256, "Embed title"),
    description: text(e.description, 4096, "Embed description"),
    color: `#${hex}`,
    image: url(e.image, "Embed image"),
    thumbnail: url(e.thumbnail, "Embed thumbnail"),
    footer: text(e.footer, 2048, "Embed footer"),
  };
  if (!embed.title && !embed.description && !embed.image && !embed.thumbnail && !embed.footer) return null;
  return embed;
}

/** Turns untrusted request JSON into a clean MessageConfig (or throws). */
export function parseConfig(raw: unknown): MessageConfig {
  const r = isRecord(raw) ? raw : {};
  const content = text(r.content, 2000, "Message");
  const image = typeof r.image === "string" ? r.image : "";
  if (image && !isImageName(image)) throw new ConfigError("Invalid image, please upload it again");

  const embed = parseEmbed(r.embed);

  if (!content && !embed && !image) throw new ConfigError("Add a message, an embed or an image first");

  const rawButtons = Array.isArray(r.buttons) ? r.buttons : [];
  if (rawButtons.length > 25) throw new ConfigError("A message can have at most 25 buttons");

  const buttons = rawButtons.map((item, i): ButtonConfig => {
    const b = isRecord(item) ? item : {};
    const n = `Button ${i + 1}`;
    const label = text(b.label, 80, `${n} label`);
    const emoji = text(b.emoji, 64, `${n} emoji`);
    if (!label && !emoji) throw new ConfigError(`${n} needs a label or an emoji`);
    const roleId = text(b.roleId, 32, `${n} role`);
    if (!roleId) throw new ConfigError(`${n} needs a role`);

    return {
      label,
      emoji,
      roleId,
      style:
        typeof b.style === "string" && Object.hasOwn(STYLES, b.style)
          ? (b.style as ButtonColor)
          : "secondary",
      mode: MODES.includes(b.mode as ButtonMode) ? (b.mode as ButtonMode) : "toggle",
    };
  });

  return { content, image, embed, buttons };
}

/** Turns a MessageConfig into something discord.js can send or edit with. */
export function buildMessage(guild: Guild, config: MessageConfig): BaseMessageOptions {
  const seen = new Set<string>();

  const buttons = config.buttons.map((b, i) => {
    const role = guild.roles.cache.get(b.roleId);
    if (!role) throw new ConfigError(`Button ${i + 1}: that role doesn't exist anymore`);
    if (role.id === guild.id || role.managed || !role.editable) {
      throw new ConfigError(
        `Button ${i + 1}: I can't assign @${role.name}. Move my role above it in Server Settings → Roles.`,
      );
    }

    const customId = `role:${b.mode}:${role.id}`;
    if (seen.has(customId)) {
      throw new ConfigError(
        `Button ${i + 1}: @${role.name} is already used in ${b.mode} mode on this message`,
      );
    }
    seen.add(customId);

    const button = new ButtonBuilder().setCustomId(customId).setStyle(STYLES[b.style]);
    if (b.label) button.setLabel(b.label);
    if (b.emoji) button.setEmoji(b.emoji);
    return button;
  });

  // Discord allows 5 buttons per row.
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }

  const embeds: EmbedBuilder[] = [];
  if (config.embed) {
    const e = config.embed;
    const embed = new EmbedBuilder().setColor(parseInt(e.color.slice(1), 16));
    if (e.title) embed.setTitle(e.title);
    if (e.description) embed.setDescription(e.description);
    if (e.image) embed.setImage(e.image);
    if (e.thumbnail) embed.setThumbnail(e.thumbnail);
    if (e.footer) embed.setFooter({ text: e.footer });
    embeds.push(embed);
  }

  // Empty arrays / empty content also *clear* things when editing.
  return { content: config.content, embeds, components };
}
