import "dotenv/config";
import { startWatcher } from "./alerts/watcher";
import { client } from "./bot";
import { registerLogger } from "./logging/logger";
import { registerMusic } from "./music/commands";
import { startServer } from "./server";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is missing from .env");

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
