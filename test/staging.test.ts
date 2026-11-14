import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { QueueStore } from "../src/queue.ts";
import { StagingFiles } from "../src/staging.ts";
import { QueueWorker } from "../src/worker.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "staging-"));
  const db = new DatabaseSync(":memory:");
  const store = new QueueStore(db, directory);
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  let source = 0;
  const enqueue = () => {
    const result = store.select(
      store.menu(`video${++source}`, 123, source),
      123,
      "mp3",
    );
    assert("job" in result);
    return result.job;
  };
  const stage = async (id: number) => {
    const path = join(directory, ".staging", String(id));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "partial"), "partial");
    return path;
  };
  const staging = new StagingFiles(directory, store);
  return { directory, store, enqueue, stage, staging };
}

test("cancelling a recovered queued job removes staging and preserves published files", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  f.store.claim();
  await f.stage(job.id);
  f.store.recover();
  await writeFile(join(f.directory, "published.mp3"), "published");
  const worker = new QueueWorker(
    f.store,
    async () => {
      throw new Error("must not download");
    },
    (id) => f.staging.remove(id),
  );
  assert.equal(await worker.cancel(job.id), true);
  assert.equal(await worker.cancel(job.id), false);
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
  assert.equal(
    await readFile(join(f.directory, "published.mp3"), "utf8"),
    "published",
  );
});

test("active cancellation waits for downloader exit before removing staging", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const path = await f.stage(job.id);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let exited = false;
  let cleaned = false;
  const worker = new QueueWorker(
    f.store,
    async (_job, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await release.promise;
      await writeFile(join(path, "last-write"), "done");
      exited = true;
      throw signal.reason;
    },
    async (id) => {
      assert(exited);
      await f.staging.remove(id);
      cleaned = true;
    },
  );
  const running = worker.drain(new AbortController().signal);
  await started.promise;
  const cancellation = worker.cancel(job.id);
  assert.equal(cleaned, false);
  release.resolve();
  await cancellation;
  await running;
  assert(cleaned);
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
});

test("startup sweep removes terminal staging and preserves queued, active, completed and unknown directories", async (t) => {
  const f = await fixture(t);
  const failed = f.enqueue();
  f.store.claim();
  f.store.fail(failed.id);
  const cancelled = f.enqueue();
  f.store.cancel(cancelled.id);
  const completed = f.enqueue();
  f.store.claim();
  f.store.complete(completed.id, "published.mp3");
  const active = f.enqueue();
  f.store.claim();
  const queued = f.enqueue();
  for (const job of [failed, cancelled, completed, active, queued])
    await f.stage(job.id);
  await f.stage(999);
  await mkdir(join(f.directory, ".staging", "notes"));
  await writeFile(join(f.directory, ".staging", "1.txt"), "keep");
  await writeFile(join(f.directory, "published.mp3"), "published");
  await f.staging.sweep();
  await f.staging.sweep();
  assert.deepEqual(
    (await readdir(join(f.directory, ".staging"))).sort(),
    [
      "1.txt",
      String(completed.id),
      String(active.id),
      String(queued.id),
      "999",
      "notes",
    ].sort(),
  );
  assert.equal(
    await readFile(join(f.directory, "published.mp3"), "utf8"),
    "published",
  );
});

test("sweep accepts absent staging and reports unreadable staging", async (t) => {
  const f = await fixture(t);
  await f.staging.sweep();
  await writeFile(join(f.directory, ".staging"), "file");
  await assert.rejects(f.staging.sweep(), { code: "ENOTDIR" });
});

test("cleanup failure retains cancellation and can be retried on startup", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  f.store.cancel(job.id);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  await writeFile(join(f.directory, ".staging"), "file");
  await f.staging.remove(job.id);
  assert.equal(warnings.length, 1);
  assert.equal(f.store.get(job.id)?.state, "cancelled");
  await rm(join(f.directory, ".staging"));
  await f.stage(job.id);
  await f.staging.sweep();
  assert.deepEqual(await readdir(join(f.directory, ".staging")), []);
});
