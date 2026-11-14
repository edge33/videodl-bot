import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, describeError, runBot } from "./bot.ts";
import { loadConfig, loadDownloadLimits, loadStorageConfig } from "./config.ts";
import { createDownloader } from "./downloader.ts";
import { JobNotifications } from "./notifications.ts";
import { QueueStore } from "./queue.ts";
import { StagingFiles } from "./staging.ts";
import { QueueWorker } from "./worker.ts";

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
  const staging = new StagingFiles(storage.downloadDir, store);
  await staging.sweep();
  const limits = loadDownloadLimits(process.env);
  let bot: ReturnType<typeof createBot>;
  const notifications = new JobNotifications(store, (chat, message, text) =>
    bot.api.editMessageText(chat, message, text),
  );
  const worker = new QueueWorker(
    store,
    createDownloader({
      directory: storage.downloadDir,
      store,
      limits,
      progress: (job, text) => notifications.progress(job, text),
    }),
    (id) => staging.remove(id),
  );
  bot = createBot(config, {}, { store, worker });
  const background = (async () => {
    while (!shutdown.signal.aborted) {
      const running = worker.drain(shutdown.signal);
      await notifications.flush();
      await Promise.race([running, delay(250)]);
      await delay(250);
    }
    await worker.drain(shutdown.signal);
  })();
  // A background failure stops polling and is propagated after all work settles.
  void background.catch(() => shutdown.abort());
  try {
    await runBot(bot, shutdown.signal);
  } finally {
    shutdown.abort();
    try {
      await background;
    } finally {
      await worker.drain(shutdown.signal);
    }
  }
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
} finally {
  database?.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
