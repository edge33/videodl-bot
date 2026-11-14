import { createBot, describeError, runBot } from "./bot.ts";
import { loadConfig } from "./config.ts";

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const bot = createBot(loadConfig(process.env));
  await runBot(bot, shutdown.signal);
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
