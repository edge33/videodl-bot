import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type Job, QueueStore } from "../src/queue.ts";
import { QueueWorker } from "../src/worker.ts";

function fixture(t: TestContext, maxPending?: number) {
  const directory = mkdtempSync(join(tmpdir(), "videodl-queue-"));
  const path = join(directory, "queue.sqlite");
  const db = new DatabaseSync(path);
  const store = new QueueStore(db, directory, maxPending);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, db, path, directory };
}

let source = 0;
function enqueue(
  store: QueueStore,
  videoId = "abcDEF_12-3",
  format: Job["format"] = "mp3",
) {
  const result = store.select(store.menu(videoId, 123, ++source), 123, format);
  assert.equal(result.kind, "queued");
  assert("job" in result);
  return result.job;
}

test("menus are durable, scoped to their chat, replay-safe, and consumed once", (t) => {
  const { store, path, directory } = fixture(t);
  const menu = store.menu("abcDEF_12-3", 123, 10);
  assert.equal(store.menu("abcDEF_12-3", 123, 10), menu);
  assert.deepEqual(store.select(menu, 999, "mp3"), { kind: "unavailable" });
  assert.deepEqual(store.select(999, 123, "mp3"), { kind: "unavailable" });
  const db2 = new DatabaseSync(path);
  const other = new QueueStore(db2, directory);
  t.after(() => db2.close());
  const selected = other.select(menu, 123, "mp4_720");
  assert.equal(selected.kind, "queued");
  assert.deepEqual(store.select(menu, 123, "mp4_1080"), {
    kind: "unavailable",
  });
  assert.equal(store.list(true).length, 1);
  assert.equal(store.list()[0]?.format, "mp4_720");
});

test("deduplicates pending and active jobs while keeping formats independent", (t) => {
  const { store } = fixture(t);
  const first = enqueue(store);
  let selected = store.select(
    store.menu(first.video_id, 123, ++source),
    123,
    "mp3",
  );
  assert.equal(selected.kind, "shared");
  assert("job" in selected);
  assert.equal(selected.job.id, first.id);
  assert.equal(store.claim()?.id, first.id);
  selected = store.select(
    store.menu(first.video_id, 123, ++source),
    123,
    "mp3",
  );
  assert.equal(selected.kind, "shared");
  enqueue(store, first.video_id, "mp4_1080");
  assert.equal(store.list(true).length, 2);
});

test("reuses an existing completed file and redownloads removed files or directories", (t) => {
  const { store, directory, db } = fixture(t);
  const first = enqueue(store);
  store.claim();
  writeFileSync(join(directory, "video.mp3"), "fixture");
  store.complete(first.id, "video.mp3");
  const selected = store.select(
    store.menu(first.video_id, 123, ++source),
    123,
    "mp3",
  );
  assert.equal(selected.kind, "completed");
  assert("job" in selected);
  assert.equal(selected.job.filename, "video.mp3");
  rmSync(join(directory, "video.mp3"));
  const second = enqueue(store);
  store.claim();
  mkdirSync(join(directory, "directory.mp3"));
  store.complete(second.id, "directory.mp3");
  const third = enqueue(store);
  store.claim();
  // A legacy/incomplete record without a filename cannot be reused.
  db.prepare(
    "UPDATE jobs SET state = 'completed', filename = NULL WHERE id = ?",
  ).run(third.id);
  enqueue(store);
});

test("enforces pending capacity independently of the active slot and retains full menus", (t) => {
  const { store } = fixture(t, 1);
  const first = enqueue(store);
  const menu = store.menu("anotherId_1", 123, ++source);
  assert.deepEqual(store.select(menu, 123, "mp3"), { kind: "full" });
  assert.equal(store.claim()?.id, first.id);
  assert.equal(store.select(menu, 123, "mp3").kind, "queued");
  assert.equal(store.claim(), undefined);
  assert.equal(store.list(true)[0]?.state, "active");
});

test("selection rolls back menu consumption and job creation on database errors", (t) => {
  const { store, db } = fixture(t);
  const menu = store.menu("abcDEF_12-3", 123, ++source);
  db.exec(
    "CREATE TRIGGER reject_menu BEFORE UPDATE OF consumed ON menus BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  assert.throws(() => store.select(menu, 123, "mp3"), /fixture/);
  assert.deepEqual(store.list(), []);
  db.exec("DROP TRIGGER reject_menu");
  assert.equal(store.select(menu, 123, "mp3").kind, "queued");
});

test("persists status references, retry counts, outcomes, and claims across connections", (t) => {
  const { store, db, path, directory } = fixture(t);
  const first = enqueue(store);
  const second = enqueue(store, "anotherId_1");
  store.claim();
  store.statusMessage(first.id, 123, 456);
  db.prepare("UPDATE jobs SET retry_count = 2 WHERE id = ?").run(first.id);
  const db2 = new DatabaseSync(path);
  const reopened = new QueueStore(db2, directory);
  t.after(() => db2.close());
  assert.equal(reopened.claim(), undefined);
  reopened.recover();
  assert.equal(reopened.claim()?.id, first.id);
  assert.equal(reopened.get(first.id)?.retry_count, 2);
  assert.equal(reopened.get(first.id)?.status_message_id, 456);
  assert.equal(reopened.get(first.id)?.status_chat_id, 123);
  assert.equal(reopened.get(second.id)?.state, "queued");
  reopened.fail(first.id);
  assert.equal(reopened.get(first.id)?.outcome, "Download failed.");
  assert.equal(reopened.claim()?.id, second.id);
  assert.equal(reopened.cancel(second.id), true);
  reopened.recover();
  assert.equal(reopened.get(second.id)?.state, "cancelled");
});

test("cancellation is idempotent, terminal jobs stay terminal, and filenames stay inside output", (t) => {
  const { store } = fixture(t);
  const first = enqueue(store);
  assert.equal(store.cancel(first.id), true);
  assert.equal(store.cancel(first.id), false);
  assert.equal(store.cancel(999), false);
  assert.equal(store.get(999), undefined);
  store.complete(first.id, "ok.mp3");
  store.fail(first.id);
  assert.equal(store.get(first.id)?.state, "cancelled");
  const second = enqueue(store);
  store.claim();
  for (const name of ["", ".", "..", "../out.mp3", "/tmp/out.mp3"]) {
    assert.throws(() => store.complete(second.id, name), /filename/);
  }
  store.complete(second.id, "ok.mp3");
  assert.equal(store.cancel(second.id), false);
  assert.equal(store.get(second.id)?.state, "completed");
});

test("worker runs one job at a time, shares concurrent drains, and continues after failure", async (t) => {
  const { store } = fixture(t);
  const jobs = [
    enqueue(store),
    enqueue(store, "anotherId_1"),
    enqueue(store, "thirdVideo1"),
  ];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: number[] = [];
  const worker = new QueueWorker(store, async (job) => {
    seen.push(job.id);
    if (job.id === jobs[0]?.id) {
      started.resolve();
      await release.promise;
      throw new Error("secret error");
    }
    return `fixture-${job.id}.mp3`;
  });
  const signal = new AbortController().signal;
  const running = worker.drain(signal);
  await started.promise;
  assert.equal(worker.drain(signal), running);
  assert.equal(
    store.list(true).filter((job) => job.state === "active").length,
    1,
  );
  assert.deepEqual(seen, [jobs[0]?.id]);
  release.resolve();
  await running;
  assert.deepEqual(
    seen,
    jobs.map((job) => job.id),
  );
  assert(jobs[0]);
  assert(jobs[1]);
  assert.equal(store.get(jobs[0].id)?.outcome, "Download failed.");
  assert.equal(store.get(jobs[1].id)?.state, "completed");
  await worker.drain(signal);
});

test("worker cancellation aborts active work and does not mark cancelled work completed", async (t) => {
  const { store } = fixture(t);
  const active = enqueue(store);
  const queued = enqueue(store, "anotherId_1");
  const started = Promise.withResolvers<AbortSignal>();
  const worker = new QueueWorker(store, async (_job, signal) => {
    started.resolve(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "ignored.mp3";
  });
  const running = worker.drain(new AbortController().signal);
  const signal = await started.promise;
  assert.equal(worker.cancel(queued.id), true);
  assert.equal(worker.cancel(active.id), true);
  assert.equal(signal.aborted, true);
  await running;
  assert.equal(worker.cancel(999), false);
  assert.equal(store.get(active.id)?.state, "cancelled");
  assert.equal(store.get(queued.id)?.state, "cancelled");
});

test("worker shutdown aborts its fixture and requeues interrupted work for restart", async (t) => {
  const { store } = fixture(t);
  const job = enqueue(store);
  const started = Promise.withResolvers<void>();
  const worker = new QueueWorker(store, async (_job, signal) => {
    started.resolve();
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("interrupted")), {
        once: true,
      }),
    );
    return "unreachable.mp3";
  });
  const shutdown = new AbortController();
  const running = worker.drain(shutdown.signal);
  await started.promise;
  shutdown.abort();
  await running;
  assert.equal(store.get(job.id)?.state, "queued");
  assert.equal(store.get(job.id)?.outcome, "Interrupted; waiting to resume.");
  await worker.drain(shutdown.signal);
});

test("shutdown also preserves work when a downloader resolves after abort", async (t) => {
  const { store } = fixture(t);
  const job = enqueue(store);
  const shutdown = new AbortController();
  const worker = new QueueWorker(store, async () => {
    shutdown.abort();
    return "interrupted.mp3";
  });
  await worker.drain(shutdown.signal);
  assert.equal(store.get(job.id)?.state, "queued");
});

test("a database closed and reopened preserves menus, terminal history, and queued work", (t) => {
  const { store, db, path, directory } = fixture(t);
  const first = enqueue(store);
  const waiting = enqueue(store, "anotherId_1");
  const unusedMenu = store.menu("thirdVideo1", 123, ++source);
  const terminal = enqueue(store, "fourthVideo");
  store.cancel(terminal.id);
  store.claim();
  db.close();
  const reopenedDb = new DatabaseSync(path);
  t.after(() => reopenedDb.close());
  const reopened = new QueueStore(reopenedDb, directory);
  reopened.recover();
  assert.equal(reopened.get(first.id)?.state, "queued");
  assert.equal(reopened.get(waiting.id)?.state, "queued");
  assert.equal(reopened.get(terminal.id)?.state, "cancelled");
  assert.equal(reopened.claim()?.id, first.id);
  assert.equal(reopened.select(unusedMenu, 123, "mp4_720").kind, "queued");
});
