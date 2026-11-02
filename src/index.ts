import "dotenv/config";
import { startWatcher } from "./alerts/watcher";
import { client } from "./bot";
import { registerLogger } from "./logging/logger";
import { registerMusic } from "./music/commands";
import { shutdownSessions } from "./music/session";
import { startServer } from "./server";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is missing from .env");

// A network hiccup should never take the whole bot (and its voice connection) down: log it and carry on.
client.on("error", (err) => console.error("[discord] client error:", err.message));
process.on("unhandledRejection", (reason) => console.error("[process] unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[process] uncaught error (the bot keeps running):", err));

// When the container is stopped or rebuilt, leave voice channels properly instead of leaving a ghost behind
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`Got ${signal}, shutting down…`);
    shutdownSessions("the bot is shutting down", "🔄 I'm restarting, so I left the voice channel. Add your songs again when I'm back.").finally(() => {
      void client.destroy();
      process.exit(0);
    });
  });
}

startServer();
startWatcher();
registerLogger();
registerMusic();

client.login(token).catch((err: Error) => {
  if (/intent/i.test(err.message)) {
    console.error(
      "\n❌ Discord refused the login because two privileged intents are switched off.\n" +
        "   Developer Portal → your app → Bot → Privileged Gateway Intents:\n" +
        "   turn ON 'Server Members Intent' and 'Message Content Intent', save, then start Rynata again.\n",
    );
  } else {
    console.error("Login failed:", err.message);
  }
  process.exit(1);
});
