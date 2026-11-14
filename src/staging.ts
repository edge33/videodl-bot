import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { QueueStore } from "./queue.ts";

export class StagingFiles {
  readonly #root: string;
  readonly #store: QueueStore;

  constructor(directory: string, store: QueueStore) {
    this.#root = join(directory, ".staging");
    this.#store = store;
  }

  async remove(id: number): Promise<void> {
    try {
      await rm(join(this.#root, String(id)), { recursive: true, force: true });
    } catch {
      // The terminal state remains durable; startup will retry this cleanup.
      console.warn(
        "Could not remove terminal job staging; retrying on next startup.",
      );
    }
  }

  async sweep(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
      const job = this.#store.get(Number(entry.name));
      if (job?.state === "failed" || job?.state === "cancelled")
        await this.remove(job.id);
    }
  }
}
