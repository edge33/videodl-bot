import { GrammyError, HttpError } from "grammy";
import type { Job, QueueStore } from "./queue.ts";

export class JobNotifications {
  readonly #store: QueueStore;
  readonly #edit: (
    chat: number,
    message: number,
    text: string,
  ) => Promise<unknown>;
  readonly #now: () => number;
  readonly #progress = new Map<number, string>();

  constructor(
    store: QueueStore,
    edit: (chat: number, message: number, text: string) => Promise<unknown>,
    now = Date.now,
  ) {
    this.#store = store;
    this.#edit = edit;
    this.#now = now;
  }

  progress(job: Job, text: string): void {
    this.#progress.set(job.id, text);
  }

  async flush(): Promise<void> {
    const pending = this.#store.list(true);
    for (const job of this.#store.notificationJobs()) {
      let detail: string;
      if (job.state === "queued")
        detail = `Queue position ${pending.findIndex((p) => p.id === job.id) + 1}.`;
      else if (job.state === "active")
        detail = this.#progress.get(job.id) ?? "Starting download.";
      else {
        detail = (
          job.state === "completed" ? job.filename : job.outcome
        ) as string;
        this.#progress.delete(job.id);
      }
      const text = `#${job.id} ${job.state} — ${detail}`;
      const now = this.#now();
      if (
        text === job.notified_text ||
        now - (job.attempted_at ?? -10000) < 10000
      )
        continue;
      // Persist the attempt before I/O, so restarts preserve the rate limit.
      this.#store.notificationAttempt(job.id, job.notified_text ?? "", now);
      try {
        await this.#edit(
          job.status_chat_id as number,
          job.status_message_id as number,
          text,
        );
      } catch (error) {
        if (
          error instanceof HttpError ||
          (error instanceof GrammyError &&
            (error.error_code === 429 || error.error_code >= 500))
        )
          continue;
        // Permanent errors (e.g. deleted message) must not spin forever.
      }
      this.#store.notificationAttempt(job.id, text, now);
    }
  }
}
