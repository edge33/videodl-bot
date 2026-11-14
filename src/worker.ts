import { DownloadError } from "./process.ts";
import type { Job, QueueStore } from "./queue.ts";

export type Downloader = (job: Job, signal: AbortSignal) => Promise<string>;

export class QueueWorker {
  // JavaScript # members enforce runtime privacy for worker state and the inner loop.
  readonly #store: QueueStore;
  readonly #download: Downloader;
  #running: Promise<void> | undefined;
  #active: { id: number; controller: AbortController } | undefined;

  constructor(store: QueueStore, download: Downloader) {
    this.#store = store;
    this.#download = download;
  }

  drain(signal: AbortSignal): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#drain(signal).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  cancel(id: number): boolean {
    const cancelled = this.#store.cancel(id);
    if (this.#active?.id === id) this.#active.controller.abort();
    return cancelled;
  }

  async #drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = this.#store.claim();
      if (!job) return;
      const controller = new AbortController();
      this.#active = { id: job.id, controller };
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        const filename = await this.#download(job, controller.signal);
        if (!signal.aborted) this.#store.complete(job.id, filename);
      } catch (error) {
        if (!signal.aborted)
          this.#store.fail(
            job.id,
            error instanceof DownloadError ? error.message : undefined,
          );
      } finally {
        signal.removeEventListener("abort", stop);
        this.#active = undefined;
      }
      if (signal.aborted) this.#store.recover();
    }
  }
}
