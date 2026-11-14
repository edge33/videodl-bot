import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import { JobNotifications } from "../src/notifications.ts";
import { type Job, QueueStore } from "../src/queue.ts";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new QueueStore(db, "/tmp");
  store.select(store.menu("abcDEF_12-3", 123, 1), 123, "mp3");
  store.statusMessage(1, 123, 456);
  return { store };
}

test("edits one message with queue, progress, and final filename, respecting rate limits", async (t) => {
  const { store } = fixture(t);
  let now = 0;
  const edits: string[] = [];
  const notify = new JobNotifications(
    store,
    async (chat, message, text) => {
      assert.equal(chat, 123);
      assert.equal(message, 456);
      edits.push(text);
    },
    () => now,
  );
  await notify.flush();
  await notify.flush();
  const job = store.claim() as Job;
  now = 1000;
  await notify.flush();
  assert.equal(edits.length, 1);
  now = 10000;
  await notify.flush();
  assert.match(edits.at(-1) as string, /Starting/);
  notify.progress(job, "Downloading 50%.");
  now = 20000;
  await notify.flush();
  assert.match(edits.at(-1) as string, /50%/);
  store.complete(1, "video.mp3");
  now = 30000;
  await notify.flush();
  assert.match(edits.at(-1) as string, /video.mp3/);
  await notify.flush();
  assert.equal(edits.length, 4);
});

test("terminal failures report their durable outcome", async (t) => {
  const { store } = fixture(t);
  store.cancel(1);
  const edits: string[] = [];
  await new JobNotifications(store, async (_c, _m, text) =>
    edits.push(text),
  ).flush();
  assert.match(edits[0] as string, /Cancelled by owner/);
});

for (const error of [
  new HttpError("transport", new Error("secret")),
  new GrammyError(
    "rate",
    { ok: false, error_code: 429, description: "rate" },
    "editMessageText",
    {},
  ),
  new GrammyError(
    "server",
    { ok: false, error_code: 503, description: "server" },
    "editMessageText",
    {},
  ),
]) {
  test(`retries transient notification failure ${error.message} across notifier restarts`, async (t) => {
    const { store } = fixture(t);
    let calls = 0;
    await new JobNotifications(
      store,
      async () => {
        calls++;
        throw error;
      },
      () => 0,
    ).flush();
    const restarted = new JobNotifications(
      store,
      async () => {
        calls++;
      },
      () => 10000,
    );
    await restarted.flush();
    await restarted.flush();
    assert.equal(calls, 2);
    assert.equal(store.get(1)?.state, "queued");
  });
}

test("permanent notification errors do not cause repeated attempts", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const notify = new JobNotifications(store, async () => {
    calls++;
    throw new Error("deleted message");
  });
  await notify.flush();
  await notify.flush();
  assert.equal(calls, 1);
});
