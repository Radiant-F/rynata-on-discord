import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";

// Guilds: servers, channels and roles. The rest is for the logger:
// GuildMessages + MessageContent = see message text, GuildMembers = see people join and leave.
// MessageContent and GuildMembers are "privileged": switch them on in the Developer Portal (Bot tab).
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, // lets the music player see who is in which voice channel
    GatewayIntentBits.MessageContent,
  ],
  // Lets us hear about edits/deletes of messages that were sent before we started, and about members we haven't cached
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✨ Logged in as ${c.user.tag}`);
});

// Button IDs look like "role:<toggle|give>:<roleId>", so they keep working
// after restarts without a database. Old "role:<roleId>" buttons still work too (= give).
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("role:")) return;
  if (!interaction.inCachedGuild()) return;

  const [, modeOrRole, maybeRole] = interaction.customId.split(":");
  const mode = maybeRole ? modeOrRole : "give";
  const roleId = maybeRole ?? modeOrRole;
  const role = interaction.guild.roles.cache.get(roleId);

  const reply = (content: string) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (!role || !role.editable || (mode !== "give" && mode !== "toggle")) {
    await reply("I can't hand out that role right now 😢");
    return;
  }

  const member = interaction.member;
  try {
    if (member.roles.cache.has(role.id)) {
      if (mode === "toggle") {
        await member.roles.remove(role, "Clicked a role button");
        await reply(`Removed **${role.name}** 👋`);
      } else {
        await reply(`You already have **${role.name}** 💖`);
      }
      return;
    }

    await member.roles.add(role, "Clicked a role button");
    await reply(`You got **${role.name}**! 🎉`);
  } catch (err) {
    console.error("Role button failed:", err);
    await reply("Something went wrong while updating your roles 😢");
  }
});
