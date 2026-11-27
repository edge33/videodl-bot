import { mkdirSync } from "node:fs";
import { createBot, describeError, runBot } from "./bot.ts";
import { loadConfig, loadDownloadLimits, loadStorageConfig } from "./config.ts";
import { DownloadSession } from "./download-session.ts";
import { createDownloader } from "./downloader.ts";

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let downloads: DownloadSession | undefined;
try {
  const config = loadConfig(process.env);
  const storage = loadStorageConfig(process.env);
  mkdirSync(storage.downloadDir, { recursive: true });
  downloads = new DownloadSession(
    createDownloader({
      directory: storage.downloadDir,
      limits: loadDownloadLimits(process.env),
    }),
  );
  const bot = createBot(config, {}, downloads);
  // Stop media processes immediately on shutdown, before polling finishes.
  shutdown.signal.addEventListener("abort", () => downloads?.cancel(), {
    once: true,
  });
  await runBot(bot, shutdown.signal);
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
} finally {
  await downloads?.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
