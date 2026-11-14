import { DownloadError } from "./process.ts";
import type { Job, QueueStore } from "./queue.ts";

export type Downloader = (job: Job, signal: AbortSignal) => Promise<string>;

export class QueueWorker {
  // JavaScript # members enforce runtime privacy for worker state and the inner loop.
  readonly #store: QueueStore;
  readonly #download: Downloader;
  readonly #cleanup: (id: number) => Promise<void>;
  #running: Promise<void> | undefined;
  #active:
    | { id: number; controller: AbortController; finished: Promise<void> }
    | undefined;

  constructor(
    store: QueueStore,
    download: Downloader,
    cleanup: (id: number) => Promise<void> = async () => {},
  ) {
    this.#store = store;
    this.#download = download;
    this.#cleanup = cleanup;
  }

  drain(signal: AbortSignal): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#drain(signal).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async cancel(id: number): Promise<boolean> {
    const cancelled = this.#store.cancel(id);
    const active = this.#active;
    if (active?.id === id) {
      active.controller.abort();
      await active.finished;
    } else if (cancelled) {
      await this.#cleanup(id);
    }
    return cancelled;
  }

  async #drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = this.#store.claim();
      if (!job) return;
      const controller = new AbortController();
      const finished = Promise.withResolvers<void>();
      this.#active = { id: job.id, controller, finished: finished.promise };
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
        const state = this.#store.get(job.id)?.state;
        if (state === "failed" || state === "cancelled")
          await this.#cleanup(job.id);
        this.#active = undefined;
        finished.resolve();
      }
      if (signal.aborted) this.#store.recover();
    }
  }
}
