import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ChannelType, DiscordAPIError, type Guild, type MessageEditOptions, type TextChannel } from "discord.js";
import { getSettings, saveSettings } from "./alerts/alertStore";
import { parseSettings } from "./alerts/parse";
import {
  checkTwitchUser,
  PlatformError,
  resolveYouTubeChannel,
  twitchConfigured,
  youtubeConfigured,
} from "./alerts/platforms";
import type { AlertSettings } from "./alerts/types";
import { forgetSession, getStatus, sendTestAlert } from "./alerts/watcher";
import { client } from "./bot";
import { getLogSettings, saveLogSettings } from "./logging/logStore";
import { getLogStatus, missingPostPermissions, sendTestLogs, warmMembers } from "./logging/logger";
import { parseLogSettings } from "./logging/parse";
import { imageAttachment, MAX_IMAGE_BYTES, pruneImage, readImage, saveImage, sweepImages } from "./images";
import { buildMessage, ConfigError, isImageName, parseConfig, type MessageConfig } from "./messageBuilder";
import { getMessage, listMessages, removeMessage, saveMessage } from "./store";

const UNKNOWN_MESSAGE = 10008;

function fail(res: express.Response, err: unknown) {
  if (err instanceof ConfigError || err instanceof PlatformError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof DiscordAPIError) {
    res.status(err.code === UNKNOWN_MESSAGE ? 404 : 400).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
}

/** Posts a config to a channel and remembers it in the sent list. */
async function sendConfig(guild: Guild, channel: TextChannel, config: MessageConfig) {
  const message = await channel.send({
    ...buildMessage(guild, config),
    files: config.image ? [imageAttachment(config.image)] : [],
  });

  const now = new Date().toISOString();
  saveMessage({
    messageId: message.id,
    guildId: guild.id,
    channelId: channel.id,
    config,
    createdAt: now,
    updatedAt: now,
  });
  return message;
}

/** Checks the Twitch/YouTube names against the real APIs (when the keys are in .env). */
async function resolveTargets(s: AlertSettings): Promise<string[]> {
  const warnings: string[] = [];

  if (s.twitchLogin) {
    if (twitchConfigured()) await checkTwitchUser(s.twitchLogin);
    else warnings.push("Twitch keys aren't in .env yet, so I couldn't check the Twitch name.");
  }

  if (s.youtubeChannelId) {
    if (youtubeConfigured()) {
      const channel = await resolveYouTubeChannel(s.youtubeChannelId);
      s.youtubeChannelId = channel.id;
      s.youtubeName = channel.title;
    } else if (/^UC[\w-]{22}$/.test(s.youtubeChannelId)) {
      warnings.push("YOUTUBE_API_KEY isn't in .env yet, so I couldn't check the YouTube channel.");
    } else {
      throw new ConfigError(
        "To look up a @handle I need YOUTUBE_API_KEY in .env. Add it, or paste the channel ID (starts with UC) instead.",
      );
    }
  }
  return warnings;
}

export function startServer() {
  const password = process.env.WEB_PASSWORD;
  if (!password) throw new Error("WEB_PASSWORD is missing from .env");

  sweepImages();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "public")));

  // Auth: every API call must send the password header. Compared in constant time,
  // and an address that guesses wrong too often is locked out for a while.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const expected = digest(password);
  const MAX_FAILS = 10;
  const WINDOW_MS = 10 * 60_000;
  const failures = new Map<string, { count: number; first: number; blockedUntil: number }>();

  app.use("/api", (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const record = failures.get(ip);

    if (record && record.blockedUntil > now) {
      res.status(429).json({ error: "Too many wrong passwords. Try again in a few minutes." });
      return;
    }

    if (!timingSafeEqual(digest(req.header("x-password") ?? ""), expected)) {
      const current = record && now - record.first < WINDOW_MS ? record : { count: 0, first: now, blockedUntil: 0 };
      current.count++;
      if (current.count >= MAX_FAILS) current.blockedUntil = now + WINDOW_MS;
      failures.set(ip, current);
      for (const [key, r] of failures) if (now - r.first > WINDOW_MS && r.blockedUntil < now) failures.delete(key);
      res.status(401).json({ error: "Wrong password" });
      return;
    }

    failures.delete(ip);
    next();
  });

  // Servers the bot is in
  app.get("/api/guilds", (_req, res) => {
    res.json(client.guilds.cache.map((g) => ({ id: g.id, name: g.name })));
  });

  // Channels + assignable roles for one server
  app.get("/api/guilds/:guildId/info", (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name }));

    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed && r.editable)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));

    // Any role can be pinged, even ones I couldn't hand out
    const allRoles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));

    // For the logger's "ignore these" list: categories and every channel that can hold messages
    const categories = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ id: c.id, name: c.name }));
    const messageTypes = new Set<ChannelType>([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildVoice,
    ]);
    const messageChannels = guild.channels.cache
      .filter((c) => messageTypes.has(c.type))
      .map((c) => ({ id: c.id, name: c.name }));

    res.json({ channels, roles, allRoles, categories, messageChannels });
  });

  // Upload the (single) image for a message. The body is the raw image file.
  app.post("/api/images", express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new ConfigError("Send a PNG, JPG, GIF or WEBP image");
      res.json({ image: saveImage(req.body) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Fetch an uploaded image (for the preview)
  app.get("/api/images/:name", (req, res) => {
    const buf = isImageName(req.params.name) ? readImage(req.params.name) : null;
    if (!buf) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    res.type(path.extname(req.params.name)).send(buf);
  });

  // Messages the panel has sent (newest first)
  app.get("/api/messages", (req, res) => {
    const guildId = typeof req.query.guildId === "string" ? req.query.guildId : undefined;

    const items = listMessages()
      .filter((m) => !guildId || m.guildId === guildId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((m) => ({
        ...m,
        channelName: client.guilds.cache.get(m.guildId)?.channels.cache.get(m.channelId)?.name ?? "unknown",
        url: `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.messageId}`,
      }));

    res.json(items);
  });

  // Send a new message
  app.post("/api/messages", async (req, res) => {
    try {
      const guild = client.guilds.cache.get(String(req.body?.guildId));
      const channel = guild?.channels.cache.get(String(req.body?.channelId));
      if (!guild || !channel || channel.type !== ChannelType.GuildText) {
        throw new ConfigError("Pick a valid server and channel");
      }

      const message = await sendConfig(guild, channel, parseConfig(req.body?.config));
      res.json({ ok: true, messageId: message.id });
    } catch (err) {
      fail(res, err);
    }
  });

  // Send a copy of an already-sent message to another channel (same server)
  app.post("/api/messages/:messageId/copy", async (req, res) => {
    const stored = getMessage(req.params.messageId);
    if (!stored) {
      res.status(404).json({ error: "I don't know that message" });
      return;
    }

    try {
      const guild = client.guilds.cache.get(stored.guildId);
      const channel = guild?.channels.cache.get(String(req.body?.channelId));
      if (!guild || !channel || channel.type !== ChannelType.GuildText) {
        throw new ConfigError("Pick a valid channel");
      }

      // parseConfig also upgrades messages saved by older versions of the panel
      const message = await sendConfig(guild, channel, parseConfig(stored.config));
      res.json({
        ok: true,
        messageId: message.id,
        url: `https://discord.com/channels/${guild.id}/${channel.id}/${message.id}`,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Edit a message that was already sent
  app.put("/api/messages/:messageId", async (req, res) => {
    const stored = getMessage(req.params.messageId);
    if (!stored) {
      res.status(404).json({ error: "I don't know that message" });
      return;
    }

    try {
      const guild = client.guilds.cache.get(stored.guildId);
      const channel = guild?.channels.cache.get(stored.channelId);
      if (!guild || !channel || channel.type !== ChannelType.GuildText) {
        throw new ConfigError("I can't reach that channel anymore");
      }

      const config = parseConfig(req.body?.config);
      const previousImage = stored.config.image ?? "";
      const message = await channel.messages.fetch(stored.messageId);

      const edit: MessageEditOptions = { ...buildMessage(guild, config) };
      if (config.image !== previousImage) {
        // Not mentioning attachments keeps the old one; an empty list removes it.
        edit.attachments = [];
        edit.files = config.image ? [imageAttachment(config.image)] : [];
      }
      await message.edit(edit);

      saveMessage({ ...stored, config, updatedAt: new Date().toISOString() });
      if (config.image !== previousImage) pruneImage(previousImage);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === UNKNOWN_MESSAGE) {
        removeMessage(stored.messageId);
        pruneImage(stored.config.image);
        res.status(404).json({ error: "That message was deleted on Discord, so I removed it from the list" });
        return;
      }
      fail(res, err);
    }
  });

  // Delete a message from Discord and from the list
  app.delete("/api/messages/:messageId", async (req, res) => {
    const stored = getMessage(req.params.messageId);
    if (!stored) {
      res.status(404).json({ error: "I don't know that message" });
      return;
    }

    try {
      const channel = client.guilds.cache.get(stored.guildId)?.channels.cache.get(stored.channelId);
      if (channel?.type === ChannelType.GuildText) {
        await channel.messages.delete(stored.messageId).catch((err) => {
          if (!(err instanceof DiscordAPIError && err.code === UNKNOWN_MESSAGE)) throw err;
        });
      }
      removeMessage(stored.messageId);
      pruneImage(stored.config.image);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Stream alerts ----

  app.get("/api/alerts/:guildId", (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const settings = getSettings(guild.id);
    res.json({
      settings,
      status: getStatus(guild.id, settings),
      credentials: { twitch: twitchConfigured(), youtube: youtubeConfigured() },
    });
  });

  app.put("/api/alerts/:guildId", async (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) throw new ConfigError("Server not found");

      const settings = parseSettings(req.body?.settings);
      const channel = guild.channels.cache.get(settings.channelId);
      if (settings.channelId && channel?.type !== ChannelType.GuildText) {
        throw new ConfigError("Pick a valid channel");
      }
      if (settings.mention.type === "role" && !guild.roles.cache.has(settings.mention.roleId)) {
        throw new ConfigError("That role doesn't exist anymore");
      }
      if (settings.enabled) {
        if (!settings.channelId) throw new ConfigError("Pick a channel for the alerts first");
        if (!settings.twitchLogin && !settings.youtubeChannelId) {
          throw new ConfigError("Add your Twitch name or your YouTube channel (or both) first");
        }
      }

      const warnings = await resolveTargets(settings);
      saveSettings(guild.id, settings);
      res.json({ settings, warnings, status: getStatus(guild.id, settings) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/alerts/:guildId/test", async (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) throw new ConfigError("Server not found");
      const message = await sendTestAlert(guild, getSettings(guild.id));
      res.json({ ok: true, url: message.url });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/alerts/:guildId/session", (req, res) => {
    forgetSession(req.params.guildId);
    res.json({ ok: true });
  });

  // ---- Message & member logs ----

  app.get("/api/logs/:guildId", (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({ settings: getLogSettings(guild.id), status: getLogStatus(guild.id) });
  });

  app.put("/api/logs/:guildId", (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) throw new ConfigError("Server not found");

      const s = parseLogSettings(req.body?.settings);
      for (const id of [s.messageChannelId, s.memberChannelId]) {
        if (id && guild.channels.cache.get(id)?.type !== ChannelType.GuildText) {
          throw new ConfigError("Pick a valid log channel");
        }
      }
      s.ignoredChannelIds = s.ignoredChannelIds.filter((id) => guild.channels.cache.has(id));

      if (s.enabled) {
        if ((s.events.delete || s.events.edit) && !s.messageChannelId) {
          throw new ConfigError("Pick a message log channel for deleted/edited messages");
        }
        if ((s.events.join || s.events.leave) && !(s.memberChannelId || s.messageChannelId)) {
          throw new ConfigError("Pick a member log channel (or a message log channel to share)");
        }
      }

      const warnings = [...new Set([s.messageChannelId, s.memberChannelId].filter(Boolean))].flatMap((id) => {
        const missing = missingPostPermissions(guild, id);
        return missing.length ? [`I'm missing ${missing.join(", ")} in #${guild.channels.cache.get(id)?.name}.`] : [];
      });

      saveLogSettings(guild.id, s);
      warmMembers(guild);
      res.json({ settings: s, warnings, status: getLogStatus(guild.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/logs/:guildId/test", async (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) throw new ConfigError("Server not found");
      await sendTestLogs(guild, getLogSettings(guild.id));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Turns body-parser problems (like an oversized upload) into JSON the panel can show
  const onError: express.ErrorRequestHandler = (err, _req, res, _next) => {
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: "That image is too big (max 10 MB)" });
    } else if (status && status < 500) {
      res.status(status).json({ error: "Bad request" });
    } else {
      console.error(err);
      res.status(500).json({ error: "Something went wrong" });
    }
  };
  app.use(onError);

  const port = Number(process.env.PORT) || 3000;
  // 127.0.0.1 = only this machine can open the panel. Set HOST=0.0.0.0 to open it from other devices on your network.
  const host = process.env.HOST || "127.0.0.1";
  app.listen(port, host, () => {
    if (host === "127.0.0.1" || host === "localhost") {
      console.log(`🌐 Web client: http://localhost:${port} (this machine only)`);
      return;
    }
    console.log(`🌐 Web client is open to your network on port ${port}`);
    if (!fs.existsSync("/.dockerenv")) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) {
          if (a.family === "IPv4" && !a.internal) console.log(`   Open it from another computer: http://${a.address}:${port}`);
        }
      }
    }
  });
}
