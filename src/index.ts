import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBot, describeError, runBot } from "./bot.ts";
import { loadConfig, loadStorageConfig } from "./config.ts";
import { QueueStore } from "./queue.ts";

let database: DatabaseSync | undefined;
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const config = loadConfig(process.env);
  const storage = loadStorageConfig(process.env);
  mkdirSync(storage.stateDir, { recursive: true });
  mkdirSync(storage.downloadDir, { recursive: true });
  database = new DatabaseSync(join(storage.stateDir, "queue.sqlite"));
  const store = new QueueStore(
    database,
    storage.downloadDir,
    storage.maxPending,
  );
  store.recover();
  const bot = createBot(config, {}, { store });
  await runBot(bot, shutdown.signal);
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
} finally {
  database?.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
