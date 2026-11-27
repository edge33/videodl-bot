import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadError, runProcess } from "../src/process.ts";

const signal = () => new AbortController().signal;

test("executes argument arrays literally and reports progress lines", async () => {
  const lines: string[] = [];
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(process.argv[1]); process.stdout.write('partial')",
      "$(literal); argument",
    ],
    signal: signal(),
    onLine: (line) => lines.push(line),
  });
  assert.equal(result, "$(literal); argument\npartial");
  assert.deepEqual(lines, ["$(literal); argument"]);
});

test("can discard progress while capturing output", async () => {
  assert.equal(
    await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      signal: signal(),
    }),
    "ok\n",
  );
});

test("captures stdout exactly at the 4 MiB limit", async () => {
  const output = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024))"],
    signal: signal(),
  });
  assert.equal(output, "x".repeat(4 * 1024 * 1024));
});

test("terminates an overflowing tool and rejects instead of returning truncated output", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000)",
      ],
      signal: signal(),
    }),
    (error: unknown) =>
      error instanceof DownloadError &&
      /stdout exceeded the 4 MiB limit/.test(error.message),
  );
});

test("measures the stdout limit in bytes for multibyte text", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('é'.repeat(3 * 1024 * 1024))"],
      signal: signal(),
    }),
    /stdout exceeded the 4 MiB limit/,
  );
});

test("reports missing tools with a safe error", async () => {
  await assert.rejects(
    runProcess({ command: "/nonexistent/videodl", args: [], signal: signal() }),
    /could not start/,
  );
});

test("reports tool failures without exposing stderr", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.error('secret HTTP Error 503'); process.exit(1)"],
      signal: signal(),
    }),
    (e: unknown) => e instanceof DownloadError && !e.message.includes("secret"),
  );
});

test("reports unavailable media safely", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.error('secret unavailable'); process.exit(1)"],
      signal: signal(),
    }),
    (e: unknown) => e instanceof DownloadError,
  );
});

test("aborted signals never start a subprocess", () => {
  assert.throws(
    () =>
      runProcess({
        command: process.execPath,
        args: [],
        signal: AbortSignal.abort(),
      }),
    { name: "AbortError" },
  );
});

test("cancellation kills the process group including a child that ignores SIGTERM", async () => {
  const stop = new AbortController();
  let childPid = 0;
  const running = runProcess({
    command: process.execPath,
    args: [
      "-e",
      `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready:' + process.pid); setInterval(()=>{},1000)"],{stdio:'inherit'}); setInterval(()=>{},1000);`,
    ],
    signal: stop.signal,
    onLine: (line) => {
      // Wait until the descendant has installed its signal handler. Ignore
      // unrelated stdout rather than replacing an already captured PID.
      const ready = /^ready:(\d+)$/.exec(line);
      if (!ready) return;
      childPid = Number(ready[1]);
      stop.abort();
    },
  });
  await assert.rejects(running, { name: "AbortError" });
  assert(childPid > 0);
  // A reaped process is gone; an orphan zombie is also no longer executable.
  const { readFile } = await import("node:fs/promises");
  try {
    assert.match(await readFile(`/proc/${childPid}/stat`, "utf8"), /\) Z /);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
});

test("handles a process group disappearing during cancellation", async (t) => {
  const stop = new AbortController();
  const original = process.kill;
  t.mock.method(process, "kill", (pid: number, sig: NodeJS.Signals) => {
    original(pid, sig);
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      signal: stop.signal,
      onLine: () => stop.abort(),
    }),
    { name: "AbortError" },
  );
});

test("reports unexpected termination errors safely", async (t) => {
  const stop = new AbortController();
  const original = process.kill;
  t.mock.method(process, "kill", (pid: number, sig: NodeJS.Signals) => {
    original(pid, sig);
    throw Object.assign(new Error("secret"), { code: "EPERM" });
  });
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      signal: stop.signal,
      onLine: () => stop.abort(),
    }),
    /Could not terminate/,
  );
});

test("cancellation before a missing tool spawns has no process group to kill", async () => {
  const stop = new AbortController();
  const running = runProcess({
    command: "/nonexistent/videodl",
    args: [],
    signal: stop.signal,
  });
  stop.abort();
  await assert.rejects(running, /could not start/);
});
