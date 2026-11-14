import assert from "node:assert/strict";
import { test } from "node:test";
import {
  setTimeout as delay,
  setImmediate as turn,
} from "node:timers/promises";
import { runService } from "../src/service.ts";

async function untilStopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

test("drains on startup and new events, staying idle between events while status delivery continues", async (t) => {
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  let drains = 0;
  let notifications = 0;
  let wake!: () => void;
  const service = runService({
    shutdown,
    worker: {
      drain: async () => {
        drains++;
      },
    },
    notifications: {
      flush: async () => {
        notifications++;
      },
    },
    poll: async (signal, signalWork) => {
      wake = signalWork;
      await untilStopped(signal);
    },
  });
  await turn();
  assert.equal(drains, 1);
  assert.equal(notifications, 1);
  await delay(10050);
  assert.equal(drains, 1);
  assert.equal(notifications, 2);
  wake();
  await turn();
  assert.equal(drains, 2);
  shutdown.abort();
  await service;
  wake();
  await turn();
  assert.equal(drains, 2);
});

test("remembers a wake arriving after an empty drain but before its promise settles", async () => {
  const shutdown = new AbortController();
  let wake!: () => void;
  let drains = 0;
  const service = runService({
    shutdown,
    worker: {
      drain: async () => {
        drains++;
        if (drains === 1) queueMicrotask(() => wake());
      },
    },
    notifications: { flush: async () => {} },
    poll: async (signal, signalWork) => {
      wake = signalWork;
      await untilStopped(signal);
    },
  });
  await turn();
  assert.equal(drains, 2);
  shutdown.abort();
  await service;
});

test("coalesces repeated events while downloading and waits for active work on shutdown", async () => {
  const shutdown = new AbortController();
  const release = Promise.withResolvers<void>();
  let wake!: () => void;
  let calls = 0;
  let stopped = false;
  const service = runService({
    shutdown,
    worker: {
      drain: async (signal) => {
        calls++;
        await untilStopped(signal);
        await release.promise;
      },
    },
    notifications: { flush: async () => {} },
    poll: async (signal, signalWork) => {
      wake = signalWork;
      await untilStopped(signal);
    },
  }).finally(() => {
    stopped = true;
  });
  await turn();
  wake();
  wake();
  assert.equal(calls, 1);
  shutdown.abort();
  await turn();
  assert.equal(stopped, false);
  release.resolve();
  await service;
  assert.equal(calls, 1);
});

test("worker failures stop polling and propagate", async () => {
  const shutdown = new AbortController();
  let pollingStopped = false;
  await assert.rejects(
    runService({
      shutdown,
      worker: {
        drain: async () => {
          throw new Error("worker failed");
        },
      },
      notifications: { flush: async () => {} },
      poll: async (signal) => {
        await untilStopped(signal);
        pollingStopped = true;
      },
    }),
    /worker failed/,
  );
  assert(pollingStopped);
  assert(shutdown.signal.aborted);
});

test("notification failures abort and await an active downloader", async () => {
  const shutdown = new AbortController();
  const fail = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stopped = false;
  const service = runService({
    shutdown,
    worker: {
      drain: async (signal) => {
        await untilStopped(signal);
        await release.promise;
        stopped = true;
      },
    },
    notifications: { flush: () => fail.promise },
    poll: untilStopped,
  });
  const rejected = assert.rejects(service, /notification failed/);
  await turn();
  fail.reject(new Error("notification failed"));
  await turn();
  assert(shutdown.signal.aborted);
  assert.equal(stopped, false);
  release.resolve();
  await rejected;
  assert(stopped);
});

test("polling failure stops the background tasks and propagates", async () => {
  const shutdown = new AbortController();
  await assert.rejects(
    runService({
      shutdown,
      worker: { drain: async () => {} },
      notifications: { flush: async () => {} },
      poll: async () => {
        throw new Error("poll failed");
      },
    }),
    /poll failed/,
  );
  assert(shutdown.signal.aborted);
});

test("an already stopped service does not start worker or notification work", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  await runService({
    shutdown,
    worker: { drain: async () => assert.fail("unexpected drain") },
    notifications: {
      flush: async () => assert.fail("unexpected notification"),
    },
    poll: untilStopped,
  });
});
