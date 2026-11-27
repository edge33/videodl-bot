import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadSession } from "../src/download-session.ts";
import { DownloadError } from "../src/process.ts";

const request = { videoId: "abcDEF_12-3", format: "mp3" } as const;

test("reserves one active slot and releases it after a completed download", async () => {
  const done = Promise.withResolvers<string>();
  const replies: string[] = [];
  let calls = 0;
  const session = new DownloadSession(async () => {
    calls++;
    return done.promise;
  });
  assert.equal(
    session.start(request, async (text) => {
      replies.push(text);
    }),
    true,
  );
  assert.equal(session.busy, true);
  assert.equal(
    session.start(request, async () => {}),
    false,
  );
  done.resolve("file.mp3");
  // Wait for completion without cancelling the operation.
  await new Promise<void>((resolve) => {
    const check = () => (session.busy ? setImmediate(check) : resolve());
    check();
  });
  assert.equal(calls, 1);
  assert.deepEqual(replies, ["Download and converting", "Done: file.mp3"]);
  await session.stop();
  assert.equal(session.cancel(), false);
});

test("reports an unexpected download failure without exposing its raw error", async () => {
  const finished = Promise.withResolvers<void>();
  const replies: string[] = [];
  const session = new DownloadSession(async () => {
    throw new Error("secret");
  });
  session.start(request, async (text) => {
    replies.push(text);
    if (text.startsWith("Download failed")) finished.resolve();
  });
  await finished.promise;
  await session.stop();
  assert.equal(replies.at(-1), "Download failed. Check the server logs.");
});

test("reports safe download errors without retrying", async () => {
  const finished = Promise.withResolvers<void>();
  const replies: string[] = [];
  let attempts = 0;
  const session = new DownloadSession(async () => {
    attempts++;
    throw new DownloadError("Conversion failed.");
  });
  session.start(request, async (text) => {
    replies.push(text);
    if (text.startsWith("Download failed")) finished.resolve();
  });
  await finished.promise;
  await session.stop();
  assert.equal(replies.at(-1), "Download failed: Conversion failed.");
  assert.equal(attempts, 1);
});

test("shutdown aborts and waits for the active download to clean up", async () => {
  const started = Promise.withResolvers<void>();
  let cleaned = false;
  const replies: string[] = [];
  const session = new DownloadSession(async (_request, signal) => {
    started.resolve();
    try {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return "unreachable";
    } finally {
      cleaned = true;
    }
  });
  session.start(request, async (text) => {
    replies.push(text);
  });
  await started.promise;
  await session.stop();
  assert.equal(cleaned, true);
  assert.equal(session.busy, false);
  assert.equal(replies.at(-1), "Download cancelled.");
});

test("cancellation before startup never starts the media tools", async () => {
  let calls = 0;
  const session = new DownloadSession(async () => {
    calls++;
    return "file.mp3";
  });
  session.start(request, async () => {});
  await session.stop();
  assert.equal(calls, 0);
  assert.equal(session.busy, false);
});

test("a failed initial Telegram reply prevents downloading and logs safely", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (text: string) => logs.push(text));
  let calls = 0;
  const failed = Promise.withResolvers<void>();
  const session = new DownloadSession(async () => {
    calls++;
    return "file.mp3";
  });
  session.start(request, async () => {
    failed.resolve();
    throw new Error("secret");
  });
  await failed.promise;
  await session.stop();
  assert.equal(calls, 0);
  assert.deepEqual(logs, ["Could not send download status to Telegram."]);
  assert.equal(session.busy, false);
});

test("throttles progress edits, tolerates edit failure, and sends completion separately", async (t) => {
  t.mock.method(console, "error", () => {});
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const edits: string[] = [];
  const replies: string[] = [];
  const session = new DownloadSession(async (_request, _signal, progress) => {
    assert(progress);
    progress("Downloading 10%.");
    progress("Downloading 20%.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    progress("Downloading 30%.");
    now = 10000;
    progress("Downloading 90%.");
    return "file.mp3";
  });
  session.start(
    request,
    async (text) => {
      replies.push(text);
    },
    async (text) => {
      edits.push(text);
      if (text.includes("90")) throw new Error("secret");
    },
  );
  while (session.busy)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(edits, ["Downloading 10%.", "Downloading 90%."]);
  assert.equal(replies.at(-1), "Done: file.mp3");
});

test("progress is optional for a download session", async () => {
  const session = new DownloadSession(async (_request, _signal, progress) => {
    assert(progress);
    progress("Downloading 50%.");
    return "file.mp3";
  });
  session.start(request, async () => {});
  while (session.busy)
    await new Promise<void>((resolve) => setImmediate(resolve));
});

test("deletes status before sending the outcome even when deletion fails", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (text: string) => logs.push(text));
  const events: string[] = [];
  const session = new DownloadSession(async () => {
    throw new DownloadError("Failed.");
  });
  session.start(
    request,
    async (text) => {
      events.push(text);
    },
    undefined,
    async () => {
      events.push("delete");
      throw new Error("secret");
    },
  );
  while (session.busy)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "Download and converting",
    "delete",
    "Download failed: Failed.",
  ]);
  assert.deepEqual(logs, ["Could not delete download status."]);
});
