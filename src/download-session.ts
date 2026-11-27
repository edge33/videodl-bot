import type { Downloader, DownloadRequest } from "./downloader.ts";
import { DownloadError } from "./process.ts";

export class DownloadSession {
  readonly #download: Downloader;
  #active: { controller: AbortController; finished: Promise<void> } | undefined;

  constructor(download: Downloader) {
    this.#download = download;
  }

  get busy(): boolean {
    return this.#active !== undefined;
  }

  start(
    request: DownloadRequest,
    reply: (text: string) => Promise<unknown>,
    update?: (text: string) => Promise<unknown>,
    removeStatus?: () => Promise<unknown>,
  ): boolean {
    if (this.#active) return false;
    const controller = new AbortController();
    // Defer execution until the active slot is reserved, before Telegram I/O.
    const finished = Promise.resolve().then(async () => {
      try {
        await reply("Download and converting");
        let filename: string;
        let lastUpdate = -Infinity;
        let pending: Promise<unknown> | undefined;
        const progress = (text: string) => {
          if (!update || pending || Date.now() - lastUpdate < 10000) return;
          lastUpdate = Date.now();
          pending = update(text)
            .catch(() => console.error("Could not update download progress."))
            .finally(() => {
              pending = undefined;
            });
        };
        try {
          try {
            controller.signal.throwIfAborted();
            filename = await this.#download(
              request,
              controller.signal,
              progress,
            );
          } finally {
            await pending;
            await removeStatus?.().catch(() => {
              console.error("Could not delete download status.");
            });
          }
        } catch (error) {
          await reply(
            controller.signal.aborted
              ? "Download cancelled."
              : error instanceof DownloadError
                ? `Download failed: ${error.message}`
                : "Download failed. Check the server logs.",
          );
          return;
        }
        await reply(`Done: ${filename}`);
      } catch {
        // Raw Telegram errors can contain credentials and private payloads.
        console.error("Could not send download status to Telegram.");
      } finally {
        this.#active = undefined;
      }
    });
    this.#active = { controller, finished };
    return true;
  }

  cancel(): boolean {
    if (!this.#active) return false;
    this.#active.controller.abort();
    return true;
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.#active?.finished;
  }
}
