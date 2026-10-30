import { EmbedBuilder, escapeMarkdown } from "discord.js";
import type { RawTrack } from "./ytdlp";

export interface Track {
  id: number;
  title: string;
  artist: string;
  url: string | null; // null until a Spotify song has been matched on YouTube
  durationSec: number | null;
  thumbnail: string | null;
  live: boolean;
  requestedBy: string; // Discord user id
  source: "youtube" | "spotify" | "other";
  search?: string; // what to look for on YouTube (Spotify songs)
}

export const fmtTime = (sec: number | null, live = false) => {
  if (live) return "LIVE";
  if (sec === null) return "?";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plain = (s: string) => escapeMarkdown(s).replace(/[\[\]]/g, "");

/** The title as a link when we have an address, plain text otherwise. */
export const nameOf = (t: Pick<Track, "title" | "artist" | "url">, max = 70) => {
  const title = clip(plain(t.title), max);
  return t.url ? `[${title}](${t.url})` : title;
};

const COLOR = 0x5865f2;

export function nowPlayingEmbed(t: Track, positionSec: number | null, queued: number) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: "🎵 Now playing" })
    .setDescription(`**${nameOf(t, 100)}**${t.artist ? `\n${plain(t.artist)}` : ""}`)
    .addFields({ name: "Requested by", value: `<@${t.requestedBy}>`, inline: true });

  if (positionSec !== null && t.durationSec && !t.live) {
    const filled = Math.min(15, Math.round((positionSec / t.durationSec) * 15));
    embed.addFields({
      name: "Progress",
      value: `${"▬".repeat(filled)}🔘${"▬".repeat(15 - filled)}\n${fmtTime(positionSec)} / ${fmtTime(t.durationSec)}`,
    });
  } else {
    embed.addFields({ name: "Length", value: fmtTime(t.durationSec, t.live), inline: true });
  }
  if (queued) embed.setFooter({ text: `${queued} more in the queue` });
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  return embed;
}

/** Shown the moment a song is picked, until its audio actually starts. */
export function loadingEmbed(t: Track) {
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setAuthor({ name: "⏳ Loading…" })
    .setDescription(`**${nameOf(t, 100)}**${t.artist ? `\n${plain(t.artist)}` : ""}`)
    .addFields({ name: "Requested by", value: `<@${t.requestedBy}>`, inline: true });
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  return embed;
}

export function queuedEmbed(t: Track, position: number) {
  const embed = new EmbedBuilder()
    .setColor(0x23a55a)
    .setAuthor({ name: `✅ Added to the queue (#${position})` })
    .setDescription(`**${nameOf(t, 100)}**${t.artist ? `\n${plain(t.artist)}` : ""}`)
    .addFields({ name: "Length", value: fmtTime(t.durationSec, t.live), inline: true });
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  return embed;
}

export function playlistEmbed(title: string, added: number, read: number, total: number, thumbnail: string | null) {
  const notes = [];
  if (total > read) notes.push(`only the first ${read} of ${total} were read`);
  if (read > added) notes.push(`${read - added} skipped (unavailable, live, or too long)`);
  const embed = new EmbedBuilder()
    .setColor(0x23a55a)
    .setAuthor({ name: `✅ Queued ${added} track${added === 1 ? "" : "s"}` })
    .setDescription(`**${clip(plain(title), 150)}**${notes.length ? `\n*${notes.join("; ")}*` : ""}`);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

export function queueEmbed(current: Track | null, upcoming: Track[], page: number, loop: string) {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(upcoming.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const slice = upcoming.slice((p - 1) * perPage, p * perPage);
  const total = upcoming.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

  const embed = new EmbedBuilder().setColor(COLOR).setTitle("🎶 Queue");
  embed.addFields({ name: "Now playing", value: current ? `${nameOf(current, 80)} \`${fmtTime(current.durationSec, current.live)}\`` : "Nothing" });
  embed.addFields({
    name: "Up next",
    value: slice.length
      ? slice.map((t, i) => `\`${(p - 1) * perPage + i + 1}.\` ${nameOf(t, 60)} \`${fmtTime(t.durationSec, t.live)}\``).join("\n")
      : "*Nothing queued. Add songs with `ryn play`.*",
  });
  embed.setFooter({ text: `Page ${p}/${pages} · ${upcoming.length} queued · ${fmtTime(total)} total${loop !== "off" ? ` · loop: ${loop}` : ""}` });
  return embed;
}

export function searchEmbed(query: string, results: RawTrack[]) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🔎 Results for “${clip(plain(query), 80)}”`)
    .setDescription(
      results
        .map((r, i) => `**${i + 1}.** [${clip(plain(r.title), 70)}](${r.url})${r.artist ? ` – ${clip(plain(r.artist), 30)}` : ""} \`${fmtTime(r.durationSec, r.live)}\``)
        .join("\n"),
    )
    .setFooter({ text: "Pick one with the buttons below (60 seconds)" });
}

export function helpEmbed(prefix: string) {
  const c = (s: string) => `\`${prefix} ${s}\``;
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎵 Music commands")
    .setDescription(
      [
        `${c("play <link or song name>")} – play it, or add it to the queue. YouTube / Spotify / SoundCloud / Bandcamp links work. Playlists are queued whole, and a YouTube Mix link queues its first songs`,
        `${c("playnext <link or name>")} – put it first in the queue`,
        `${c("search <name>")} – pick from the top 5 results`,
        `${c("pause")} · ${c("resume")} · ${c("skip")} · ${c("skipto <n>")} · ${c("stop")}`,
        `${c("queue [page]")} · ${c("nowplaying")} · ${c("remove <n>")} · ${c("clear")} · ${c("shuffle")}`,
        `${c("loop [off|track|queue]")} · ${c("join")} · ${c("leave")}`,
        "",
        "Short forms: `p`, `s`, `q`, `np`, `dc`. Volume: right-click me in the voice channel.",
      ].join("\n"),
    );
}
